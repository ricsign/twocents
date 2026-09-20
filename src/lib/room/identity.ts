/**
 * Which room a browser is in, and which seat it is sitting in.
 *
 * Before rooms there was one session, `"demo"`, and one person, `YOU`. Both
 * were module constants, which is why every screen could simply import them.
 * A room needs those two facts to vary per browser, and this file is the only
 * place that knows how they are carried.
 *
 * **They are carried in cookies, and the reason is the fallback.** A cookie
 * has a well-defined absent state, and this module defines that state as
 * exactly what the constants used to say: room `"demo"`, seat `YOU`. So a
 * browser that has never joined anything walks the original four screens and
 * cannot tell that rooms were added — which is what keeps `docs/DEMO.md`
 * honest. Query parameters have no such state: "no room" would become "this
 * link forgot the parameter", and a forgotten parameter drops somebody into
 * the demo session silently, showing them a working app with the wrong four
 * people in it. That is a worse failure than an error, because nothing about
 * it looks wrong.
 *
 * Explicit beats cookie beats default. `?sessionId=` and `?viewer=` still win
 * where they are given, so `curl -N '/api/negotiate?sessionId=…&viewer=sam'`
 * works exactly as documented and the judges' round can still address the
 * default session by name.
 *
 * Server-only: `cookies()` is a request-time API and `getSession` reaches the
 * in-process store, so every route and page that uses this already declares
 * `runtime = "nodejs"` and `dynamic = "force-dynamic"`.
 */

import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import { YOU, type ParticipantId } from "@/lib/characters";
import { normalizeRoomCode } from "@/lib/room/codes";
import { DEFAULT_SESSION_ID, getOrCreateDefault, getSession } from "@/lib/session";
import type { UrlIdentity } from "@/lib/room/links";
import { participantIdSchema, type DemoSession } from "@/lib/types";

/** Which room this browser last joined. */
export const ROOM_COOKIE = "twocents_room";
/** Which of the four seats it claimed there. */
export const SEAT_COOKIE = "twocents_seat";

/** Twelve hours: long enough for a trip to get planned, short enough to expire. */
const COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;

/** Who a request is, once both sources have been consulted. */
export interface RoomIdentity {
  /** The session id to read and write. `DEFAULT_SESSION_ID` when unjoined. */
  sessionId: string;
  /** The seat this browser speaks as. `YOU` when unjoined. */
  seat: ParticipantId;
  /** False when both values came from the fallback — i.e. a solo run. */
  joined: boolean;
  /**
   * The identity to thread back into this page's own links, if any.
   *
   * Empty for a browser relying on its cookie, which is everybody who joined
   * normally — their links stay clean and shareable. Populated only when the
   * URL named a seat or a room, which is how one browser holds two identities
   * in two tabs.
   */
  url?: UrlIdentity;
}

// Re-exported so a caller that already imports this module for `currentRoom`
// does not need a second import to recognise the code in a URL.
export { newRoomCode, normalizeRoomCode } from "@/lib/room/codes";

/* -------------------------------------------------------------------------- */
/* Reading identity                                                            */
/* -------------------------------------------------------------------------- */

/**
 * This browser's room and seat, for a Server Component.
 *
 * `cookies()` is async here and read-only: setting one during a render is not
 * possible, because headers are long gone by the time a component streams. All
 * writes happen in `/api/room/claim`, which is the only reason the join flow
 * is a route handler and a redirect rather than a page that quietly signs you
 * in.
 */
export async function currentRoom(
  searchParams?: Promise<Record<string, string | string[] | undefined>>,
): Promise<RoomIdentity> {
  const jar = await cookies();
  const fromJar = identityFrom(jar.get(ROOM_COOKIE)?.value, jar.get(SEAT_COOKIE)?.value);
  if (!searchParams) return fromJar;

  // An identity named in the URL outranks the jar, because a jar is shared by
  // every tab in a browser and a URL is not. See `lib/room/links.ts`.
  const asked = await searchParams;
  const room = normalizeRoomCode(one(asked.room)) ?? fromJar.sessionId;
  const seat = seatOf(one(asked.seat)) ?? fromJar.seat;
  const named = Boolean(one(asked.room)) || Boolean(one(asked.seat));

  return {
    sessionId: room,
    seat,
    joined: fromJar.joined || (named && room !== DEFAULT_SESSION_ID),
    /** What to put back into the next link, so the tab keeps its identity. */
    url: named ? { room: one(asked.room) ?? null, seat: seatOf(one(asked.seat)) } : {},
  };
}

/** A search param, whichever of the two shapes Next hands it over in. */
function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The same, for a Route Handler, with explicit parameters winning.
 *
 * Order is explicit, then cookie, then default. Keeping explicit on top is
 * what preserves the documented `?sessionId=` / `?viewer=` contract — the two
 * itinerary routes, the negotiation stream and `GET /api/session` all accept
 * them today, and a `curl` against any of them must not start depending on a
 * browser's cookie jar.
 */
export async function roomFromRequest(
  request: Request,
  body?: { sessionId?: string | null; viewer?: string | null },
): Promise<RoomIdentity> {
  const url = new URL(request.url);
  const jar = await cookies();

  const askedRoom = body?.sessionId ?? url.searchParams.get("sessionId");
  const askedSeat = body?.viewer ?? url.searchParams.get("viewer");

  const fromCookies = identityFrom(jar.get(ROOM_COOKIE)?.value, jar.get(SEAT_COOKIE)?.value);

  const room = normalizeRoomCode(askedRoom) ?? fromCookies.sessionId;
  const seat = seatOf(askedSeat) ?? fromCookies.seat;
  return {
    sessionId: room,
    seat,
    joined: fromCookies.joined,
  };
}

function identityFrom(rawRoom: string | undefined, rawSeat: string | undefined): RoomIdentity {
  const room = normalizeRoomCode(rawRoom);
  const seat = seatOf(rawSeat);
  // A half-set pair is not a room. Both cookies are written in one response and
  // expire together, so one without the other means something tampered or
  // something expired, and the safe reading of both is "not joined".
  if (!room || !seat || room === DEFAULT_SESSION_ID) {
    return { sessionId: DEFAULT_SESSION_ID, seat: seat ?? YOU, joined: false };
  }
  return { sessionId: room, seat, joined: true };
}

/** A seat id, or null for anything that is not one of the four. */
export function seatOf(raw: string | undefined | null): ParticipantId | null {
  const parsed = participantIdSchema.safeParse(raw?.trim());
  return parsed.success ? parsed.data : null;
}

/* -------------------------------------------------------------------------- */
/* Reading the session behind it                                               */
/* -------------------------------------------------------------------------- */

/**
 * The session for an id: created on demand for the demo, looked up for a room.
 *
 * The asymmetry is deliberate and was already the rule in three routes before
 * it was collected here. `getOrCreateDefault` exists so the demo can never be
 * missing; a room code, by contrast, either names a room somebody made or is a
 * dead link, and minting an empty room for it would answer a mistyped code
 * with four strangers rather than with "that room is gone".
 */
export function resolveSession(sessionId: string): DemoSession | undefined {
  return sessionId === DEFAULT_SESSION_ID ? getOrCreateDefault() : getSession(sessionId);
}

/* -------------------------------------------------------------------------- */
/* Writing identity                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Attaches this browser to a seat in a room.
 *
 * `secure` is derived from the request rather than from `NODE_ENV`, and that
 * is load-bearing rather than fussy. This app is demonstrated through a tunnel
 * that terminates TLS and forwards plain HTTP, so the environment says
 * "development" while the browser says "https" — and a `Secure` cookie sent
 * over what the browser considers an insecure connection is *silently
 * discarded*. The failure is a join that appears to work and a next page that
 * has forgotten you.
 *
 * `httpOnly` is off so a client component can read its own seat without a
 * round trip. That is not a weakening: the seat was already an unauthenticated
 * `?viewer=` parameter, and the room code is the credential here.
 */
export function setRoomCookies(
  response: NextResponse,
  request: Request,
  sessionId: string,
  seat: ParticipantId,
): void {
  const options = {
    path: "/",
    sameSite: "lax" as const,
    httpOnly: false,
    secure: isHttps(request),
    maxAge: COOKIE_MAX_AGE_SECONDS,
  };
  response.cookies.set(ROOM_COOKIE, sessionId, options);
  response.cookies.set(SEAT_COOKIE, seat, options);
}

/**
 * Forgets the room, so the next screen reads as a solo run again.
 *
 * The judges' round calls this. It seeds the *default* session and then sends
 * the browser to the town, so a phone still carrying a room code would arrive
 * there, read the cookie and watch a different session entirely — a bug that
 * only ever appears when somebody demos both features in one sitting, which is
 * exactly when it would be noticed.
 */
export function clearRoomCookies(response: NextResponse): void {
  response.cookies.delete(ROOM_COOKIE);
  response.cookies.delete(SEAT_COOKIE);
}

function isHttps(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0]?.trim() === "https";
  return new URL(request.url).protocol === "https:";
}
