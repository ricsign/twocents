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
 */

import { runNegotiation } from "@/lib/negotiation/engine";
import { PARTICIPANT_IDS } from "@/lib/characters";
import { resolveSession, roomFromRequest } from "@/lib/room/identity";
import { getSession, updateSession } from "@/lib/session";
import { DEFAULT_VIEWER, eventForViewer } from "@/lib/session-view";
import {
  participantIdSchema,
  type NegotiationEvent,
  type NegotiationTurn,
  type DemoSession,
  type ParticipantId,
  type ParticipantState,
} from "@/lib/types";

/**
 * An empty seat approves itself. A seat with a human in it has to tap.
 *
 * `/api/itinerary` checks the session for four approvals, so whoever is not
 * really there has to be answered for by somebody. Two conditions decide it:
 * a seat is approved here when it is **not the viewer** and **nobody has
 * claimed it**.
 *
 * That one rule covers both shapes the app now has:
 *
 * - **One person at one laptop.** Nobody has claimed anything, so the other
 *   three are played by the app and their approval is the app's to give —
 *   which the plan screen already assumed, drawing their avatars ticked the
 *   moment you approve. Yours is excluded and stays the only real one in the
 *   room, exactly as before.
 * - **Four people on four phones.** All four seats are claimed, so nothing is
 *   auto-approved and the gate waits for four real taps. A seat nobody took —
 *   three friends and an empty chair — still approves itself, because there is
 *   no one there to tap for it.
 *
 * The viewer, rather than `YOU`: whose stream this is, is whose approval is
 * being withheld, and in a room that is a different person on every device.
 */
function withUnattendedApprovals(
  session: DemoSession,
  viewer: ParticipantId,
): Record<ParticipantId, ParticipantState> {
  const participants = { ...session.participants };
  for (const id of PARTICIPANT_IDS) {
    const existing = participants[id];
    if (!existing || id === viewer || existing.claimedAt !== null) continue;
    participants[id] = { ...existing, approved: true };
  }
  return participants;
}

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
  /** Whose stream this is. Every frame is narrowed to this person on the way out. */
  viewer: ParticipantId;
  speed: number;
  roundCap?: number;
}

function streamNegotiation(params: RunParams, signal: AbortSignal): Response {
  const session = resolveSession(params.sessionId);

  if (!session) {
    return Response.json({ error: "unknown session", sessionId: params.sessionId }, { status: 404 });
  }

  // The room has begun. This is the whole coordination primitive for four
  // phones: the host opens the stream, this lands in the session, and the
  // other three see it on their next poll of `/api/session` and follow to the
  // town. No websocket, no broadcast, nothing to keep in sync — one timestamp
  // that only ever goes from null to a number.
  if (session.runStartedAt === null) {
    updateSession(session.id, { runStartedAt: Date.now() });
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
              // Carried so a transcript read back from the session still shows
              // the search behind a line, and the links it opened.
              ...(event.sourced ? { sourced: event.sourced } : {}),
            });
          }
          if (event.type === "agreed") {
            updateSession(session.id, {
              turns: [...turns],
              plan: event.plan,
              // Read fresh, not from the snapshot this request opened with: if
              // you approved while the room was still talking, that tap must
              // not be written back to false underneath you.
              participants: withUnattendedApprovals(getSession(session.id) ?? session, params.viewer),
            });
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
  if (payload.viewer !== undefined && !parseViewer(payload.viewer)) {
    return unknownViewer(payload.viewer);
  }

  const { sessionId, seat } = await roomFromRequest(request, {
    sessionId: typeof payload.sessionId === "string" ? payload.sessionId : undefined,
    viewer: typeof payload.viewer === "string" ? payload.viewer : undefined,
  });

  return streamNegotiation(
    {
      sessionId,
      viewer: seat,
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
  if (raw !== null && !parseViewer(raw)) return unknownViewer(raw);

  const { sessionId, seat } = await roomFromRequest(request);

  return streamNegotiation(
    {
      sessionId,
      viewer: seat,
      speed: parseSpeed(url.searchParams.get("speed")),
      roundCap: Number.isFinite(roundCap) && roundCap > 0 ? roundCap : undefined,
    },
    request.signal,
  );
}
