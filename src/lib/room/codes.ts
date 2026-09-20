/**
 * Room codes: making one, and recognising one somebody typed.
 *
 * Split from `identity.ts` so this can be imported without dragging
 * `next/headers` along — the runnable checks reach for it, and so does
 * anything that needs to recognise a code without being inside a request.
 * Same reason `seat.ts` sits beside `seed.ts`.
 */

import { DEFAULT_SESSION_ID, getSession } from "@/lib/session";

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

