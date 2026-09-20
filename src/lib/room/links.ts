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
 * **Only ever appended when it was already explicit.** Somebody who joined
 * normally keeps clean URLs and the cookie answers for them, so nothing about
 * the four-phone case changes. This is an escape hatch, not a mechanism.
 *
 * Pure. Safe on both sides of the wire.
 */

import type { ParticipantId } from "@/lib/characters";

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
  if (identity?.seat) params.set("seat", identity.seat);

  const query = params.toString();
  if (!query) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${query}`;
}
