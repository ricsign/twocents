/**
 * In-memory coordination for push-to-talk interjections.
 *
 * Deliberately separate from the session store: this is run-scoped control
 * state — is the room paused right now, is there a transcript waiting to be
 * said — not anything the plan screen renders or a session reset has to know
 * the shape of. Keyed by session id so multiple demo rooms never cross wires.
 *
 * Lives only in process memory, the same way the rest of this demo's session
 * store does — a restart clears it, which is fine for a live negotiation that
 * doesn't survive a restart either.
 *
 * Server-only. No React, no DOM.
 */

import type { ParticipantId } from "@/lib/characters";

export interface PendingInterjection {
  participantId: ParticipantId;
  text: string;
}

interface ControlState {
  paused: boolean;
  pending: PendingInterjection | null;
  waiters: Array<() => void>;
}

const rooms = new Map<string, ControlState>();

function stateFor(sessionId: string): ControlState {
  let state = rooms.get(sessionId);
  if (!state) {
    state = { paused: false, pending: null, waiters: [] };
    rooms.set(sessionId, state);
  }
  return state;
}

/** Wakes everything blocked in `waitWhilePaused` for this room. */
function release(state: ControlState): void {
  const waiters = state.waiters;
  state.waiters = [];
  for (const wake of waiters) wake();
}

/** Called when the push-to-talk button goes down. */
export function pauseRoom(sessionId: string): void {
  stateFor(sessionId).paused = true;
}

/** Called when the button comes up with nothing worth saying, or on timeout. */
export function resumeRoom(sessionId: string): void {
  const state = stateFor(sessionId);
  state.paused = false;
  release(state);
}

export function isPaused(sessionId: string): boolean {
  return stateFor(sessionId).paused;
}

/**
 * Hands the transcribed, leak-checked line to the next thing the engine does,
 * and unpauses the room. The button coming up already means the sentence is
 * decided — there is nothing left to hold the loop for.
 */
export function queueInterjection(
  sessionId: string,
  participantId: ParticipantId,
  text: string,
): void {
  const state = stateFor(sessionId);
  state.pending = { participantId, text };
  state.paused = false;
  release(state);
}

/** Consumed once. The engine calls this at most once per loop checkpoint. */
export function takePendingInterjection(sessionId: string): PendingInterjection | null {
  const state = stateFor(sessionId);
  const pending = state.pending;
  state.pending = null;
  return pending;
}

/**
 * Blocks the round loop while the room is paused, with a hard ceiling so a
 * forgotten button or a dropped client can never stall a run in front of a
 * judge. Resolves early if the run itself is aborted. Returns immediately,
 * with no promise allocated, when nobody is holding the button — this runs
 * once per speaker per round, so the common case has to be free.
 */
export function waitWhilePaused(
  sessionId: string,
  signal: AbortSignal | undefined,
  maxMs: number,
): Promise<void> {
  const state = stateFor(sessionId);
  if (!state.paused) return Promise.resolve();

  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(() => {
      state.paused = false;
      finish();
    }, maxMs);
    state.waiters.push(finish);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Called on session reset and at the start of every run, so a stale pause or
 * a queued line left over from a previous run — a refresh mid-hold, an
 * aborted stream — can never leak into the next one.
 */
export function clearRoom(sessionId: string): void {
  const state = rooms.get(sessionId);
  if (!state) return;
  release(state);
  rooms.delete(sessionId);
}