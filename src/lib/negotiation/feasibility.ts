/**
 * The reality check on an offer.
 *
 * An agent that can invent "Tokyo, 6 nights, $700 a person" is negotiating
 * about nothing, and a judge who knows what a flight to Tokyo costs can see it
 * from the back of the room. So every offer that hits the table is checked
 * against the live web before anyone argues with it, and the verdict goes into
 * the transcript the other agents read — which is what turns it from a garnish
 * into part of the negotiation, since "that price isn't real" is a thing an
 * agent can now push back with.
 *
 * Two properties carried over from the rest of the engine:
 *
 * - **It cannot stall the room.** The check is one call with its own deadline,
 *   already inherited from the provider, and a failure returns canned facts
 *   rather than propagating.
 * - **It says nothing private.** It sees an `Offer`, which is public by
 *   construction — it was just spoken aloud — and never a `Brief`.
 *
 * One rule earns its length in the prompt below: an option the desk could not
 * price is bookable. Agents describe options the way people do — "the beach
 * resort", no departure city — so a desk that answered "not bookable, cannot
 * verify" flagged nearly everything, and rule 7 of the public prompt then sent
 * every agent after the same missing link. The room spent its rounds asking
 * for paperwork instead of planning a trip. Not knowing is not evidence.
 *
 * Server-only. No React, no DOM.
 */

import type { CompletionRequest } from "@/lib/llm/provider";
import type { NegotiationSourced, Offer, OfferFeasibility } from "@/lib/types";

/** How many searches one offer is worth. Two: a flight price and a bed price. */
const MAX_SEARCHES_PER_OFFER = 2;

/**
 * The verdict is four short fields, but this ceiling is not sized for the
 * verdict. A searching call spends output tokens deciding what to search for
 * and reading its way to an answer before it emits anything, and a budget that
 * only fits the answer truncates the emit halfway through — which arrives as a
 * schema failure with half the fields missing, not as an obvious "ran out of
 * room". This is sized for the whole round trip.
 */
const CHECK_MAX_TOKENS = 1500;

/**
 * Whether the check runs at all. On by default; set `TWOCENTS_WEB_SEARCH=0` to
 * rehearse without paying for searches, which leaves every offer unchecked and
 * the rest of the run untouched. Read at call time, like `llmTimeoutMs`.
 */
export function webSearchEnabled(): boolean {
  return process.env.TWOCENTS_WEB_SEARCH !== "0";
}

/**
 * What the room falls back to when the search fails, the key is missing or the
 * call runs past its deadline.
 *
 * It deliberately does not claim the offer is fine. "Not checked" is the honest
 * thing to say when nothing was checked, and an agent reading it still has a
 * usable line — the alternative, silently implying a price was verified, is the
 * failure this module exists to prevent.
 */
export const UNCHECKED: OfferFeasibility = {
  bookable: true,
  realisticPerPerson: null,
  note: "Not checked against live prices.",
  sources: [],
  // No pages were opened, so there is nothing to link to. The transcript keys
  // its "a quick web search shows" line off this list being non-empty, which
  // is what stops an unchecked offer from claiming a search.
  links: [],
};

const SYSTEM = [
  "You are the desk that checks whether a proposed trip is real. You are given one option from a negotiation. Search the web and say whether it can actually be booked at roughly that price.",
  "",
  "Rules:",
  "- Search for the real cost of flights and lodging for that destination and those dates. Use what you find, not what you remember.",
  "- `bookable` is false ONLY when your search established that the price is clearly out of reach — off by roughly a third or more, or the dates do not work at all.",
  "- If you could not establish a price, `bookable` is TRUE. Not knowing is not evidence. An option described loosely — \"the beach resort\", no departure city — is an option you cannot price, so say what it would plausibly cost and leave it bookable. Marking it false turns the table into an argument about missing paperwork instead of about the trip.",
  "- `realisticPerPerson` is the all-in per-person figure your search supports, or null if the search did not establish one.",
  "- `note` is ONE short sentence, written to be read aloud at the table: what it really costs, or what makes it work. When you could not price it, say what it would plausibly run to. No sources in the sentence, no hedging, no preamble, and never ask for more detail — nobody at that table can give you any.",
  "- `sources` is the bare host names you used, like \"kayak.com\". Three at most.",
].join("\n");

/**
 * The sentence the transcript prints under a checked offer.
 *
 * Built here rather than asked of the model, so the claim and the links can
 * never come apart: this string is only ever constructed next to the pages
 * that back it, and it returns nothing when there are none. The phrasing is
 * fixed for the same reason — "a quick web search shows" is a claim about what
 * the product did, so the product says it, not a model improvising. The note
 * keeps its own capitalisation, because the product does not know whether the
 * word it starts with is a proper noun.
 */
export function sourcedFrom(check: OfferFeasibility | undefined): NegotiationSourced | null {
  if (!check || check.links.length === 0) return null;
  const note = check.note.trim();
  if (!note) return null;
  // Joined with a colon rather than folded into the sentence. Lowercasing the
  // first character read fine until the desk led with a proper noun, and then
  // the transcript said "a quick web search shows march is peak season".
  return {
    note: `A quick web search shows: ${note}`,
    // Three is what fits on a transcript row; the offer card keeps the rest.
    links: check.links.slice(0, 3),
  };
}

/** The request for one offer's check, ready to hand to a provider. */
export function buildFeasibilityRequest(offer: Offer): CompletionRequest {
  const user = [
    "THE PROPOSED TRIP",
    `- Destination: ${offer.destination} (${offer.region})`,
    `- Dates: ${offer.dates}, ${offer.nights} nights`,
    `- Claimed cost: $${offer.perPerson} per person, all in`,
    `- Flights: ${offer.flightNote}`,
    `- Lodging: ${offer.lodgingNote}`,
    `- Promises: ${offer.highlights.join("; ")}`,
    "",
    "Check it.",
  ].join("\n");

  return {
    tag: "offer-check",
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
    maxTokens: CHECK_MAX_TOKENS,
    webSearch: { maxUses: MAX_SEARCHES_PER_OFFER },
    context: {
      destination: offer.destination,
      perPerson: offer.perPerson,
      nights: offer.nights,
      dates: offer.dates,
    },
  };
}