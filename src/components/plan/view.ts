/**
 * What the plan screen is allowed to know.
 *
 * The session carries all four briefs, all four ceilings and all four private
 * reports. Handing that object to the browser would put Sam's credit card and
 * Jordan's number in the page source of a screen whose entire promise is that
 * nobody hears anyone else's. So the server narrows it here first: the agreed
 * plan, the fairness rows (which are already public claims), your own report,
 * and who has approved. Nothing else crosses.
 *
 * Shared by the server page and the client screen, so the two can never
 * disagree about what "your" view of the plan is. No React, no I/O.
 */

import { PARTICIPANT_IDS, type ParticipantId } from "@/lib/characters";
import type {
  AgentReport,
  DemoSession,
  FairnessReport,
  Plan,
} from "@/lib/types";

export interface PlanView {
  sessionId: string;
  plan: Plan;
  fairness: FairnessReport;
  /** Yours alone. The other three never reach this browser. */
  report: AgentReport | null;
  approvals: Record<ParticipantId, boolean>;
}

/**
 * Narrows a session to one person's view, or null when the agents have not
 * finished and there is nothing to show yet.
 *
 * Only your approval is read from the session. The other three are not sitting
 * at this laptop: with four devices their taps would arrive from theirs, and in
 * the demo the plan landing is that signal.
 */
export function planViewFor(
  session: DemoSession,
  you: ParticipantId,
): PlanView | null {
  const { plan, fairness, reports } = session;
  if (!plan || !fairness || !reports) return null;

  const approvals = {} as Record<ParticipantId, boolean>;
  for (const id of PARTICIPANT_IDS) {
    approvals[id] = id === you ? (session.participants[id]?.approved ?? false) : true;
  }

  return {
    sessionId: session.id,
    plan,
    fairness,
    report: reports[you] ?? null,
    approvals,
  };
}
