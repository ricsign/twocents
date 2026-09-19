/**
 * The demo's state, in a map.
 *
 * There is no database here and that is a decision, not a shortcut. The whole
 * product is a three-minute demo that has to reset to a known-good state between
 * judges, in one click, with nothing left over from the previous run. A database
 * makes that harder in every direction: a migration to run before the laptop
 * opens, a connection that can be down on stage, and — worst — rows that survive
 * a reset and leak one judge's briefing into the next judge's negotiation. A
 * `Map` gives an instant, total reset (`resetSession` replaces the object) and
 * cannot be down. Nothing in this app needs to outlive the process.
 *
 * The cost is honest and small: state is per-process, so a multi-instance deploy
 * would hand different users different sessions. For a single laptop in front of
 * four judges, that is not a cost at all.
 *
 * Server-only. No React, no DOM.
 */

import { createSeedSession } from "@/lib/seed";
import type { DemoSession } from "@/lib/types";

/** The session every screen uses unless it is told otherwise. */
export const DEFAULT_SESSION_ID = "demo";

/**
 * Next.js's dev server re-evaluates modules on every edit, which would drop the
 * map — and with it the brief a judge is halfway through typing — on each save.
 * Stashing it on `globalThis` makes the store survive a hot reload, which is the
 * difference between iterating on the town screen and re-briefing an agent after
 * every keystroke.
 */
const STORE_KEY = Symbol.for("twocents.sessionStore");

interface SessionStore {
  sessions: Map<string, DemoSession>;
}

function store(): SessionStore {
  const holder = globalThis as typeof globalThis & { [STORE_KEY]?: SessionStore };
  if (!holder[STORE_KEY]) {
    holder[STORE_KEY] = { sessions: new Map<string, DemoSession>() };
  }
  return holder[STORE_KEY];
}

/** The session with this id, or undefined. Never creates. */
export function getSession(id: string): DemoSession | undefined {
  return store().sessions.get(id);
}

/**
 * The session the demo runs on, created on first touch.
 *
 * Every route calls this rather than constructing a session, so a cold start
 * mid-demo (a redeploy, a crashed dev server) comes back with the seeded
 * three-agents-briefed state instead of an empty room.
 */
export function getOrCreateDefault(): DemoSession {
  const sessions = store().sessions;
  const existing = sessions.get(DEFAULT_SESSION_ID);
  if (existing) return existing;

  const seeded = createSeedSession(DEFAULT_SESSION_ID);
  sessions.set(DEFAULT_SESSION_ID, seeded);
  return seeded;
}

/**
 * Merges a patch into a session and returns the new value.
 *
 * Replaces rather than mutates so a consumer holding the previous object — a
 * request that is still streaming, say — keeps reading a consistent snapshot
 * instead of watching fields change underneath it.
 */
export function updateSession(
  id: string,
  patch: Partial<Omit<DemoSession, "id">>,
): DemoSession | undefined {
  const sessions = store().sessions;
  const existing = sessions.get(id);
  if (!existing) return undefined;

  const next: DemoSession = { ...existing, ...patch, id: existing.id };
  sessions.set(id, next);
  return next;
}

/**
 * The judges' reset button.
 *
 * Total by construction: a brand new seed object replaces the old one, so no
 * turn, approval or half-finished brief can survive into the next run. The id is
 * preserved because the client is already pointed at it.
 */
export function resetSession(id: string = DEFAULT_SESSION_ID): DemoSession {
  const fresh = createSeedSession(id);
  store().sessions.set(id, fresh);
  return fresh;
}

/** Drops every session. Exists for tests; the demo only ever resets one. */
export function clearAllSessions(): void {
  store().sessions.clear();
}
