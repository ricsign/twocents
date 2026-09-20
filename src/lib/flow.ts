/**
 * The one question the four-step flow turns on: has this person said anything
 * to their agent yet?
 *
 * Since the briefing became real state, the seeded seat in front of the screen
 * starts genuinely empty, and three screens each need the same answer for a
 * different reason. `/brief` uses it to decide who is already on the roster and
 * whether NEXT is live. `/personality` and `/town` use it as an entry guard:
 * both are reachable by typing the URL, and with nothing briefed they are dead
 * ends — sliders shaping an agent that has been told nothing, and a room where
 * one of the four arrived with no position to argue. A redirect back to `/brief`
 * is the only honest thing either screen can do.
 *
 * One predicate rather than three copies of the same `||`, because the three
 * screens disagreeing about what "briefed" means is how a judge ends up on a
 * page that should not have let them in.
 *
 * Pure. No React, no I/O, safe on both sides of the wire.
 */

import type { Brief } from "@/lib/types";

/**
 * True once there is something for an agent to argue from.
 *
 * Two fields rather than one, because the brief is filled from two directions:
 * the chat writes `rawTranscript` on the first thing anybody types, and the
 * derived structure catches a brief applied wholesale — the sample brief, or a
 * judges' round that fills four seats at once without a conversation.
 */
export function hasBriefed(brief: Brief): boolean {
  return brief.rawTranscript.length > 0 || brief.destinationWant.trim().length > 0;
}
