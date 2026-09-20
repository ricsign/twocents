/**
 * The push-to-talk release: a recorded clip becomes a line in the room.
 *
 * Three steps, in order, none optional:
 *
 * 1. Deepgram turns the clip into text.
 * 2. `checkForLeaks` scans it against the speaker's own secrets — the same
 *    guard `runNegotiation` puts every generated line through before it can
 *    become a `speak` event. A live human can say their own number out loud
 *    as easily as a model can be talked into it, and the product's guarantee
 *    doesn't get an exception for "but a person said it."
 * 3. The (possibly redacted) line is queued for the engine and the room
 *    unpauses.
 *
 * What this route returns is what the room actually hears — if Maya's
 * ceiling got scrubbed, she sees the redacted version back, not her own
 * words, for the same reason `/api/negotiate` narrows every frame through
 * `eventForViewer` before it leaves the process.
 *
 * Raw audio bytes in the body, not JSON or multipart, so a browser
 * `MediaRecorder` blob posts directly with no client-side encoding.
 */

import { DEFAULT_SESSION_ID, getOrCreateDefault, getSession } from "@/lib/session";
import { queueInterjection, resumeRoom } from "@/lib/negotiation/interjection-control";
import { transcribeInterjection } from "@/lib/llm/deepgram";
import { checkForLeaks } from "@/lib/negotiation/redaction";
import { participantIdSchema, secretsFromBrief } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    console.log("spfudsfsfsdffs")
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId") ?? DEFAULT_SESSION_ID;

  const parsedParticipant = participantIdSchema.safeParse(url.searchParams.get("participantId"));
  if (!parsedParticipant.success) {
    resumeRoom(sessionId); // a rejected request must not leave the room stuck paused
    return Response.json(
      {
        error: "invalid request",
        issues: [{ path: "participantId", message: "unknown participant" }],
      },
      { status: 400 },
    );
  }
  const participantId = parsedParticipant.data;

  const session = sessionId === DEFAULT_SESSION_ID ? getOrCreateDefault() : getSession(sessionId);
  if (!session) {
    resumeRoom(sessionId);
    return Response.json({ error: "unknown session" }, { status: 404 });
  }

  const state = session.participants[participantId];
  if (!state) {
    resumeRoom(sessionId);
    return Response.json({ error: "unknown participant" }, { status: 404 });
  }

  const audio = Buffer.from(await request.arrayBuffer());
  if (audio.length === 0) {
    // A press-and-release with nothing recorded. Still has to unpause.
    resumeRoom(sessionId);
    return Response.json({ text: "" });
  }

  const transcript = await transcribeInterjection(audio);
  if (!transcript.trim()) {
    resumeRoom(sessionId);
    return Response.json({ text: "" });
  }

  console.log("[interject] audio bytes:", audio.length);
  console.log("testingsfsdfsfsf")
  const secrets = secretsFromBrief(state.brief);
  console.log("[interject] transcript:", JSON.stringify(transcript));
  const { redacted } = checkForLeaks(transcript, secrets);

  // Queues the line for the engine's next loop checkpoint and unpauses the
  // room in one step — see `queueInterjection`.
  queueInterjection(sessionId, participantId, redacted);

  return Response.json({ text: redacted });
}