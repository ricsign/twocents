/**
 * The two writes that invalidate a finished run.
 *
 * Editing a brief or a personality changes what an agent knows or how it
 * argues, and a plan computed before that edit is a lie about the room: the
 * fairness meter scores wants nobody holds any more, and a private report
 * explains a trade made for a reason that has since changed. So both writes
 * clear the whole outcome: turns, plan, fairness, reports and every approval.
 * The plan screen renders whatever the session is holding, so leaving one
 * there means an edited brief can walk straight to a plan that predates it.
 * Clearing it leaves nothing to show until the town has argued again, which is
 * the honest state.
 *
 * They live here rather than in the session route because `/api/brief` has to
 * make exactly the same write when it persists a turn of the briefing chat,
 * and two copies of an invalidation rule is one copy too many.
 *
 * Server-only. No React, no DOM.
 */

import { PARTICIPANT_IDS } from "@/lib/characters";
import { updateSession } from "@/lib/session";
import type {
  Brief,
  DemoSession,
  ParticipantId,
  ParticipantState,
  Personality,
} from "@/lib/types";

/**
 * Replaces one participant's state and throws away anything the old state
 * produced. Returns undefined when the session has no such participant, which
 * the callers turn into a 404.
 */
function editParticipant(
  session: DemoSession,
  participantId: ParticipantId,
  patch: Partial<ParticipantState>,
): DemoSession | undefined {
  const existing = session.participants[participantId];
  if (!existing) return undefined;

  const participants = { ...session.participants };
  participants[participantId] = { ...existing, ...patch };

  // Nobody has approved the plan that is about to stop existing. Clearing the
  // other three as well is deliberate: they approved an outcome derived from
  // this brief, so their tap no longer means what it meant.
  for (const id of PARTICIPANT_IDS) {
    const state = participants[id];
    if (state?.approved) participants[id] = { ...state, approved: false };
  }

  return updateSession(session.id, {
    participants,
    turns: [],
    plan: null,
    fairness: null,
    reports: null,
    // A human has now put something of their own into this room, so the
    // offline provider may no longer read the hand-written script over it.
    scripted: false,
  });
}

/**
 * Stores what somebody told their agent, and drops the run it predates.
 *
 * `also` is for the fields that stop being true the moment a person speaks for
 * themselves — today that is `draft`, the marker saying a seat was read off a
 * group chat rather than briefed by its owner. It rides along here rather than
 * in a second write so a turn of the briefing chat stays one atomic edit.
 */
export function applyBrief(
  session: DemoSession,
  participantId: ParticipantId,
  brief: Brief,
  also?: Partial<ParticipantState>,
): DemoSession | undefined {
  return editParticipant(session, participantId, { ...also, brief });
}

/** Stores how somebody's agent should argue, and drops the run it predates. */
export function applyPersonality(
  session: DemoSession,
  participantId: ParticipantId,
  personality: Personality,
): DemoSession | undefined {
  return editParticipant(session, participantId, { personality });
}
