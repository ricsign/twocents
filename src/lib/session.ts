/**
 * The demo's state: one object per session, held in memory and mirrored to disk.
 *
 * The in-memory map is what every read goes through, because the whole product
 * is a three-minute demo and nothing on stage should ever wait on a filesystem.
 * The file beside it exists for the one thing a map cannot do: survive the
 * process. Briefing an agent, setting its personality and approving a plan are
 * four screens and several minutes of a person's typing, and losing all of it to
 * a dev-server restart — or to Next re-evaluating a module on save — is not a
 * demo constraint, it is a bug. So every write is mirrored to a JSON file and
 * the map is refilled from it on a cold start.
 *
 * Three properties this is built around:
 *
 * - **Memory is the source of truth for reads.** The file is written after the
 *   map, never read except on a miss. A slow or full disk costs a warning line,
 *   not a request.
 * - **A reset is still total.** `resetSession` replaces the object *and* the
 *   file, so nothing a previous judge typed can survive into the next run.
 * - **A file that does not parse is not a crash.** The session schema is the
 *   gate: anything that fails it (an older build's shape, a half-written file,
 *   hand editing) is moved aside and the seed takes over.
 *
 * Server-only. No React, no DOM. Node APIs, so `runtime = "nodejs"` on any route
 * that touches it — which every route already declares.
 *
 * The `turbopackIgnore` comments on the `fs` calls are load-bearing for the
 * build, not decoration: the state directory is chosen at runtime, and without
 * them Turbopack reads the dynamic paths as "this module might open anything"
 * and traces the entire project into the server bundle.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSeedSession } from "@/lib/seed";
import { demoSessionSchema, type DemoSession } from "@/lib/types";

/** The session every screen uses unless it is told otherwise. */
export const DEFAULT_SESSION_ID = "demo";

/**
 * Where the mirror lives. Overridable so a test can point it at a scratch
 * directory and a deploy can point it at a writable volume.
 */
function stateDir(): string {
  return process.env.TWOCENTS_STATE_DIR?.trim() || join(process.cwd(), ".twocents");
}

/** Ids come from URLs, so the filename is built from a whitelist, not the id. */
function fileFor(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "session";
  return join(stateDir(), `${safe}.json`);
}

/**
 * Next.js's dev server re-evaluates modules on every edit, which would drop the
 * map — and with it the brief a judge is halfway through typing — on each save.
 * Stashing it on `globalThis` makes the store survive a hot reload without
 * going back to disk for it.
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

/* -------------------------------------------------------------------------- */
/* The mirror                                                                  */
/* -------------------------------------------------------------------------- */

/** One line per failure, and never a thrown error: persistence is best-effort. */
function warn(what: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.warn(`[session] ${what}: ${detail}`);
}

/**
 * Writes the session to disk, replacing what was there.
 *
 * Written to a temporary file and renamed, because a session carries an
 * itinerary with embedded photographs and a process that dies mid-write would
 * otherwise leave a truncated file that the next boot has to throw away.
 */
function persist(session: DemoSession): void {
  try {
    mkdirSync(/*turbopackIgnore: true*/ stateDir(), { recursive: true });
    const target = fileFor(session.id);
    const temporary = `${target}.tmp`;
    writeFileSync(/*turbopackIgnore: true*/ temporary, JSON.stringify(session), "utf8");
    renameSync(/*turbopackIgnore: true*/ temporary, target);
  } catch (error) {
    // A demo that cannot write to disk still has to run: the map is intact and
    // this session is simply not going to outlive the process.
    warn(`could not save ${session.id}`, error);
  }
}

/**
 * Reads a session back, or null when there is nothing usable to read.
 *
 * A file that fails the schema is renamed rather than deleted — it is the only
 * copy of what somebody typed, and "the shape changed between builds" is worth
 * being able to look at afterwards.
 */
function restore(id: string): DemoSession | null {
  const target = fileFor(id);
  if (!existsSync(/*turbopackIgnore: true*/ target)) return null;

  let raw: string;
  try {
    raw = readFileSync(/*turbopackIgnore: true*/ target, "utf8");
  } catch (error) {
    warn(`could not read ${id}`, error);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    quarantine(target, id, error);
    return null;
  }

  const checked = demoSessionSchema.safeParse(parsed);
  if (!checked.success) {
    quarantine(target, id, checked.error);
    return null;
  }

  // The id in the file wins over the one in the filename only if they agree;
  // a copied file must not answer for a session it is not.
  return { ...checked.data, id };
}

function quarantine(target: string, id: string, error: unknown): void {
  warn(`saved state for ${id} is unusable, starting fresh`, error);
  try {
    renameSync(/*turbopackIgnore: true*/ target, `${target}.broken`);
  } catch {
    // Nothing more to do: the caller falls back to a seeded session either way.
  }
}

/** Drops the file for a session. Used by the total reset and by tests. */
function forget(id: string): void {
  for (const path of [fileFor(id), `${fileFor(id)}.tmp`]) {
    try {
      if (existsSync(/*turbopackIgnore: true*/ path)) unlinkSync(/*turbopackIgnore: true*/ path);
    } catch (error) {
      warn(`could not clear ${id}`, error);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

/** The session with this id, or undefined. Never creates, but will restore. */
export function getSession(id: string): DemoSession | undefined {
  const sessions = store().sessions;
  const live = sessions.get(id);
  if (live) return live;

  const saved = restore(id);
  if (!saved) return undefined;
  sessions.set(id, saved);
  return saved;
}

/**
 * The session the demo runs on: the one in memory, the one on disk, or a new
 * seeded one, in that order.
 *
 * Every route calls this rather than constructing a session, so a cold start
 * mid-demo (a redeploy, a crashed dev server, a laptop lid) comes back with
 * what the person had rather than with an empty room.
 */
export function getOrCreateDefault(): DemoSession {
  const existing = getSession(DEFAULT_SESSION_ID);
  if (existing) return existing;

  const seeded = createSeedSession(DEFAULT_SESSION_ID);
  store().sessions.set(DEFAULT_SESSION_ID, seeded);
  persist(seeded);
  return seeded;
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Merges a patch into a session and returns the new value.
 *
 * Replaces rather than mutates so a consumer holding the previous object — a
 * request that is still streaming, say — keeps reading a consistent snapshot
 * instead of watching fields change underneath it. The disk write happens after
 * the map is updated, so a reader is never blocked by it.
 */
export function updateSession(
  id: string,
  patch: Partial<Omit<DemoSession, "id">>,
): DemoSession | undefined {
  const sessions = store().sessions;
  const existing = sessions.get(id) ?? restore(id) ?? undefined;
  if (!existing) return undefined;

  const next: DemoSession = { ...existing, ...patch, id: existing.id };
  sessions.set(id, next);
  persist(next);
  return next;
}

/**
 * The judges' reset button.
 *
 * Total by construction: a brand new seed object replaces the old one in the
 * map and on disk, so no turn, approval or half-finished brief can survive into
 * the next run. The id is preserved because the client is already pointed at it.
 */
export function resetSession(id: string = DEFAULT_SESSION_ID): DemoSession {
  const fresh = createSeedSession(id);
  store().sessions.set(id, fresh);
  forget(id);
  persist(fresh);
  return fresh;
}

/** Drops every session, in memory and on disk. Exists for tests. */
export function clearAllSessions(): void {
  for (const id of store().sessions.keys()) forget(id);
  store().sessions.clear();
}
