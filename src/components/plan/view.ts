/**
 * What the plan screen is allowed to know.
 *
 * The narrowing itself lives in `lib/session-view.ts` and is done once, for the
 * whole app, at the HTTP boundary. This file is the plan screen's *shape* of
 * that view: the agreed plan, the fairness rows, your own report and who has
 * approved, flattened into the four props the screen renders. It makes no
 * privacy decision of its own — `planViewFor` delegates to `sessionViewFor`, and
 * `planViewFrom` reshapes a view that has already crossed the wire. Two ideas of
 * "your view of the session" is one too many.
 *
 * Shared by the server page and the client screen, so the two can never
 * disagree. No React, no I/O.
 */

import { PARTICIPANT_IDS, type DisplayNames, type ParticipantId } from "@/lib/characters";
import {
  displayNamesFromView,
  sessionViewFor,
  type SessionView,
} from "@/lib/session-view";
import type {
  AgentReport,
  DemoSession,
  FairnessReport,
  Plan,
  Usage,
} from "@/lib/types";

export interface PlanView {
  sessionId: string;
  plan: Plan;
  fairness: FairnessReport;
  /** Yours alone. The other three never reach this browser. */
  report: AgentReport | null;
  approvals: Record<ParticipantId, boolean>;
  /**
   * What the four people are called, carried on the view so the meter and the
   * roster never have to look a name up for themselves.
   */
  names: DisplayNames;
  /** Whose screen this is. The one seat whose APPROVE button is yours to press. */
  you: ParticipantId;
  /** Token and cost accounting for the run that produced this plan. */
  usage: Usage;
}

/**
 * Reshapes an already-narrowed session view, or null when the agents have not
 * finished and there is nothing to show yet.
 *
 * Every approval is read from the view now, including the other three. It used
 * to hardcode them to `true` with a note that "with four devices their taps
 * would arrive from theirs" — and they do: an unclaimed seat is approved by the
 * negotiation route when the plan lands, and a claimed one waits for its human.
 * Either way the answer is in `others[].approved`, which the session view has
 * carried all along as a public act.
 */
export function planViewFrom(view: SessionView): PlanView | null {
  const { plan, fairness, report, usage } = view;
  if (!plan || !fairness) return null;

  const approvals = {} as Record<ParticipantId, boolean>;
  for (const id of PARTICIPANT_IDS) approvals[id] = false;
  approvals[view.viewerId] = view.you.approved;
  for (const other of view.others) approvals[other.participantId] = other.approved;

  return {
    sessionId: view.sessionId,
    plan,
    fairness,
    report,
    approvals,
    you: view.viewerId,
    names: displayNamesFromView(view),
    usage,
  };
}

/**
 * Narrows a session to one person's plan view, server side.
 *
 * Goes through `sessionViewFor` rather than reaching into the session itself, so
 * there is exactly one definition of what a person may see and the plan screen
 * cannot quietly grow a wider one.
 */
export function planViewFor(
  session: DemoSession,
  you: ParticipantId,
): PlanView | null {
  return planViewFrom(sessionViewFor(session, you));
}
