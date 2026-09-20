/**
 * The chat's view of a briefing transcript.
 *
 * The session stores a briefing as `BriefMessage[]` — role, text, and the
 * "Kept private: …" badge — because that is what the negotiation and the
 * extractor read. The chat needs one more thing per line: a stable key for
 * React. Adding it is the whole job of this module.
 *
 * It lives in a module of its own, with no `"use client"` directive, because
 * both sides of the boundary need it: `/brief` renders the saved conversation
 * on the server so the first frame is the real one, and `BriefScreen` rebuilds
 * it in the browser when somebody starts over. A helper that lived in either
 * of those files could only be called from that side.
 *
 * It must not import from `lib/seed`, or reaching for the opening line from a
 * client component would pull the whole seeded grad trip into the bundle.
 */

import type { BriefMessage } from "@/lib/types";

/** A transcript line plus what the UI hangs off it. */
export interface ChatMessage extends BriefMessage {
  id: string;
}

/**
 * The agent's first line, and the only thing on screen before anybody types.
 *
 * A question rather than a greeting: the screen is one conversation whose job
 * is to get three things out of a person — where, when, and the number — and
 * an agent that opens with "hello" spends the first turn on nothing. Stored
 * rather than generated so the screen paints instantly and says the same thing
 * with or without an API key.
 */
export const BRIEF_OPENING_LINE =
  "Before I go plan this with the others: where do you want to go, when, and what’s the real number?";

/**
 * A stored transcript as the chat renders it, or the opening question when
 * there is no conversation to come back to.
 */
export function chatMessagesFrom(
  transcript: readonly BriefMessage[],
): ChatMessage[] {
  if (transcript.length === 0) {
    return [{ id: "opening", role: "agent", text: BRIEF_OPENING_LINE }];
  }
  return transcript.map((message, index) => ({
    ...message,
    id: `stored-${index}`,
  }));
}
