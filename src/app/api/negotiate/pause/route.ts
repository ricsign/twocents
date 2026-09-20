/**
 * Push-to-talk press and release, decoupled from the interjection's content.
 *
 * Pressing pauses the round loop immediately, before Deepgram has returned
 * anything, so the room actually stops rather than continuing to talk while
 * the clip is still being recorded. A release with nothing worth sending — a
 * false start, a changed mind — still has to resume the room, which is why
 * this route accepts `paused: false` as its own action rather than relying on
 * `/interject` to be the only thing that ever unpauses it.
 */

import { DEFAULT_SESSION_ID } from "@/lib/session";
import { pauseRoom, resumeRoom } from "@/lib/negotiation/interjection-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // A bare press with no body is the common case from the hold button.
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : DEFAULT_SESSION_ID;
  // Default true: this route exists to be called on press. An explicit
  // `paused: false` is the release-with-nothing-to-say case.
  const paused = payload.paused !== false;

  if (paused) pauseRoom(sessionId);
  else resumeRoom(sessionId);

  return Response.json({ sessionId, paused });
}