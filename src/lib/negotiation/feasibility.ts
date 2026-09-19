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
 * Server-only. No React, no DOM.
 */

import type { CompletionRequest } from "@/lib/llm/provider";
import type { Offer, OfferFeasibility } from "@/lib/types";

/** How many searches one offer is worth. Two: a flight price and a bed price. */
const MAX_SEARCHES_PER_OFFER = 2;

/** Room for a verdict and a short note; this is not where prose belongs. */
const CHECK_MAX_TOKENS = 400;

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
};

const SYSTEM = [
  "You are the desk that checks whether a proposed trip is real. You are given one option from a negotiation. Search the web and say whether it can actually be booked at roughly that price.",
  "",
  "Rules:",
  "- Search for the real cost of flights and lodging for that destination and those dates. Use what you find, not what you remember.",
  "- `bookable` is false only when the price is clearly out of reach — off by roughly a third or more, or the dates do not work at all. A price in the right neighbourhood is bookable.",
  "- `realisticPerPerson` is the all-in per-person figure your search supports, or null if the search did not establish one.",
  "- `note` is ONE short sentence, written to be read aloud at the table: what it really costs, or what makes it work. No sources in the sentence, no hedging, no preamble.",
  "- `sources` is the bare host names you used, like \"kayak.com\". Three at most.",
].join("\n");

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