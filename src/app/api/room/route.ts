/**
 * Minting a room from a draft the host has looked at.
 *
 * The second half of the photo flow, and deliberately a separate request from
 * the first: `/api/ingest` reads the pictures and `/api/room` writes the
 * session, so nothing the model said becomes a room until a person has seen it
 * and pressed a button.
 *
 * It takes seats rather than images, which is what lets it be the same
 * machinery the judges' round runs on. A seat that arrived from a photograph
 * carries `draft` and no budget; a seat a judge typed carries a budget and no
 * `draft`. `lib/room/seed.ts` does not care which, and that is the point —
 * there is one way to fill four chairs, and it is the one that has been
 * demonstrated on stage.
 *
 * The host is not claimed here. Whoever opens the join link first becomes the
 * host, which is almost always the person who just uploaded the screenshots,
 * and means this route does not have to guess at an identity it has no cookie
 * for.
 *
 * Server-only. No React, no DOM.
 */

import { z } from "zod";
import { PARTICIPANT_IDS } from "@/lib/characters";
import { newRoomCode } from "@/lib/room/identity";
import { seatBriefSchema, seedRoom } from "@/lib/room/seed";
import { usageSchema } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  topic: z.string().trim().min(1).max(60),
  when: z.string().trim().min(1).max(60),
  /**
   * One to four seats.
   *
   * Unlike the judges' round, which wants exactly four, a chat with three
   * people in it is a real answer rather than a dropped field. `seedRoom`
   * fills the rest with open seats.
   */
  seats: z.array(seatBriefSchema).min(1).max(PARTICIPANT_IDS.length),
  /** What reading the chat cost, so the plan screen's figure includes it. */
  usage: usageSchema.optional(),
});

export interface RoomResponse {
  code: string;
  tripName: string;
  /** Relative, so it is correct behind whatever tunnel or host this is on. */
  joinPath: string;
}

export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "body must be JSON" }, { status: 400 });
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

  const { topic, when, seats, usage } = parsed.data;

  // Two seats claiming one chair would silently overwrite each other in the
  // record `seedRoom` builds, and the loser would simply not be on the trip.
  const ids = new Set(seats.map((seat) => seat.participantId));
  if (ids.size !== seats.length) {
    return Response.json(
      { error: "invalid request", issues: [{ path: "seats", message: "two seats share an id" }] },
      { status: 400 },
    );
  }

  const code = newRoomCode();
  const session = seedRoom({ sessionId: code, topic, when, seats, usage });
  if (!session) {
    return Response.json({ error: "could not seed the room" }, { status: 500 });
  }

  const payload: RoomResponse = {
    code,
    tripName: session.tripName,
    joinPath: `/join/${code}`,
  };
  return Response.json(payload);
}
