/**
 * The judges' round, in one POST.
 *
 * At 2:20 of a three-minute demo a judge gets to brief four agents for their
 * own dinner. Everything about this route is shaped by that clock: one request
 * carries the whole room, it is validated in one pass, and it lands as a
 * session the town screen can already run. There is no second call to make and
 * nothing to confirm.
 *
 * Two decisions worth naming:
 *
 * - **It makes a room, like every other way in.** It used to overwrite the
 *   demo session, back when that was the only session there was and a join
 *   link would have been four minutes this round does not have. Now that a
 *   room is one POST and a code, typing four people is simply the other way to
 *   describe them — the photo reads them, this types them, and both land on
 *   the same join screen so the other three can open the link on their own
 *   phones. Overwriting the demo session would also quietly destroy whatever a
 *   previous judge was in the middle of.
 * - **The mini-brief is deliberately three fields.** A name, a one-line want,
 *   and the number nobody says out loud. That last field is the product; the
 *   rest is context. Anything more is typing a judge does instead of watching
 *   agents argue.
 *
 * The machinery that turns those three fields into four briefed agents lives
 * in `lib/room/seed.ts`, because the group-chat photo path fills the same four
 * seats from a different direction and the two must not drift apart. This
 * route differs from `POST /api/room` in exactly one way: it insists on all
 * four seats, because its form collects four and a short count would mean a
 * dropped field rather than a smaller party.
 *
 * Server-only. No React, no DOM.
 */

import { z } from "zod";
import { PARTICIPANT_IDS, type ParticipantId } from "@/lib/characters";
import { newRoomCode } from "@/lib/room/identity";
import { seatBriefSchema, seedRoom, type SeatBrief } from "@/lib/room/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Request                                                                     */
/* -------------------------------------------------------------------------- */

const requestSchema = z.object({
  /** Printed on the top bar and argued over. "Dinner tonight". */
  topic: z.string().trim().min(1).max(60),
  /** Free text, the way the briefing chat takes it. "Tonight, 7pm". */
  when: z.string().trim().min(1).max(60),
  /**
   * All four seats, in any order; the handler indexes them by id.
   *
   * Exactly four here, unlike a photo-seeded room, which may fill fewer and
   * leave the rest open. The judges' form collects four and a short count
   * would mean a dropped field rather than a smaller party.
   */
  people: z.array(seatBriefSchema).length(PARTICIPANT_IDS.length),
});

/* -------------------------------------------------------------------------- */
/* Handler                                                                     */
/* -------------------------------------------------------------------------- */

export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json(
      { error: "invalid request", issues: [{ path: "", message: "body must be JSON" }] },
      { status: 400 },
    );
  }

  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      {
        error: "invalid request",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  const { topic, when, people } = parsed.data;

  const byId = new Map<ParticipantId, SeatBrief>(
    people.map((person) => [person.participantId, person]),
  );
  const missing = PARTICIPANT_IDS.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return Response.json(
      {
        error: "invalid request",
        issues: [{ path: "people", message: `missing a brief for ${missing.join(", ")}` }],
      },
      { status: 400 },
    );
  }

  const code = newRoomCode();
  const session = seedRoom({ sessionId: code, topic, when, seats: people });
  if (!session) {
    return Response.json({ error: "could not seed the room" }, { status: 500 });
  }

  // No cookie is set here, and that is the point: whoever typed this is not
  // yet anybody in it. They pick their own seat on the join screen, the same
  // way the three people they just described will.
  return Response.json({
    code,
    sessionId: session.id,
    tripName: session.tripName,
    joinPath: `/join/${code}`,
  });
}
