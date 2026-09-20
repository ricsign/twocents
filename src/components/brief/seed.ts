/**
 * The chat's view of a briefing transcript.
 *
 * The session stores a briefing as `BriefMessage[]` — role and text, nothing
 * else — because that is what the negotiation and the extractor read. The chat
 * needs two more things per line: a stable key for React, and the "Kept
 * private: …" badge under an agent reply. Those live here, and the conversion
 * runs once on the server so the first frame is the saved conversation rather
 * than an empty box that fills in after hydration.
 *
 * What used to be in this file — a hardcoded opening conversation for Maya —
 * now lives in `src/lib/seed.ts` behind `TWOCENTS_SEED_BRIEF_CHAT`, so the
 * screen's default is a person talking to their own agent from scratch.
 */

import { BRIEF_OPENING_LINE } from "@/lib/seed";
import type { BriefMessage } from "@/lib/types";

/** A transcript line plus what the UI hangs off it. */
export interface ChatMessage extends BriefMessage {
  id: string;
  /** Renders the "Kept private: …" line under an agent message. */
  keptPrivate?: string;
}

/**
 * A saved transcript, ready to render — or the agent's opening question when
 * there is nothing saved yet.
 *
 * The opener is part of the conversation rather than a placeholder above it:
 * the next turn posts the whole array back, so it is what the agent is
 * answering and it ends up in the saved transcript like any other line.
 */
export function chatMessagesFrom(transcript: readonly BriefMessage[]): ChatMessage[] {
  if (transcript.length === 0) {
    return [{ id: "opening", role: "agent", text: BRIEF_OPENING_LINE }];
  }
  return transcript.map((message, index) => ({
    id: `saved-${index}`,
    role: message.role,
    text: message.text,
  }));
}
