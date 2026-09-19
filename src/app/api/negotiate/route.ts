/**
 * The negotiation stream.
 *
 * Server-sent events rather than a websocket: the traffic is one-way, the town
 * screen only ever listens, and SSE survives a proxy that would silently eat a
 * websocket upgrade — which on a conference network is not a hypothetical.
 *
 * Two things this route owns that the engine deliberately does not:
 *
 * - **Pace.** The engine yields as fast as the model answers, which is either
 *   too fast to read or unevenly slow. The delay is applied here, between
 *   events, so the room reads like a conversation rather than a log dump, and so
 *   the speed control can change it without touching the negotiation.
 * - **Persistence.** The run's result is written back to the session store when
 *   it lands, so the plan screen can be opened directly, or reloaded, without
 *   rerunning the negotiation.
 */

import { runNegotiation } from "@/lib/negotiation/engine";
import { DEFAULT_SESSION_ID, getOrCreateDefault, getSession, updateSession } from "@/lib/session";
import type { NegotiationEvent, NegotiationTurn } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Pacing                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The base beat, in milliseconds, at 1x.
 *
 * A spoken line is the unit the eye tracks, so it carries the full beat; the
 * frames around it (a thinking indicator, a round marker, an offer card sliding
 * in) are punctuation and get a fraction of one. A full five-round run is twenty
 * spoken beats, which at 1x is a little over half a minute of screen time — the
 * demo script's forty seconds — and the speed control divides straight into it,
 * so 4x turns that into a fast-forward a judge can sit through.
 *
 * Overridable by env because the right pace depends on the room and the
 * projector, and that is not a thing to redeploy for.
 */
function baseBeatMs(): number {
  const raw = Number(process.env.TWOCENTS_BEAT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 1100;
}

/** Fraction of a beat each frame is worth. */
const BEAT_WEIGHT: Record<NegotiationEvent["type"], number> = {
  round: 0.45,
  thinking: 0.4,
  speak: 1,
  offer: 0.35,
  agreed: 0.5,
  done: 0,
};

function delayFor(event: NegotiationEvent, speed: number): number {
  return Math.round((baseBeatMs() * BEAT_WEIGHT[event.type]) / speed);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/** 1x to 8x. A speed outside that is a typo, not an intention. */
function parseSpeed(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(8, Math.max(0.25, value));
}

/* -------------------------------------------------------------------------- */
/* The stream                                                                  */
/* -------------------------------------------------------------------------- */

interface RunParams {
  sessionId: string;
  speed: number;
  roundCap?: number;
}

function streamNegotiation(params: RunParams, signal: AbortSignal): Response {
  const session = params.sessionId === DEFAULT_SESSION_ID
    ? getOrCreateDefault()
    : getSession(params.sessionId);

  if (!session) {
    return Response.json({ error: "unknown session", sessionId: params.sessionId }, { status: 404 });
  }

  const encoder = new TextEncoder();
  const turns: NegotiationTurn[] = [];

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: string): void => {
        try {
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        } catch {
          // The client hung up mid-write. The abort handler below stops the run.
        }
      };

      try {
        for await (const event of runNegotiation({
          session,
          roundCap: params.roundCap,
          signal,
        })) {
          if (signal.aborted) break;

          send(JSON.stringify(event));

          // Rebuilt here rather than read out of the engine: the route is what
          // owns the session write, and an event stream is the only thing the
          // engine promises.
          if (event.type === "speak") {
            turns.push({
              id: `turn-${event.speaker}-${turns.length}`,
              round: turns.length,
              speaker: event.speaker,
              kind: event.kind,
              text: event.text,
              ...(event.privateReasonKept ? { privateReasonKept: event.privateReasonKept } : {}),
            });
          }
          if (event.type === "agreed") {
            updateSession(session.id, { turns: [...turns], plan: event.plan });
          }
          if (event.type === "done") {
            updateSession(session.id, {
              turns: [...turns],
              fairness: event.fairness,
              reports: event.reports,
              usage: event.usage,
            });
          }

          await sleep(delayFor(event, params.speed), signal);
        }
      } catch (error) {
        // The engine does not throw, so this is the encoder or a closed stream.
        // Either way the run is over and the sentinel still goes out.
        console.warn("[negotiate] stream ended early:", error);
      }

      send("[DONE]");
      try {
        controller.close();
      } catch {
        // Already closed by the client disconnecting.
      }
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // no-transform matters as much as no-cache: a compressing proxy will hold
      // the whole stream to buffer it, and the town screen goes blank for a
      // minute before every bubble appears at once.
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                    */
/* -------------------------------------------------------------------------- */

export async function POST(request: Request): Promise<Response> {
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // An empty POST is the common case from the town screen's Run button.
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  return streamNegotiation(
    {
      sessionId: typeof payload.sessionId === "string" ? payload.sessionId : DEFAULT_SESSION_ID,
      speed: parseSpeed(payload.speed),
      roundCap: typeof payload.roundCap === "number" ? payload.roundCap : undefined,
    },
    request.signal,
  );
}

/** Same stream over GET, so `curl -N` and `new EventSource(...)` both work. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const roundCap = Number(url.searchParams.get("roundCap"));

  return streamNegotiation(
    {
      sessionId: url.searchParams.get("sessionId") ?? DEFAULT_SESSION_ID,
      speed: parseSpeed(url.searchParams.get("speed")),
      roundCap: Number.isFinite(roundCap) && roundCap > 0 ? roundCap : undefined,
    },
    request.signal,
  );
}
