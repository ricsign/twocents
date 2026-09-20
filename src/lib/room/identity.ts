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
import { DEFAULT_SESSION_ID, getOrCreateDefault, getSession } from "@/lib/session";
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
}

/* -------------------------------------------------------------------------- */
/* Room codes                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The alphabet a room code is drawn from.
 *
 * No `I`, `L`, `O`, `U`, `0` or `1`: a code gets read aloud across a table and
 * typed into a phone by somebody who is not looking carefully, so the pairs
 * that get misread are simply not in it. `U` is out because it and `V` are the
 * same shape in the display font.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

/** Six characters: ~7.3e8 codes, and still two seconds to say out loud. */
const CODE_LENGTH = 6;

/**
 * A code nothing is using yet.
 *
 * The collision check is exact rather than probabilistic because it can be:
 * the store is authoritative and the lookup is a map read. Five attempts is
 * not a real limit, it is a guard against an unbounded loop if the store ever
 * starts lying.
 */
export function newRoomCode(): string {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = randomCode();
    if (!getSession(code)) return code;
  }
  // Astronomically unlikely, and a room that cannot be minted is better than a
  // room that quietly reuses somebody else's id.
  throw new Error("could not find a free room code");
}

function randomCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length];
  return code;
}

/**
 * The canonical form of a code somebody typed, or null if it is not one.
 *
 * Doubles as the guard that keeps arbitrary strings out of `getSession`, which
 * is why every path that accepts a code from a URL goes through here.
 *
 * Two things it exists to prevent, both of which are silent:
 *
 * - **Case is not a room.** `fileFor` writes `.twocents/<id>.json`, and macOS
 *   is case-insensitive by default, so `MJ4K7P.json` and `mj4k7p.json` are one
 *   file — while `Map.get` treats them as two rooms. Memory would believe in
 *   two rooms, disk in one, and after a restart `restore` would hand back
 *   whichever was written last under both names. Folding to upper case means
 *   `/join/mj4k7p` is the room it looks like.
 * - **`"demo"` is not a code.** It case-folds to `DEMO`, which is a different
 *   map key and, on that same filesystem, the *same file* as the real default
 *   session. So it is recognised and returned verbatim instead.
 */
export function normalizeRoomCode(raw: string | undefined | null): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === DEFAULT_SESSION_ID) return DEFAULT_SESSION_ID;

  const upper = trimmed.toUpperCase();
  if (upper.length !== CODE_LENGTH) return null;
  for (const character of upper) {
    if (!ALPHABET.includes(character)) return null;
  }
  return upper;
}

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
export async function currentRoom(): Promise<RoomIdentity> {
  const jar = await cookies();
  return identityFrom(jar.get(ROOM_COOKIE)?.value, jar.get(SEAT_COOKIE)?.value);
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
