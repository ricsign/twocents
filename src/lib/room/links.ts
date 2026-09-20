/**
 * Carrying an identity in the URL, for when a cookie cannot.
 *
 * A cookie jar belongs to a browser, not to a tab. That is right for the way
 * the product is actually used — four people, four phones, four jars — and
 * wrong for the way it is *tested*, which is one laptop with two tabs open.
 * Claiming a seat in the second tab rewrites the cookie the first tab is
 * using, and both tabs quietly become the same person.
 *
 * So identity may also be named in the URL, and when it is, it wins. The
 * claim route sends people onward with `?seat=` for exactly this reason: two
 * tabs then hold two different URLs and stop fighting over one jar.
 *
 * **Present on every link once you are in a room.** Demoing means several
 * links open in one browser, so the seat has to be visible in the address bar
 * rather than implied by a jar — it is the only way to tell two tabs apart at
 * a glance. A solo run names nothing and keeps clean URLs.
 *
 * One consequence worth saying out loud: a URL with a seat in it *is* that
 * seat. Sending somebody your address bar hands them your agent. The link to
 * share is the one the lobby copies, `/join/<code>`, which lets them pick
 * their own. This is the same trust model the room code already had — the
 * code is the credential — but it is easier to do by accident, so the lobby
 * is the only place that offers a link to copy.
 *
 * Pure. Safe on both sides of the wire.
 */

import { PARTICIPANT_IDS, type ParticipantId } from "@/lib/characters";

/* -------------------------------------------------------------------------- */
/* What a seat is called in a URL                                              */
/* -------------------------------------------------------------------------- */

/**
 * The public name for a seat: `p1` through `p4`.
 *
 * Not the participant id. Those are `maya`, `jordan`, `sam` and `priya` —
 * sprite keys from a demo that had a fixed cast, and they are still the right
 * keys internally because they index the art, the colours and every row of
 * state. In a URL they are simply wrong: a person looking at `?seat=jordan`
 * while the screen calls them Player 2, or Bo, has been shown the name of
 * somebody who is not in this room. `p2` says the one true thing about that
 * seat — which chair it is.
 *
 * Positional, so it matches the numbering on the title screen and survives any
 * future renaming of the cast.
 */
export type SeatToken = `p${1 | 2 | 3 | 4}`;

/** `maya` -> `p1`. The only form a seat should take in a link. */
export function seatToken(id: ParticipantId): SeatToken {
  return `p${(PARTICIPANT_IDS.indexOf(id) + 1) as 1 | 2 | 3 | 4}`;
}

/**
 * `p1` -> `maya`, or null.
 *
 * Also accepts a raw participant id, because `?viewer=sam` is a documented
 * part of this app's HTTP surface and a `curl` written against it must keep
 * working.
 */
export function seatFromToken(raw: string | undefined | null): ParticipantId | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;

  const numbered = /^p([1-4])$/.exec(value);
  if (numbered) return PARTICIPANT_IDS[Number(numbered[1]) - 1] ?? null;

  return (PARTICIPANT_IDS as readonly string[]).includes(value)
    ? (value as ParticipantId)
    : null;
}

/** An identity named in a URL, or the absence of one. */
export interface UrlIdentity {
  room?: string | null;
  seat?: ParticipantId | null;
}

/**
 * `path`, carrying whatever identity was explicitly in play.
 *
 * Given nothing, returns the path untouched — which is the common case and
 * the one that keeps a shared link shareable.
 */
export function withIdentity(path: string, identity?: UrlIdentity): string {
  const params = new URLSearchParams();
  if (identity?.room) params.set("room", identity.room);
  if (identity?.seat) params.set("seat", seatToken(identity.seat));

  const query = params.toString();
  if (!query) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${query}`;
}
