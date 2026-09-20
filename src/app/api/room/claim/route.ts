/**
 * "Who are you?", answered.
 *
 * The only place in the app besides the judges' round that writes a cookie,
 * because a cookie cannot be set while a Server Component renders — headers
 * are gone by then. That single constraint is why joining is a button that
 * POSTs here and then navigates, rather than a page that quietly signs you in.
 *
 * Claiming a seat attaches a human to a chair that already has a name on it.
 * It does not set `displayName`: the room was seeded with the four names read
 * off the group chat, so `displayNameFor` has been answering with them since
 * before anybody arrived.
 *
 * **The first person to claim becomes the host.** No extra screen and no extra
 * question: whoever uploaded the screenshots is whoever opens the link first,
 * and the host is only ever asked to do two things — start the run and, if it
 * comes to it, clear the room.
 *
 * Server-only. No React, no DOM.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { displayNameFor } from "@/lib/characters";
import {
  currentRoom,
  normalizeRoomCode,
  resolveSession,
  setRoomCookies,
} from "@/lib/room/identity";
import { updateSession } from "@/lib/session";
import { sessionViewFor } from "@/lib/session-view";
import { displayNamesOf, participantIdSchema } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  code: z.string().min(1).max(40),
  participantId: participantIdSchema,
  /**
   * Take a seat somebody is already in.
   *
   * The demo failure this exists for is somebody tapping the wrong name, or
   * coming back on a different phone. Without it, one mis-tap makes a seat
   * unreachable for the rest of the room's life — and the person it belonged
   * to has nowhere to sit. The room code is the credential here; anyone who
   * has it can already claim any free chair, so this takes nothing away.
   */
  force: z.boolean().optional(),
});

export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "body must be JSON" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }

  const { participantId, force } = parsed.data;

  const code = normalizeRoomCode(parsed.data.code);
  if (!code) return Response.json({ error: "that is not a room code" }, { status: 400 });

  // Read before the session, so the check-then-set below has nothing to await.
  const held = await currentRoom();

  const session = resolveSession(code);
  if (!session) {
    return Response.json({ error: "that room is gone", code }, { status: 404 });
  }

  const seat = session.participants[participantId];
  if (!seat) {
    return Response.json({ error: "no such seat in this room" }, { status: 404 });
  }

  // Everything from here to the write happens without an await. One process,
  // one thread, no interleaving point — which is the whole reason a
  // check-then-set is safe here and why nothing may be awaited in this window.
  //
  // "Already mine" means this browser holds *this* room's cookie for *this*
  // seat. Both halves matter: checking the seat alone would let somebody who
  // is Ana in one room walk into another room's Ana without being told it was
  // taken, because the cookie says `maya` in both.
  const mine = held.joined && held.sessionId === session.id && held.seat === participantId;
  const taken = seat.claimedAt !== null;

  if (taken && !force && !mine) {
    return Response.json(
      {
        error: "seat taken",
        name: displayNameFor(displayNamesOf(session), participantId),
      },
      { status: 409 },
    );
  }

  const updated = updateSession(session.id, {
    participants: {
      ...session.participants,
      // Re-claiming keeps the original timestamp: a refresh is not a new
      // arrival, and the lobby reads this as "when did somebody sit down".
      [participantId]: { ...seat, claimedAt: seat.claimedAt ?? Date.now() },
    },
    hostSeat: session.hostSeat ?? participantId,
  });

  if (!updated) {
    return Response.json({ error: "could not join that room" }, { status: 500 });
  }

  const response = NextResponse.json({
    sessionId: updated.id,
    seat: participantId,
    // Already narrowed to this person, so the lobby paints its first frame
    // without a second round trip.
    view: sessionViewFor(updated, participantId),
  });
  setRoomCookies(response, request, updated.id, participantId);
  return response;
}
