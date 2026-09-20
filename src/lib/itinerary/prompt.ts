/**
 * The prompt that turns an agreed plan into something a person can book.
 *
 * The negotiation produced one line — "Puerto Rico, 5 nights, $540 a person".
 * This asks the web what that actually looks like: which flight, which bed,
 * what you do on the Tuesday, and the URL for each of those. It runs once, at
 * the end, after all four humans have approved, so it is allowed to be the
 * slowest and most expensive call in the product.
 *
 * What it must never do is invent a link. A fabricated booking URL is worse
 * than no URL, because a person clicks it in front of the people they are going
 * with. The prompt says so, and `lib/itinerary/verify.ts` enforces it by
 * fetching every URL before it reaches the page.
 *
 * Reads a `Plan` and a `FairnessReport`, both of which are shown to all four
 * people already, so nothing private is in scope here.
 *
 * Pure: no I/O, no React, no Node APIs.
 */

import { z } from "zod";
import type { Plan } from "@/lib/types";

/** How many searches one itinerary is worth: flights, beds, and a day or two. */
export const ITINERARY_MAX_SEARCHES = 8;

/** A whole document, so a ceiling that fits days of detail rather than a line. */
export const ITINERARY_MAX_TOKENS = 8000;

/** Default deadline for the one itinerary call, in milliseconds. */
export const DEFAULT_ITINERARY_TIMEOUT_MS = 120_000;

/**
 * How long the itinerary call may take.
 *
 * It needs its own ceiling because the shared `TWOCENTS_LLM_TIMEOUT_MS` (20s)
 * is sized for a two-sentence negotiation turn, and this call runs up to
 * `ITINERARY_MAX_SEARCHES` web searches and then writes eight thousand tokens
 * of document. Under the shared default it timed out every time, and every
 * itinerary in the product was quietly the canned one. Nothing is on screen
 * waiting on a beat here — the person is watching a progress bar — so the
 * right ceiling is "long enough to actually finish".
 *
 * Read at call time so a change lands on the next build, not the next restart.
 */
export function itineraryTimeoutMs(): number {
  const raw = Number(process.env.TWOCENTS_ITINERARY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ITINERARY_TIMEOUT_MS;
}

/**
 * The model's half of the itinerary.
 *
 * Narrower than `itinerarySchema`: the photos, the subtotals, the group total
 * and the host list are all added afterwards by code that can verify them, and
 * asking a model for a number it cannot check is how a document ends up with a
 * total that does not match its own rows.
 */
/** A 24-hour clock time, or "" when the thing genuinely has no fixed one. */
const clockTime = z.string();

export const itineraryDraftSchema = z.object({
  headline: z.string(),
  flights: z.object({
    title: z.string(),
    detail: z.string(),
    costPerPerson: z.number().nullable(),
    url: z.string().nullable(),
    /** Outbound departure, 24-hour local time: "11:20". */
    startsAt: clockTime,
    /** When it lands, so day one cannot be scheduled before the plane is down. */
    arrivesAt: clockTime,
    /** When the flight home leaves, for the same reason in reverse. */
    returnsAt: clockTime,
  }),
  lodging: z.object({
    title: z.string(),
    detail: z.string(),
    costPerPerson: z.number().nullable(),
    url: z.string().nullable(),
    /** Check-in time, so the first afternoon is not spent on a pavement. */
    startsAt: clockTime,
  }),
  days: z.array(
    z.object({
      day: z.number(),
      date: z.string(),
      title: z.string(),
      /** What to photograph for this day: a real, searchable place name. */
      photoQuery: z.string(),
      items: z.array(
        z.object({
          time: z.string(),
          title: z.string(),
          detail: z.string(),
          costPerPerson: z.number().nullable(),
          url: z.string().nullable(),
          /**
           * When this actually starts, 24-hour: "19:30".
           *
           * A clock time rather than "Evening", because "evening" cannot be
           * compared with an opening hour and this is the field the whole
           * availability check turns on.
           */
          startsAt: clockTime,
          /** The posted opening time for that day, from the search. "" if none. */
          opensAt: clockTime,
          /** The posted closing time. "" when it does not close or was not found. */
          closesAt: clockTime,
          /** Weekdays it is shut: ["Monday"]. Empty when it never is. */
          closedDays: z.array(z.string()),
        }),
      ),
    }),
  ),
});

export type ItineraryDraft = z.infer<typeof itineraryDraftSchema>;

const SYSTEM = [
  "You are a travel agent writing up a trip four friends have just agreed on. They have approved the plan; your job is to turn it into the document they actually travel with.",
  "",
  "Search the web for real flights, real places to stay and real things to do, for this destination on these dates, at this budget. Build the days out of what you find.",
  "",
  "Rules:",
  "- One entry per day per meal-or-activity block, three to five items a day. Morning, afternoon, evening. Real named places, not \"a local restaurant\".",
  "- `costPerPerson` is per person in USD, or null when the thing is free. Keep the day totals inside the agreed per-person budget; the trip has to still cost what they agreed it costs.",
  "- `url` is a real page you found in the search results — the hotel's own site, the airline, the tour operator, the restaurant, the national park. Copy it exactly as it appeared.",
  "- NEVER invent a URL, and never guess at one from a pattern. If the search did not give you a link for something, set `url` to null. A null is correct; a made-up link is a lie somebody will click.",
  "- `photoQuery` is what to photograph for that day: a real place name that would appear in an encyclopedia, like \"Old San Juan\" or \"Culebra Flamenco Beach\". Not a mood, not an activity.",
  "- TIMES ARE CHECKED. `startsAt` is a real 24-hour clock time for every item, in the destination's local time, and the items of a day are in ascending order. `time` stays the readable label (\"Morning\", \"7:30pm\") — `startsAt` is the one that is compared against opening hours.",
  "- `opensAt`, `closesAt` and `closedDays` are that place's ACTUAL posted hours, from the same search that found the place. Never schedule something outside them and never schedule it on a day it is shut. If the search did not give you hours, leave them empty rather than inventing them — an empty field is checked as \"unknown\", a wrong one sends people to a locked door.",
  "- Flights carry `startsAt` (departure), `arrivesAt` (landing) and `returnsAt` (the flight home), all 24-hour local. Nothing on day one may start before `arrivesAt`, and nothing on the last day may start after `returnsAt`. Respect any promise the plan makes about departure times.",
  "- The days have to add up to roughly the agreed per-person budget. Prefer a free morning to a paid one you had to invent to fill the day.",
  "- `detail` is one short sentence. `title` is three or four words. This is a document to scan, not to read.",
  "- Day 1 is the arrival day and the last day is the departure day; do not schedule a sunrise hike on a day somebody lands at 4pm.",
].join("\n");

/** The user half: the agreed plan, as the four of them approved it. */
export function buildItineraryUserPrompt(plan: Plan, partySize: number): string {
  const offer = plan.offer;
  return [
    "THE TRIP THEY AGREED ON",
    `- Destination: ${offer.destination} (${offer.region})`,
    `- Dates: ${offer.dates}`,
    `- Nights: ${offer.nights}`,
    `- Budget: $${offer.perPerson} per person, all in, for ${partySize} people`,
    `- Flights they agreed to: ${offer.flightNote}`,
    `- Lodging they agreed to: ${offer.lodgingNote}`,
    "",
    "WHAT THE PLAN PROMISES THEM",
    plan.keptWants.map((want) => `- ${want}`).join("\n") || "- (nothing specific)",
    "",
    offer.feasibility
      ? `WHAT THE PRICE CHECK FOUND\n${offer.feasibility.note}`
      : "",
    "",
    `Build the ${offer.nights + 1} days. Search first.`,
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n");
}

/* -------------------------------------------------------------------------- */
/* The repair pass                                                             */
/* -------------------------------------------------------------------------- */

const REPAIR_SYSTEM = [
  "You are fixing a trip document that has already been drafted and then checked. Every problem below was found by comparing the draft against real opening hours, the flight times in it, and the budget the four people agreed to.",
  "",
  "Rules:",
  "- Return the WHOLE document again, in the same shape, with the listed problems fixed and everything else left exactly as it was. Do not rewrite what was not flagged.",
  "- Search again where you need to. Moving something to a time it is actually open is better than deleting it; deleting it is better than leaving it wrong.",
  "- Keep every rule from the original brief: real links only, never an invented URL, real posted hours in `opensAt`/`closesAt`/`closedDays`, items in ascending `startsAt` order.",
  "- If a place genuinely cannot work on that day, replace it with something that can, at a comparable price.",
].join("\n");

/**
 * The second call: the draft, the problems found in it, and nothing else.
 *
 * Sending the whole document back rather than the broken rows alone is the
 * expensive choice and the right one — the fix for "the museum is shut on
 * Monday" is usually to move something else too, and a model that can only see
 * one row cannot do that without inventing a conflict somewhere it cannot see.
 */
export function buildItineraryRepairPrompt(
  draft: ItineraryDraft,
  problems: readonly string[],
  plan: Plan,
  partySize: number,
): string {
  return [
    buildItineraryUserPrompt(plan, partySize),
    "",
    "THE DRAFT YOU WROTE",
    JSON.stringify(draft),
    "",
    "WHAT THE CHECK FOUND",
    problems.map((problem) => `- ${problem}`).join("\n"),
    "",
    "Fix exactly those and return the whole document.",
  ].join("\n");
}

export { REPAIR_SYSTEM as ITINERARY_REPAIR_SYSTEM_PROMPT, SYSTEM as ITINERARY_SYSTEM_PROMPT };
