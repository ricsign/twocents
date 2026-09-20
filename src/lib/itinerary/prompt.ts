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

/**
 * How many searches one itinerary is worth.
 *
 * Five, down from eight. Eight was one per day plus flights and beds, which
 * reads the rules below as if each day were an independent lookup. It is not:
 * the days share one destination, and the three things the rules actually
 * require the model to look up are the flight (with its departure, landing and
 * return times), the bed (with its check-in), and real named places with their
 * posted hours. The last of those is a destination-level question — "what is
 * open in San Juan and when" — that the same results answer for Tuesday and
 * for Friday. Two structural searches plus three on the place covers it.
 *
 * Each of these is a server-side round trip of seconds inside the one call,
 * and this call is the "BUILDING YOUR ITINERARY" progress bar somebody is
 * watching, so three fewer is the single largest saving available here.
 *
 * The floor is set by a rule, not by taste: the model is told to leave
 * `opensAt`/`closesAt` empty rather than invent them, so a search budget too
 * small to find hours degrades to a document with unknown hours — honest, and
 * checked as unknown — rather than to a wrong one. Below about four it starts
 * degrading the day content itself, which is what people read.
 */
export const ITINERARY_MAX_SEARCHES = 5;

/**
 * A whole document, so a ceiling that fits days of detail rather than a line.
 *
 * Deliberately not reduced. A tool call that runs out of room mid-object
 * arrives as a schema failure with half its fields missing, and `build.ts`
 * answers a schema failure with the canned itinerary — so a ceiling shaved to
 * save a few seconds costs the whole live document instead. Slow beats canned.
 */
export const ITINERARY_MAX_TOKENS = 8000;

/**
 * The repair pass's ceiling.
 *
 * Smaller than the first call's, because the work is smaller in exactly one
 * way: the repair does not search, so none of the budget goes on deciding what
 * to query and reading results. It still returns the WHOLE document — that is
 * the first rule it is given — so this has to fit a finished itinerary with
 * room to spare, which is what 6000 is. The failure mode is the same as above
 * and just as expensive, so the margin stays generous.
 */
export const ITINERARY_REPAIR_MAX_TOKENS = 6000;

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
  "- You have no search. Everything you need is already in the draft: the posted hours are recorded on each item, and the flight times are on the flight. Reschedule from those. Moving something to a time it is actually open is better than deleting it; deleting it is better than leaving it wrong.",
  "- Keep every rule from the original brief: real links only, never an invented URL, items in ascending `startsAt` order. Do not change the hours in `opensAt`/`closesAt`/`closedDays` — those came from the search and they are the facts you are scheduling around.",
  "- If a place genuinely cannot work on that day, move it to a day it can. If no day works, drop it rather than inventing a replacement you have not looked up; a shorter honest day beats a place that may not exist.",
].join("\n");

/**
 * The second call: the draft, the problems found in it, and nothing else.
 *
 * Sending the whole document back rather than the broken rows alone is the
 * expensive choice and the right one — the fix for "the museum is shut on
 * Monday" is usually to move something else too, and a model that can only see
 * one row cannot do that without inventing a conflict somewhere it cannot see.
 *
 * It does not search, and the draft is why: every problem `checkAvailability`
 * raises is a comparison between two fields that are already in this JSON —
 * an item's `startsAt` against its own `opensAt`, `closesAt` and `closedDays`,
 * or against the flight's `arrivesAt` and `returnsAt`. The pass is re-timing
 * things the first call already found and priced, so the answer is in the
 * document it is handed back, and searching for it again is a second round of
 * web latency buying nothing.
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
