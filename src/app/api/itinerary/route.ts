/**
 * The itinerary: built once, then served from the session.
 *
 * Two things this route owns.
 *
 * **The gate.** The itinerary is the reward for all four approvals, so this is
 * where "all four" is actually checked. Not in the page, not in the button —
 * here, on the server, next to the state it reads, because a gate you can walk
 * around by typing a URL is decoration.
 *
 * **Build-once.** The build makes a searching model call and then fetches every
 * link and photo it returned, which is the slowest thing the product does. It
 * runs on the first POST and is cached on the session; the page, the PDF route
 * and a reload all read that one result, so opening the document twice does not
 * search the web twice.
 */

import { PARTICIPANT_IDS } from "@/lib/characters";
import { buildItinerary } from "@/lib/itinerary/build";
import { DEFAULT_SESSION_ID, getOrCreateDefault, getSession, updateSession } from "@/lib/session";
import type { DemoSession } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serialised per session, so two tabs opening `/itinerary` at the same moment
 * produce one build rather than two. Keyed on the session id and dropped as
 * soon as it settles.
 */
const inFlight = new Map<string, Promise<DemoSession["itinerary"]>>();

function sessionFor(id: string): DemoSession | undefined {
  return id === DEFAULT_SESSION_ID ? getOrCreateDefault() : getSession(id);
}

/** Everyone, or the ones still missing. */
function missingApprovals(session: DemoSession): string[] {
  return PARTICIPANT_IDS.filter((id) => session.participants[id]?.approved !== true);
}

async function ensureItinerary(session: DemoSession): Promise<DemoSession["itinerary"]> {
  if (session.itinerary) return session.itinerary;

  const existing = inFlight.get(session.id);
  if (existing) return existing;

  const job = (async () => {
    // `session.plan` is checked by the caller; this reassures the type system
    // and guards the theoretical race where the session was reset mid-build.
    if (!session.plan) return null;
    const built = await buildItinerary(session.plan);
    updateSession(session.id, { itinerary: built });
    return built;
  })().finally(() => inFlight.delete(session.id));

  inFlight.set(session.id, job);
  return job;
}

/** What both verbs answer with, so the client has one shape to parse. */
function answer(session: DemoSession) {
  return Response.json({
    sessionId: session.id,
    tripName: session.tripName,
    itinerary: session.itinerary,
  });
}

/** Reads what has been built. Never builds: a GET that costs money is a trap. */
export async function GET(request: Request): Promise<Response> {
  const sessionId = new URL(request.url).searchParams.get("sessionId") ?? DEFAULT_SESSION_ID;
  const session = sessionFor(sessionId);
  if (!session) return Response.json({ error: "unknown session", sessionId }, { status: 404 });
  return answer(session);
}

/** Builds it, or hands back the one that was already built. */
export async function POST(request: Request): Promise<Response> {
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // An empty POST is the common case: the page asking for the default session.
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const sessionId =
    typeof payload.sessionId === "string" ? payload.sessionId : DEFAULT_SESSION_ID;

  const session = sessionFor(sessionId);
  if (!session) return Response.json({ error: "unknown session", sessionId }, { status: 404 });

  if (!session.plan) {
    return Response.json({ error: "no plan yet", sessionId }, { status: 409 });
  }

  const missing = missingApprovals(session);
  if (missing.length > 0) {
    return Response.json(
      { error: "not everybody has approved", waitingOn: missing, sessionId },
      { status: 403 },
    );
  }

  try {
    await ensureItinerary(session);
  } catch (error) {
    // `buildItinerary` does not throw, so this is the store or a reset landing
    // mid-build. Say so plainly rather than handing back a half-built document.
    console.warn("[itinerary] build failed:", error);
    return Response.json({ error: "the itinerary could not be built" }, { status: 500 });
  }

  const finished = sessionFor(sessionId);
  return finished ? answer(finished) : Response.json({ error: "session vanished" }, { status: 404 });
}
