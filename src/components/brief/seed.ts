/**
 * The briefing as `design/01-brief.clean.html` shows it: Maya has already told
 * her agent the number, and the agent has already promised to sit on it. The
 * demo opens mid-conversation so the kept-secret beat is on screen from the
 * first frame rather than three typed sentences away.
 *
 * TODO(session): move to `src/lib/seed.ts` / `src/lib/session.ts` once those
 * land — another agent is writing them in parallel. Shape is unchanged.
 */

import type { ParticipantId } from "@/lib/characters";
import type { Brief, BriefMessage } from "@/lib/types";

/** A transcript line plus what the UI hangs off it. */
export interface ChatMessage extends BriefMessage {
  id: string;
  /** Renders the "Kept private: …" line under an agent message. */
  keptPrivate?: string;
}

export const SEED_PARTICIPANT: ParticipantId = "maya";

export const SEED_MESSAGES: ChatMessage[] = [
  {
    id: "m0",
    role: "agent",
    text: "Before I go argue with the others: where do you want to go, when, and what’s the real number?",
  },
  {
    id: "m1",
    role: "human",
    text: "Somewhere warm, March 14–19. I can do $600 max. Please don’t tell them that.",
  },
  {
    id: "m2",
    role: "agent",
    text: "Locked. They’ll hear “Cancun is a stretch,” never “$600.” I’ll trade away the nicer hotel before I let the number slip.",
    keptPrivate: "$600 budget",
  },
  {
    id: "m3",
    role: "human",
    text: "Also, no flights before 8am.",
  },
];

export const SEED_BRIEF: Brief = {
  participantId: SEED_PARTICIPANT,
  destinationWant: "Somewhere warm, with a beach",
  dates: "Mar 14–19",
  nights: 5,
  budgetCeiling: 600,
  budgetIsPrivate: true,
  dealbreakers: ["No flights before 8am"],
  wants: ["A beach every day", "Late flights", "No passport hassle"],
  notes: ["private: money is tight until the job starts"],
  rawTranscript: SEED_MESSAGES.map(({ role, text }) => ({ role, text })),
};

/** Everyone but Maya briefed their agent before the demo started. */
export const SEED_BRIEFED: ParticipantId[] = ["jordan", "sam", "priya"];
