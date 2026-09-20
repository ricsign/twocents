/**
 * The judges' round, in one POST.
 *
 * At 2:20 of a three-minute demo a judge gets to brief four agents for their
 * own dinner. Everything about this route is shaped by that clock: one request
 * carries the whole room, it is validated in one pass, and it lands as a
 * session the town screen can already run. There is no second call to make and
 * nothing to confirm.
 *
 * Three decisions worth naming:
 *
 * - **It replaces the demo session rather than making a new one.** A judges'
 *   run stored under a fresh id would want a join link and a lobby, which is
 *   four minutes this round does not have. Seeding the default session means
 *   the judge gets the whole product — town, plan, private report, fairness —
 *   off one button, and the next RESET puts the scripted grad trip back.
 * - **It forgets any room this browser was in.** The round seeds the *default*
 *   session and then sends the browser to the town, so a phone still carrying
 *   a room cookie would arrive there, read it, and watch a different session
 *   entirely. That bug only appears when somebody demonstrates both features
 *   in one sitting — which is precisely when it would be seen.
 * - **The mini-brief is deliberately three fields.** A name, a one-line want,
 *   and the number nobody says out loud. That last field is the product; the
 *   rest is context. Anything more is typing a judge does instead of watching
 *   agents argue.
 *
 * The machinery that turns those three fields into four briefed agents lives
 * in `lib/room/seed.ts`, because the group-chat photo path fills the same four
 * seats from a different direction and the two must not drift apart.
 *
 * Server-only. No React, no DOM.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { PARTICIPANT_IDS, YOU, type ParticipantId } from "@/lib/characters";
import { clearRoomCookies } from "@/lib/room/identity";
import { seatBriefSchema, seedRoom, type SeatBrief } from "@/lib/room/seed";
import { DEFAULT_SESSION_ID } from "@/lib/session";
import { sessionViewFor } from "@/lib/session-view";

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

  const session = seedRoom({ sessionId: DEFAULT_SESSION_ID, topic, when, seats: people });

  if (!session) {
    return Response.json({ error: "could not seed the session" }, { status: 500 });
  }

  // The id is what the client needs; the view rides along so a caller poking at
  // this route with curl can see what it built, already narrowed to one person.
  const response = NextResponse.json({
    sessionId: session.id,
    tripName: session.tripName,
    view: sessionViewFor(session, YOU),
  });
  clearRoomCookies(response);
  return response;
}
