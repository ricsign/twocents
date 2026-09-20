/**
 * The negotiation stream.
 *
 * Server-sent events rather than a websocket: the traffic is one-way, the town
 * screen only ever listens, and SSE survives a proxy that would silently eat a
 * websocket upgrade — which on a conference network is not a hypothetical.
 *
 * Three things this route owns that the engine deliberately does not:
 *
 * - **Pace.** The engine yields as fast as the model answers, which is either
 *   too fast to read or unevenly slow. The delay is applied here, between
 *   events, so the room reads like a conversation rather than a log dump, and so
 *   the speed control can change it without touching the negotiation.
 * - **Persistence.** The run's result is written back to the session store when
 *   it lands, so the plan screen can be opened directly, or reloaded, without
 *   rerunning the negotiation.
 * - **Privacy.** Every frame exits through `eventForViewer`, the same boundary
 *   narrowing `GET /api/session` uses, so `curl -N /api/negotiate` sees one
 *   private report instead of four and one `privateReasonKept` instead of
 *   twenty. The engine still emits everything and the store still keeps
 *   everything — each human reads their own back through the session route.
 *   Reads take `?viewer=`, POSTs carry `viewer` in the body, both default to
 *   the demo user.
 * - **Exclusivity.** One negotiation per session at a time; see the lease
 *   below.
 */

import { runNegotiation } from "@/lib/negotiation/engine";
import { DEFAULT_SESSION_ID, getOrCreateDefault, getSession, updateSession } from "@/lib/session";
import { DEFAULT_VIEWER, eventForViewer } from "@/lib/session-view";
import {
  participantIdSchema,
  type NegotiationEvent,
  type NegotiationTurn,
  type ParticipantId,
} from "@/lib/types";

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
/* One run at a time, per session                                              */
/* -------------------------------------------------------------------------- */

/**
 * Sessions with a negotiation streaming into them right now.
 *
 * Two screens each decide on their own that the room needs arguing out.
 * `/plan` starts a headless run when it is opened cold, and `/town`
 * auto-starts one whenever the session it renders has no plan — so tapping
 * the step-3 pip while the plan screen is still draining opened two. Both
 * write to the same session as they land, independently, and the store could
 * end up holding run B's `plan` beside run A's `fairness` and `reports`: a
 * fairness meter scoring a plan nobody in that transcript agreed to.
 *
 * **The second caller gets 409, not a copy of the first stream.** Teeing would
 * mean one run answering to two paces, two speeds and two aborts, for a
 * benefit neither caller needs: the run already in flight is writing the exact
 * outcome both of them are waiting for, and both clients can read it back out
 * of the session when it lands. So the refusal is the useful answer, and
 * `PlanScreen` and `useNegotiation` both treat it as "somebody else is getting
 * this for us" rather than as an error.
 *
 * **A lease, not a flag.** `releaseRun` runs in a `finally` that covers a clean
 * end, a thrown encoder, an aborted request and a client that hung up. The
 * lease is the answer to whatever escapes that — a killed process, a bug in
 * the release path — because a session that can never negotiate again is a
 * worse failure on stage than two runs racing once. An entry older than the
 * lease is treated as abandoned and taken over.
 *
 * Module state rather than `globalThis`: a dev-server hot reload dropping this
 * map can at worst allow one duplicate run, while a stale entry surviving one
 * would block the session for the length of the lease. Losing it is the safe
 * direction.
 */
const inFlight = new Map<string, { token: symbol; startedAt: number }>();

/** Longer than any run the round cap allows, short enough to recover on stage. */
const RUN_LEASE_MS = 180_000;

/** The lease on this session, or null while somebody else holds a live one. */
function claimRun(sessionId: string): symbol | null {
  const held = inFlight.get(sessionId);
  if (held && Date.now() - held.startedAt < RUN_LEASE_MS) return null;

  const token = Symbol(sessionId);
  inFlight.set(sessionId, { token, startedAt: Date.now() });
  return token;
}

/** Releases our own lease only, so a takeover survives the run it replaced. */
function releaseRun(sessionId: string, token: symbol): void {
  if (inFlight.get(sessionId)?.token === token) inFlight.delete(sessionId);
}

/* -------------------------------------------------------------------------- */
/* The stream                                                                  */
/* -------------------------------------------------------------------------- */

interface RunParams {
  sessionId: string;
  /** Whose stream this is. Every frame is narrowed to this person on the way out. */
  viewer: ParticipantId;
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

  const token = claimRun(session.id);
  if (!token) {
    return Response.json(
      { error: "a negotiation is already running for this session", sessionId: session.id },
      { status: 409, headers: { "Retry-After": "1" } },
    );
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

          // Narrowed on the way out, full on the way to the store. The two
          // lines below this one are the reason that order matters.
          send(JSON.stringify(eventForViewer(event, params.viewer)));

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
      } finally {
        // Before the sentinel, not after: the lease guards the session writes
        // above, and by here the last of them has happened.
        releaseRun(session.id, token);
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

/**
 * Who this stream is for, or `null` if the caller named somebody who isn't here.
 *
 * Absent means the demo user, matching `/api/session`: the town screen only ever
 * watches as Maya and should not have to say so. An unrecognised name is a typo
 * rather than a guest, and the 400 below is better than quietly opening Maya's
 * stream for a caller who asked to be someone else.
 */
function parseViewer(raw: unknown): ParticipantId | null {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_VIEWER;
  const parsed = participantIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function unknownViewer(raw: unknown): Response {
  return Response.json(
    { error: "invalid request", issues: [{ path: "viewer", message: `unknown viewer: ${String(raw)}` }] },
    { status: 400 },
  );
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // An empty POST is the common case from the town screen's Run button.
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const viewer = parseViewer(payload.viewer);
  if (!viewer) return unknownViewer(payload.viewer);

  return streamNegotiation(
    {
      sessionId: typeof payload.sessionId === "string" ? payload.sessionId : DEFAULT_SESSION_ID,
      viewer,
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

  const raw = url.searchParams.get("viewer");
  const viewer = parseViewer(raw ?? undefined);
  if (!viewer) return unknownViewer(raw);

  return streamNegotiation(
    {
      sessionId: url.searchParams.get("sessionId") ?? DEFAULT_SESSION_ID,
      viewer,
      speed: parseSpeed(url.searchParams.get("speed")),
      roundCap: Number.isFinite(roundCap) && roundCap > 0 ? roundCap : undefined,
    },
    request.signal,
  );
}
