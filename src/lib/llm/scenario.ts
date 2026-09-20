/**
 * The offline scenario generator.
 *
 * `OfflineProvider` exists so the demo survives a dead venue wifi, and for the
 * seeded grad trip it replays a hand-written script. But the demo's last beat is
 * `/judges`, where somebody types *their own* room — four names, four wants,
 * four private ceilings and a topic like "Dinner tonight" — and a script about
 * Cancun is the wrong answer to that. This module is what the offline provider
 * generates from instead: a small, deterministic scenario engine that reads the
 * session it was actually given and builds the same five-beat arc out of it.
 *
 * Three properties it is built around:
 *
 * - **Deterministic.** No clock, no random source, no `Object.keys` ordering.
 *   The same hints always produce the same transcript, which is what lets the
 *   personality-flip beat claim the slider caused the difference.
 * - **The cheap option really is affordable.** The agreed price is derived from
 *   the lowest private ceiling in the room, so the negotiation has a real
 *   resolution and `scoreFairness` can honestly report `nobodyOverruled`.
 * - **No generated public line states a ceiling.** Every price this module puts
 *   in an agent's mouth is pushed out of every participant's proximity window
 *   first, using the same tolerance `lib/negotiation/redaction.ts` enforces. The
 *   guard still runs; it just has nothing to find.
 *
 * ## On privacy
 *
 * `OfflineHints` carries real budget ceilings, which is exactly the thing
 * `docs/ARCHITECTURE.md` rule 1 keeps out of prompts. It is safe here because
 * `CompletionRequest.context` is never read by `AnthropicProvider` — it is an
 * offline-only side channel, never serialized into a message — and because
 * nothing this module returns as a *public* line contains a ceiling. If a live
 * provider ever starts reading `context`, this is the file that has to change.
 *
 * Pure: no I/O, no React, no Node APIs.
 */

import { PARTICIPANT_IDS, type ParticipantId } from "@/lib/characters";
import { NOBODY_OVERRULED_MIN_KEPT_RATIO } from "@/lib/negotiation/fairness";
import { proximityToleranceFor } from "@/lib/negotiation/redaction";
import type { TurnKind } from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* The hints the engine passes                                                 */
/* -------------------------------------------------------------------------- */

/** One seat at the table, as the offline generator needs to see it. */
export interface OfflinePersonHint {
  participantId: ParticipantId;
  /** The cast name the room and the UI use, so a bubble and its name tag agree. */
  name: string;
  /** Their headline want, in their own words. */
  want: string;
  /** Every want they stated; the fairness meter scores against these. */
  wants: string[];
  /** The private ceiling. Never printed in a public line — see the header. */
  ceiling: number | null;
}

/** Everything the offline provider needs to generate a run over this session. */
export interface OfflineHints {
  /** Non-null for the scripted seed run, which the provider replays verbatim. */
  scenarioId: string | null;
  /** The session's trip name: "Grad Trip '27", "Dinner tonight". */
  topic: string;
  /** When it happens, in the humans' own words: "Tonight, 7pm". */
  when: string;
  nights: number | null;
  /** The lowest *public* price-stance ceiling in the room. */
  priceCap: number;
  people: OfflinePersonHint[];
  /** Offer ids already on the table, oldest first. */
  offerIds: string[];
  /** How many lines this speaker has already said. */
  spokenCount: number;
  /** 0 normally; 1 when the engine is nudging the speaker past a repeat. */
  attempt: number;
}

/** One generated line, in the shape `OfflineProvider` hands to the engine. */
export interface ScenarioBeat {
  speaker: ParticipantId;
  kind: TurnKind;
  text: string;
  offer?: Record<string, unknown>;
  privateReasonKept?: string;
}

/* -------------------------------------------------------------------------- */
/* Scenario kinds                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The handful of shapes a typed topic can take. Deliberately small: this is the
 * fallback that runs when there is no model, not a product surface. A topic that
 * matches nothing lands on `outing`, whose copy is written to work for anything
 * four people can disagree about.
 */
export type ScenarioKind = "trip" | "meal" | "night-out" | "outing";

const KIND_KEYWORDS: readonly (readonly [ScenarioKind, readonly string[]])[] = [
  [
    "meal",
    ["dinner", "lunch", "brunch", "breakfast", "restaurant", "meal", "supper",
     "pizza", "sushi", "tacos", "curry", "bbq", "barbecue", "takeout", "eating",
     "food", "table"],
  ],
  [
    "night-out",
    ["night out", "nights out", "bar", "bars", "drinks", "pub", "club", "party",
     "concert", "gig", "karaoke", "bowling", "dancing", "birthday", "show"],
  ],
  [
    "trip",
    ["trip", "travel", "vacation", "holiday", "getaway", "weekend", "retreat",
     "camping", "ski", "tour", "flights", "abroad", "island", "beach",
     "honeymoon", "break"],
  ],
];

/** Word-boundary for a single word, plain containment for a phrase. */
function mentions(text: string, needle: string): boolean {
  if (needle.includes(" ")) return text.includes(needle);
  return new RegExp(`\\b${needle}\\b`, "i").test(text);
}

export function scenarioKindFor(topic: string): ScenarioKind {
  const text = topic.toLowerCase();
  for (const [kind, words] of KIND_KEYWORDS) {
    if (words.some((word) => mentions(text, word))) return kind;
  }
  return "outing";
}

/* -------------------------------------------------------------------------- */
/* Option templates                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One option an agent can put on the table.
 *
 * Every string here is digit-free on purpose. The only number that reaches a
 * spoken line is the price, and that one has been through `safePrice`.
 */
interface OptionTemplate {
  key: string;
  /** The headline, printed on the offer card. */
  label: string;
  /** The specific shape of it, printed under the headline. */
  where: string;
  /** Fills the offer's `lodgingNote` slot; reads as a clause, not a sentence. */
  venueNote: string;
  /** Fills the offer's `flightNote` slot: the logistics nobody argues about. */
  logisticsNote: string;
  /** One thing this option gives everybody, used when the wants run out. */
  highlight: string;
  /** What the room becomes without this option; used in the opener's defence. */
  downgrade: string;
  /** Matched against a person's stated want to pick between templates. */
  tags: readonly string[];
}

interface KindCopy {
  premium: readonly OptionTemplate[];
  budget: readonly OptionTemplate[];
  /** "a head", "a person" — the unit a price is quoted in. */
  perUnit: string;
  /** "the same night", "the same week" — used in the holdout's counter. */
  sameAgain: string;
  /** Whether the option occupies nights. A dinner does not. */
  overnight: boolean;
}

const COPY: Record<ScenarioKind, KindCopy> = {
  trip: {
    perUnit: "a person",
    sameAgain: "same dates",
    overnight: true,
    premium: [
      {
        key: "resort",
        label: "The beach resort",
        where: "Right on the strip",
        venueNote: "a four-star place with the pool from the photos",
        logisticsNote: "One flight, no connection, but it goes out early",
        highlight: "A resort right on the beach",
        downgrade: "four of us in one room with a fan",
        tags: ["resort", "luxury", "nice", "pool", "all-inclusive", "strip", "spa", "hotel", "beach"],
      },
      {
        key: "city",
        label: "The big-city week",
        where: "Downtown, walk everywhere",
        venueNote: "a hotel in the middle of everything",
        logisticsNote: "Direct both ways, and nothing before mid-morning",
        highlight: "Everything within walking distance",
        downgrade: "a week looking at the outside of every building",
        tags: ["city", "museum", "culture", "nightlife", "shopping", "walk", "restaurants"],
      },
    ],
    budget: [
      {
        key: "island",
        label: "The quieter island",
        where: "A ferry ride out from the airport",
        venueNote: "a clean place two streets from the water",
        logisticsNote: "Nothing leaves before late morning",
        highlight: "A beach every day",
        downgrade: "",
        tags: ["beach", "quiet", "cheap", "warm", "island", "sun", "swim", "water", "boat"],
      },
      {
        key: "road",
        label: "The road trip",
        where: "Three stops, one car",
        venueNote: "cabins, and one decent hotel in the middle",
        logisticsNote: "No flights at all, so nobody sets an alarm",
        highlight: "No airports, no early starts",
        downgrade: "",
        tags: ["road", "drive", "car", "camping", "outdoors", "hike", "mountains", "cheap"],
      },
    ],
  },
  meal: {
    perUnit: "a head",
    sameAgain: "same night",
    overnight: false,
    premium: [
      {
        key: "steakhouse",
        label: "The steakhouse on the corner",
        where: "Ten minutes from everyone",
        venueNote: "the one place worth putting a jacket on for",
        logisticsNote: "They’ll hold a table if we call now",
        highlight: "A proper sit-down dinner",
        downgrade: "standing up eating off a paper plate",
        tags: ["steak", "meat", "grill", "dressing up", "dress", "fancy", "nice", "good", "upscale", "classic"],
      },
      {
        key: "tasting",
        label: "The tasting-menu place",
        where: "The room above the market",
        venueNote: "a long menu you don’t get to choose from",
        logisticsNote: "They keep the last table back until the evening",
        highlight: "A proper sit-down dinner",
        downgrade: "a meal nobody will remember",
        tags: ["tasting", "chef", "fine", "wine", "special", "celebrate", "omakase", "sushi", "fancy"],
      },
    ],
    budget: [
      {
        key: "trattoria",
        label: "The little trattoria off the main street",
        where: "Walking distance from everyone",
        venueNote: "paper napkins, and nobody rushes you",
        logisticsNote: "No bookings, but they’ll find four of us a table",
        highlight: "Somewhere you can actually hear each other",
        downgrade: "",
        tags: ["italian", "pasta", "pizza", "cheap", "casual", "walking", "close", "quiet", "vegetarian", "veggie", "vegan", "talk", "family"],
      },
      {
        key: "noodles",
        label: "The noodle place two streets over",
        where: "Round the corner from the bar",
        venueNote: "one room, open kitchen, and it moves fast",
        logisticsNote: "No booking, and there’s a bar next door for the wait",
        highlight: "In and out, then the rest of the night",
        downgrade: "",
        tags: ["noodle", "ramen", "asian", "thai", "spicy", "quick", "street", "bowl", "curry", "dumplings", "cheap"],
      },
    ],
  },
  "night-out": {
    perUnit: "a head",
    sameAgain: "same night",
    overnight: false,
    premium: [
      {
        key: "rooftop",
        label: "The rooftop bar",
        where: "Top of the hotel on the square",
        venueNote: "a real cocktail list and a view worth the lift",
        logisticsNote: "The list closes early, so we’d have to commit now",
        highlight: "A proper bar",
        downgrade: "a plastic cup in a queue",
        tags: ["cocktail", "rooftop", "view", "fancy", "dress", "nice", "classy", "dance", "club"],
      },
      {
        key: "gig",
        label: "The gig at the big room",
        where: "The venue by the station",
        venueNote: "a band people have actually heard of",
        logisticsNote: "Tickets go tonight or they go entirely",
        highlight: "Live music, properly loud",
        downgrade: "a night we could have had any other week",
        tags: ["music", "band", "gig", "concert", "live", "show", "dancing", "loud"],
      },
    ],
    budget: [
      {
        key: "pub",
        label: "The old pub with the back room",
        where: "Round the corner, no queue",
        venueNote: "a back room nobody’s going to move us out of",
        logisticsNote: "No list, no door charge, no booking",
        highlight: "A proper bar with no queue",
        downgrade: "",
        tags: ["pub", "beer", "cheap", "quiet", "talk", "casual", "local", "bar", "reservation", "no queue"],
      },
      {
        key: "karaoke",
        label: "The karaoke place under the arches",
        where: "Two streets from the station",
        venueNote: "a room to ourselves and nobody watching",
        logisticsNote: "They’ll take us whenever we turn up",
        highlight: "A room to ourselves",
        downgrade: "",
        tags: ["karaoke", "sing", "games", "bowling", "fun", "silly", "private", "cheap"],
      },
    ],
  },
  outing: {
    perUnit: "a head",
    sameAgain: "same plan",
    overnight: false,
    premium: [
      {
        key: "full",
        label: "The full version",
        where: "The one everybody posts about",
        venueNote: "the whole thing, properly done, nothing skipped",
        logisticsNote: "Book it and it’s fixed",
        highlight: "The proper version, done once",
        downgrade: "a version of this none of us would remember",
        tags: ["best", "proper", "full", "special", "big", "nice", "good"],
      },
      {
        key: "guided",
        label: "The organised version",
        where: "Somebody else does the planning",
        venueNote: "a guide, a schedule, and nothing left to argue about",
        logisticsNote: "One booking covers all four of us",
        highlight: "Nobody has to organise it",
        downgrade: "four people arguing in a car park",
        tags: ["guide", "tour", "organised", "organized", "planned", "easy", "sorted"],
      },
    ],
    budget: [
      {
        key: "lowkey",
        label: "The low-key version",
        where: "Close to everyone",
        venueNote: "nothing booked, so nothing goes to waste",
        logisticsNote: "No booking; we turn up when we turn up",
        highlight: "Close to everyone and easy to get to",
        downgrade: "",
        tags: ["cheap", "close", "easy", "simple", "quiet", "chill", "relaxed", "walking", "local"],
      },
      {
        key: "diy",
        label: "The do-it-ourselves version",
        where: "Whoever has the most room",
        venueNote: "we bring it, we run it, and it costs almost nothing",
        logisticsNote: "No booking and no clock",
        highlight: "Nothing to book and nothing to lose",
        downgrade: "",
        tags: ["home", "diy", "host", "ourselves", "cook", "potluck", "picnic", "cheap"],
      },
    ],
  },
};

/* -------------------------------------------------------------------------- */
/* Small text helpers                                                          */
/* -------------------------------------------------------------------------- */

function squeeze(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  const clean = squeeze(text);
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function capitalize(text: string): string {
  const clean = squeeze(text);
  if (!clean) return clean;
  return clean[0].toUpperCase() + clean.slice(1);
}

/** Lowercases a want so it can sit mid-sentence, unless it starts with a name. */
function lower(text: string): string {
  const clean = squeeze(text).replace(/[.]+$/, "");
  if (!clean) return clean;
  // A word in Caps that is not the first word suggests a proper noun; leave it.
  if (/^[A-Z][a-z]+ [A-Z]/.test(clean)) return clean;
  return clean[0].toLowerCase() + clean.slice(1);
}

function money(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/** Every number a reader would hear as a figure. Mirrors the redactor's scan. */
const NUMBER_IN_TEXT = /\b\d[\d,]*(?:\.\d{1,2})?\b/g;

/** True when this figure is far enough from the ceiling to be sayable out loud. */
function sayable(value: number, ceiling: number | null): boolean {
  if (ceiling === null) return true;
  return Math.abs(value - ceiling) > proximityToleranceFor(ceiling);
}

/**
 * A human's own words, echoed back into a line they are about to say out loud —
 * or null when saying them would give their ceiling away.
 *
 * Somebody who typed "a bar, nothing over forty-five" as their want has put
 * their own number inside their want. The engine's guard would catch that and
 * redact it, and a sentence with "more than we can do" wedged into the middle of
 * it reads worse than one that never contained the figure. The callers below
 * substitute a neutral phrase instead.
 */
function echoWant(text: string, ceiling: number | null): string | null {
  const clean = squeeze(text);
  if (!clean) return null;
  if (ceiling === null) return clean;
  NUMBER_IN_TEXT.lastIndex = 0;
  for (const match of clean.match(NUMBER_IN_TEXT) ?? []) {
    const value = Number(match.replace(/,/g, ""));
    if (Number.isFinite(value) && !sayable(value, ceiling)) return null;
  }
  return clean;
}

/**
 * The price as an agent may quote it, or null when this speaker cannot.
 *
 * In a room of very small budgets every round number is inside somebody's
 * proximity window, and there is no figure left to say. That is not a failure:
 * an agent saying "not cheap, but" instead of a number is exactly the behaviour
 * the product promises, so the callers below fall back to a qualitative clause.
 */
function sayPrice(value: number, ceiling: number | null): string | null {
  return sayable(value, ceiling) ? money(value) : null;
}

/** Words that carry no meaning when deciding whether two phrases say the same thing. */
const PHRASE_STOP = new Set(["a", "an", "the", "of", "for", "to", "in", "on", "at", "and", "or", "with", "we", "us", "can", "that"]);

function phraseTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !PHRASE_STOP.has(token));
}

/**
 * True when two phrases would read as the same tick on the plan screen.
 *
 * "A resort on the beach" and "A resort right on the beach" are one promise
 * printed twice, and a list that repeats itself looks like a bug rather than a
 * plan.
 */
function tooSimilar(left: string, right: string): boolean {
  const a = new Set(phraseTokens(left));
  const b = new Set(phraseTokens(right));
  if (a.size === 0 || b.size === 0) return left.toLowerCase() === right.toLowerCase();
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const token of small) if (large.has(token)) shared += 1;
  return shared / small.size >= 0.6;
}

/**
 * How many of one person's stated wants the agreed option has to deliver before
 * the fairness meter will say they were not overruled.
 *
 * Derived from `NOBODY_OVERRULED_MIN_KEPT_RATIO` rather than guessed, because
 * the point of generating over the real session is that the room converges: an
 * option that leaves somebody under the threshold is one `findConvergedOffer`
 * refuses, and the run then burns the round cap repeating itself. A private
 * ceiling the plan comes in under is itself a kept want, so it pays for one.
 */
function wantsNeeded(person: OfflinePersonHint): number {
  const total = person.wants.length + (person.ceiling === null ? 0 : 1);
  const required = Math.max(1, Math.ceil(total * NOBODY_OVERRULED_MIN_KEPT_RATIO));
  const paidByCeiling = person.ceiling === null ? 0 : 1;
  return Math.max(0, Math.min(person.wants.length, required - paidByCeiling));
}

/* -------------------------------------------------------------------------- */
/* Prices                                                                      */
/* -------------------------------------------------------------------------- */

/** Round numbers read as real quotes; the unit scales so small ones stay exact. */
function roundingUnit(value: number): number {
  if (value < 60) return 1;
  if (value < 200) return 5;
  if (value < 1000) return 10;
  return 25;
}

/**
 * The nearest price at or below `target` that no agent's proximity guard would
 * flag, for any ceiling in the room.
 *
 * Uses `proximityToleranceFor` rather than its own arithmetic so a change to the
 * guard's window cannot silently make these lines leaky.
 */
function safePrice(target: number, ceilings: readonly number[]): number {
  const unit = roundingUnit(target);
  let value = Math.max(unit, Math.round(target / unit) * unit);
  for (let guard = 0; guard < 500 && value > 0; guard += 1) {
    const clear = ceilings.every(
      (ceiling) => Math.abs(value - ceiling) > proximityToleranceFor(ceiling),
    );
    if (clear) return value;
    value -= unit;
  }
  return Math.max(1, Math.round(target));
}

/* -------------------------------------------------------------------------- */
/* The scenario                                                                */
/* -------------------------------------------------------------------------- */

interface Roles {
  /** Most room on money: opens with the expensive option and trades it away. */
  opener: OfflinePersonHint;
  /** Lowest ceiling: pushes back qualitatively, then counters with the cheap one. */
  holdout: OfflinePersonHint;
  /** Argues for one thing and trades everything else for it. */
  trader: OfflinePersonHint;
  /** Easy to satisfy; spends their turns backing whoever is right. */
  backer: OfflinePersonHint;
}

export interface Scenario {
  kind: ScenarioKind;
  copy: KindCopy;
  roles: Roles;
  premium: Record<string, unknown>;
  agreed: Record<string, unknown>;
  premiumTemplate: OptionTemplate;
  agreedTemplate: OptionTemplate;
  premiumPrice: number;
  agreedPrice: number;
  when: string;
  keptWants: string[];
}

/**
 * Stand-ins for a brief that stated nothing.
 *
 * A brief is empty until its human says something, and the seat in front of
 * the screen starts that way by design. Interpolating the blank produced a
 * private report whose second sentence opened with a full stop and a plan
 * summary that read "Somewhere cheap, the coast, . $540 a person" — a
 * rendering bug dressed up as an agent's own words. Each phrase below reads as
 * a position the agent could plausibly hold, which is the same trade
 * `NO_CONTESTED` and `NO_MINE` make in `components/personality/sampleLine.ts`.
 */
const NO_WANT = "the version that works for all of us";
const NO_WHEN = "whenever suits everyone";

/** Per-kind fallback ceiling, for a room where nobody named a number. */
const DEFAULT_CEILING: Record<ScenarioKind, number> = {
  trip: 900,
  meal: 45,
  "night-out": 60,
  outing: 80,
};

/**
 * Sorted most room on money first, with an unknown ceiling at the *bottom*.
 *
 * A seat that never named a number has not told the room it can spend, and the
 * seat in front of the screen starts exactly there — empty until the human
 * types something. Reading a missing ceiling as the most room therefore cast
 * whoever wrote one sentence with no figure in it as the big spender: they
 * became the `opener`, proposed the expensive option and then had their
 * headline want taken off them as the price of the plan.
 *
 * Sorting it to the other end also settles a disagreement the codebase was
 * carrying. `priceStanceFor(null, …)` in `lib/types.ts` reads a missing ceiling
 * as the tight end of the scale — "must be cheap" for a frugal slider — so the
 * public stance the other agents argue against and the role this module hands
 * out now say the same thing about the same person.
 */
function byCeilingDesc(people: readonly OfflinePersonHint[]): OfflinePersonHint[] {
  const order = new Map(PARTICIPANT_IDS.map((id, index) => [id, index] as const));
  return [...people].sort((a, b) => {
    const left = a.ceiling ?? Number.NEGATIVE_INFINITY;
    const right = b.ceiling ?? Number.NEGATIVE_INFINITY;
    if (left !== right) return right - left;
    // Stable and explicit: two identical ceilings must not swap between runs,
    // and they fall back to the same roster order every other module uses.
    return (order.get(a.participantId) ?? 0) - (order.get(b.participantId) ?? 0);
  });
}

/**
 * This person's headline want, in their own words, or a phrase that reads as a
 * stance when they stated none.
 *
 * `wants[0]` and `want` are both plain strings off the brief and both are `""`
 * on a seat nobody has briefed, so `wants[0] ?? want` — which is what every
 * caller used to write — falls through to the second blank rather than to
 * anything sayable. Total by construction: it never returns an empty string.
 */
function wantOf(person: OfflinePersonHint): string {
  return squeeze(person.wants[0] ?? "") || squeeze(person.want) || NO_WANT;
}

/** Template whose tags best fit this person's words; ties go to the first. */
function pickTemplate(
  templates: readonly OptionTemplate[],
  person: OfflinePersonHint,
): OptionTemplate {
  const text = [person.want, ...person.wants].join(" ").toLowerCase();
  let best = templates[0];
  let bestScore = -1;
  for (const template of templates) {
    let score = 0;
    for (const tag of template.tags) if (text.includes(tag)) score += 1;
    if (score > bestScore) {
      best = template;
      bestScore = score;
    }
  }
  return best;
}

function offerFrom(options: {
  id: string;
  template: OptionTemplate;
  price: number;
  highlights: string[];
  when: string;
  nights: number;
  proposedBy: ParticipantId;
}): Record<string, unknown> {
  return {
    id: options.id,
    destination: options.template.label,
    region: options.template.where,
    dates: options.when,
    nights: options.nights,
    perPerson: options.price,
    highlights: options.highlights,
    flightNote: options.template.logisticsNote,
    lodgingNote: capitalize(options.template.venueNote),
    proposedBy: options.proposedBy,
  };
}

/**
 * Builds the whole scenario from the session's own facts.
 *
 * The shape is the arc `design/03-town.clean.html` shows: the person with the
 * most room opens expensive, the person with the least pushes back without ever
 * saying why, somebody trades for the one thing they came for, and the cheap
 * option that clears everybody's real ceiling wins.
 */
export function buildScenario(hints: OfflineHints): Scenario {
  const kind = scenarioKindFor(hints.topic);
  const copy = COPY[kind];

  const ranked = byCeilingDesc(hints.people);
  const opener = ranked[0];
  const holdout = ranked[ranked.length - 1];
  const trader = ranked.length > 2 ? ranked[1] : ranked[0];
  const backer = ranked.length > 3 ? ranked[2] : ranked[ranked.length - 1];
  const roles: Roles = { opener, holdout, trader, backer };

  const ceilings = hints.people
    .map((person) => person.ceiling)
    .filter((ceiling): ceiling is number => ceiling !== null && Number.isFinite(ceiling));

  const lowest = ceilings.length > 0 ? Math.min(...ceilings) : DEFAULT_CEILING[kind];
  const highest = ceilings.length > 0 ? Math.max(...ceilings) : lowest * 2;

  // Comfortably under the tightest ceiling, and under the public price cap the
  // room's stances imply, so `findConvergedOffer` can actually accept it.
  const agreedPrice = safePrice(Math.min(lowest * 0.7, hints.priceCap * 0.7), ceilings);
  // Over the tightest ceiling by construction: the expensive option has to be
  // one the room argues *down*, never one it can quietly settle on.
  const premiumPrice = Math.max(
    safePrice(Math.max(highest * 0.8, lowest * 1.7), ceilings),
    agreedPrice + roundingUnit(agreedPrice),
  );

  // Resolved once, here, rather than at each of the six places it is printed:
  // the offer cards, the opening proposal, the plan summary and the opener's
  // private report all read `scenario.when`, and a blank in any of them is the
  // same bug rendered in a different font.
  const when = squeeze(hints.when) || NO_WHEN;

  const premiumTemplate = pickTemplate(copy.premium, opener);
  const agreedTemplate = pickTemplate(copy.budget, holdout);

  // Zero, not one: a dinner occupies no nights, and `Offer.nights` is the field
  // the plan header prints. Claiming a single night to keep the number truthy
  // is what produced "Tonight 7pm - 1 nights".
  const nights = copy.overnight ? (hints.nights ?? 5) : 0;

  /**
   * What the affordable option actually delivers, in the humans' own words.
   *
   * Enough of each person's wants to clear the fairness threshold, and for the
   * opener, everything *except* their headline want — that one is the price of
   * the plan, the same shape the seeded run has where Sam loses the resort and
   * keeps the rest. Six at most, because this list is printed as ticks on the
   * plan screen and a longer one stops reading as a plan.
   */
  const KEPT_WANT_CAP = 6;
  const keptWants: string[] = [];
  const pushWant = (candidate: string | undefined): void => {
    if (!candidate) return;
    const value = capitalize(clip(candidate, 56));
    if (!value || keptWants.length >= KEPT_WANT_CAP) return;
    if (keptWants.some((existing) => tooSimilar(existing, value))) return;
    keptWants.push(value);
  };

  // The opener's headline want is the price of this plan, so it is skipped —
  // but only when what is left still clears their own fairness threshold. A
  // person with one want, or with two where the meter needs both, keeps it:
  // better an opener who conceded nothing than a room that cannot converge.
  const openerNeeds = wantsNeeded(opener);
  const openerKeeps =
    opener.wants.length - 1 >= openerNeeds ? opener.wants.slice(1) : opener.wants;
  const rotation: readonly (readonly string[])[] = [
    holdout.wants,
    trader.wants,
    backer.wants,
    openerKeeps,
  ];
  const needed = [wantsNeeded(holdout), wantsNeeded(trader), wantsNeeded(backer), openerNeeds];

  // The minimum that makes the room converge, and no more. Padding this list
  // with wants the option does not actually deliver would buy a greener meter
  // by making it lie, and a meter that claims a clean win where somebody
  // conceded is the exact failure this product exists to prevent. Most people
  // give something up here, which is what the seeded run's meter shows too.
  rotation.forEach((wants, index) => {
    for (const want of wants.slice(0, needed[index])) pushWant(want);
  });
  if (keptWants.length < 3) pushWant(agreedTemplate.highlight);

  const premiumHighlights: string[] = [];
  for (const candidate of [opener.wants[0] ?? opener.want, premiumTemplate.highlight, trader.wants[0]]) {
    if (!candidate) continue;
    const value = capitalize(clip(candidate, 56));
    if (value && !premiumHighlights.some((existing) => tooSimilar(existing, value))) {
      premiumHighlights.push(value);
    }
  }

  const premium = offerFrom({
    id: `offer-${kind}-premium`,
    template: premiumTemplate,
    price: premiumPrice,
    highlights: premiumHighlights,
    when,
    nights,
    proposedBy: opener.participantId,
  });

  const agreed = offerFrom({
    id: `offer-${kind}-agreed`,
    template: agreedTemplate,
    price: agreedPrice,
    highlights: keptWants,
    when,
    nights,
    proposedBy: holdout.participantId,
  });

  return {
    kind,
    copy,
    roles,
    premium,
    agreed,
    premiumTemplate,
    agreedTemplate,
    premiumPrice,
    agreedPrice,
    when,
    keptWants,
  };
}

/* -------------------------------------------------------------------------- */
/* Beats                                                                       */
/* -------------------------------------------------------------------------- */

/** Which of a role's beats this speaker is on, from the state of the table. */
function stepFor(
  role: "opener" | "holdout" | "trader" | "backer",
  hints: OfflineHints,
  scenario: Scenario,
): number {
  const hasOffer = hints.offerIds.length > 0;
  const hasAgreed = hints.offerIds.includes(String(scenario.agreed.id));
  const spoken = Math.max(0, Math.trunc(hints.spokenCount));
  const bump = Math.max(0, Math.trunc(hints.attempt));

  let step: number;
  switch (role) {
    case "opener":
      // 0 propose, 1 defend, 2 concede.
      step = spoken === 0 ? 0 : hasAgreed ? 2 : 1;
      break;
    case "holdout":
      // 0 push back, 1 counter with the affordable option, 2 agree.
      step = hasAgreed ? 2 : !hasOffer ? 0 : spoken === 0 ? 0 : 1;
      break;
    case "trader":
      // 0 name the one thing, 1 trade the price instead, 2 agree.
      step = hasAgreed ? 2 : !hasOffer ? 0 : Math.min(spoken, 1);
      break;
    default:
      // 0 stay out of it, 1 flag the stretch, 2 agree.
      step = hasAgreed ? 2 : !hasOffer ? 0 : 1;
      break;
  }
  return Math.min(step + bump, 2);
}

/**
 * A speaker's nth closing line.
 *
 * The written rungs come first, in the order they read best: the first yes is
 * warm, the second restates it, the third is impatient. Past them the line is
 * composed — one assent plus one tail clause, advancing on two different
 * cycles — so the pool is `written + assents x tails` deep rather than
 * three, and it gets terser as it goes, which is what somebody who has
 * genuinely said their piece sounds like.
 *
 * It used to be a plain rotation of three. Three wraps inside the shipped round
 * cap: a room that ran to five rounds had its last speakers repeat their own
 * first sentence word for word, which on stage is the clearest possible tell
 * that the negotiation is a script rather than an argument.
 *
 * Deterministic, and injective over the pool: indices `0 .. written.length +
 * assents.length * tails.length - 1` each give a different line.
 */
function closingLine(
  index: number,
  written: readonly string[],
  assents: readonly string[],
  tails: readonly string[],
): string {
  const step = Math.max(0, Math.trunc(index));
  if (step < written.length) return squeeze(written[step]);
  const past = step - written.length;
  const assent = assents[past % assents.length];
  const tail = tails[Math.floor(past / assents.length) % tails.length];
  return squeeze(`${assent} ${tail}`);
}

function openerBeat(hints: OfflineHints, scenario: Scenario, step: number): ScenarioBeat {
  const { opener, holdout, trader } = scenario.roles;
  const speaker = opener.participantId;
  const headline =
    echoWant(lower(opener.wants[0] ?? opener.want), opener.ceiling) ?? "the version I came in for";

  if (step === 0) {
    const price = sayPrice(scenario.premiumPrice, opener.ceiling);
    const opening = price
      ? `${price} ${scenario.copy.perUnit}, ${scenario.premiumTemplate.venueNote}`
      : `Not the cheap option, but ${scenario.premiumTemplate.venueNote}`;
    return {
      speaker,
      kind: "proposes",
      text: squeeze(
        `${scenario.premiumTemplate.label} — ${scenario.when}. ${opening}. ${scenario.premiumTemplate.logisticsNote}.`,
      ),
      offer: scenario.premium,
    };
  }

  if (step === 1) {
    const downgrade =
      scenario.premiumTemplate.downgrade || "settling for the version nobody asked for";
    return {
      speaker,
      kind: "pushes back",
      text: squeeze(`${capitalize(headline)} was the whole point. Take that out and we’re ${downgrade}.`),
    };
  }

  const kept =
    echoWant(lower(trader.wants[0] ?? trader.want), opener.ceiling) ??
    echoWant(lower(holdout.want), opener.ceiling) ??
    "the part they actually care about";
  return {
    speaker,
    kind: "agrees",
    text: closingLine(
      hints.spokenCount - 2 + hints.attempt,
      [
        `Fine — ${lower(scenario.agreedTemplate.label)}. I’ll let ${headline} go, as long as ${kept} is real.`,
        `I’ve said my piece about ${headline}. I’m not going to be the one who kills this — book it.`,
        `Still a yes from me. Let’s stop arguing and send it.`,
      ],
      ["Nothing new from me.", "Still a yes.", "Same answer as last round.", "Yes, again."],
      [
        `I’m not re-opening ${headline}.`,
        `${capitalize(lower(scenario.agreedTemplate.label))} is fine by me.`,
        `Somebody book it before I talk myself back into ${headline}.`,
        `I’ve got nothing left to argue about.`,
      ],
    ),
  };
}

function holdoutBeat(hints: OfflineHints, scenario: Scenario, step: number): ScenarioBeat {
  const { holdout, opener } = scenario.roles;
  const speaker = holdout.participantId;
  // The payoff line of the whole product: the reason is recorded, never said.
  const reason = holdout.ceiling === null ? undefined : `$${holdout.ceiling} budget`;

  if (step === 0) {
    const text =
      hints.offerIds.length === 0
        ? `Before anybody books the expensive version — whatever we land on has to work for all four of us, not just whoever has the most room this month.`
        : `${opener.name}’s pick is over what works for us. ${scenario.agreedTemplate.label} does the same job for less.`;
    return { speaker, kind: "pushes back", text: squeeze(text), privateReasonKept: reason };
  }

  if (step === 1) {
    const kept = scenario.keptWants
      .map((want) => echoWant(lower(want), holdout.ceiling))
      .filter((want): want is string => want !== null)
      .slice(0, 2);
    const keptClause = kept.length === 0 ? "" : `, and we keep ${kept.join(" and ")}`;
    const price = sayPrice(scenario.agreedPrice, holdout.ceiling);
    const priceClause = price
      ? `Around ${price} ${scenario.copy.perUnit}`
      : `It comes in well under what is on the table now`;
    return {
      speaker,
      kind: "counters",
      text: squeeze(
        `${scenario.agreedTemplate.label}, ${scenario.copy.sameAgain}. ${priceClause}${keptClause}.`,
      ),
      offer: scenario.agreed,
      privateReasonKept: reason,
    };
  }

  return {
    speaker,
    kind: "agrees",
    text: closingLine(
      hints.spokenCount - 2 + hints.attempt,
      [
        `That’s the one. ${capitalize(scenario.agreedTemplate.where)}, and it works for us. I’m in.`,
        `Nothing’s changed for me — that’s still the one I can say yes to.`,
        `Same answer. Let’s book it before anybody reopens this.`,
      ],
      ["Still in.", "Yes from me.", "No change here.", "Same word as last time."],
      [
        `Nothing on my side has moved.`,
        `${capitalize(lower(scenario.agreedTemplate.label))} is the one I can actually do.`,
        `I’d rather book it than keep talking about it.`,
        `Ask me again and you’ll get this again.`,
      ],
    ),
    privateReasonKept: reason,
  };
}

function traderBeat(hints: OfflineHints, scenario: Scenario, step: number): ScenarioBeat {
  const { trader, opener } = scenario.roles;
  const speaker = trader.participantId;
  const thing =
    echoWant(lower(trader.wants[0] ?? trader.want), trader.ceiling) ?? "the one thing I came in for";

  if (step === 0) {
    const text =
      hints.offerIds.length === 0
        ? `I’ll go along with most of it, as long as ${thing} survives the cut.`
        : `Fine by me, ${opener.name}. But ${thing} isn’t the part we trade.`;
    return { speaker, kind: "trades", text: squeeze(text) };
  }

  if (step === 1) {
    return {
      speaker,
      kind: "trades",
      text: squeeze(`Then we trade the price, not ${thing}. Something cheaper that still gives us that.`),
    };
  }

  return {
    speaker,
    kind: "agrees",
    text: closingLine(
      hints.spokenCount - 2 + hints.attempt,
      [`${capitalize(thing)} is in. Book it.`, `Still in, as long as ${thing} is.`, `Agreed. Send it.`],
      ["Yes.", "Still yes.", "No notes.", "Same from me."],
      [
        `${capitalize(thing)} is on it, and that was the whole ask.`,
        `I’ve got nothing to add to that.`,
        `Book it while everyone’s still saying yes.`,
        `Somebody hit send.`,
      ],
    ),
  };
}

function backerBeat(hints: OfflineHints, scenario: Scenario, step: number): ScenarioBeat {
  const { backer } = scenario.roles;
  const speaker = backer.participantId;
  const thing =
    echoWant(lower(backer.wants[0] ?? backer.want), backer.ceiling) ?? "what I asked for";

  if (step === 0) {
    return {
      speaker,
      kind: "agrees",
      text: `I’m easy. Somebody put something up and I’ll tell you whether it works for me.`,
    };
  }

  if (step === 1) {
    return {
      speaker,
      kind: "pushes back",
      text: `That one’s a stretch for me, and I’d rather not be the reason we don’t go. What else is there?`,
    };
  }

  return {
    speaker,
    kind: "agrees",
    text: closingLine(
      hints.spokenCount - 2 + hints.attempt,
      [
        `That works for me. ${capitalize(thing)}, and nobody had to be talked into it. I’m in.`,
        `Still a yes. Everyone gets something out of that one.`,
        `Agreed. Let’s send it.`,
      ],
      ["Fine by me.", "Still fine by me.", "No objection here.", "Yes, same as before."],
      [
        `I was never the one holding this up.`,
        `${capitalize(thing)} is in there, so I’m good.`,
        `Whenever somebody’s ready to book it.`,
        `I’ll stop saying it now.`,
      ],
    ),
  };
}

/** The line this speaker says, given the table as it stands. */
export function scenarioTurn(
  hints: OfflineHints,
  scenario: Scenario,
  speaker: ParticipantId,
): ScenarioBeat {
  const { opener, holdout, trader } = scenario.roles;
  if (speaker === opener.participantId) {
    return openerBeat(hints, scenario, stepFor("opener", hints, scenario));
  }
  if (speaker === holdout.participantId) {
    return holdoutBeat(hints, scenario, stepFor("holdout", hints, scenario));
  }
  if (speaker === trader.participantId) {
    return traderBeat(hints, scenario, stepFor("trader", hints, scenario));
  }
  return backerBeat(hints, scenario, stepFor("backer", hints, scenario));
}

/* -------------------------------------------------------------------------- */
/* The plan and the reports                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The agreed plan, flattened *and* nested, exactly as the seeded constant is:
 * whichever of the two shapes the caller's schema asks for, the seed already
 * has the fields.
 *
 * The runner-up is the expensive option, because that one really was on the
 * table — the plan screen's "we considered it and dropped it" is only worth
 * printing when it is true.
 */
export function scenarioPlan(scenario: Scenario): Record<string, unknown> {
  const summary = squeeze(
    `${scenario.agreedTemplate.label}, ${scenario.agreed.region}, ${scenario.when}. ${money(scenario.agreedPrice)} ${scenario.copy.perUnit}${scenario.keptWants.length > 0 ? `, and it keeps ${scenario.keptWants.slice(0, 2).map(lower).join(" and ")}` : ""}.`,
  );

  return {
    ...scenario.agreed,
    offer: scenario.agreed,
    runnerUp: scenario.premium,
    runnerUpLostBecause: squeeze(
      `${scenario.premiumTemplate.label} came in at ${money(scenario.premiumPrice)} ${scenario.copy.perUnit}, which was over what the room could actually do.`,
    ),
    groupTotal: scenario.agreedPrice * 4,
    keptWants: scenario.keptWants,
    agreedInMs: 0,
    summary,
  };
}

/**
 * One private debrief. This is the only place a real ceiling is allowed to
 * appear, and the reason is the same as in `buildPrivateReportPrompt`: it has
 * exactly one reader, the person whose number it is.
 */
export function scenarioReport(
  scenario: Scenario,
  speaker: ParticipantId,
): Record<string, unknown> {
  const { opener, holdout, trader, backer } = scenario.roles;
  const price = money(scenario.agreedPrice);
  const unit = scenario.copy.perUnit;
  const label = scenario.agreedTemplate.label;

  const base = { participantId: speaker, secretsKept: [] as string[] };

  if (speaker === opener.participantId) {
    return {
      ...base,
      gotYou: squeeze(`${label}, ${scenario.when}, at ${price} ${unit} — and three other people who’ll actually turn up.`),
      tradedAway: squeeze(`${capitalize(lower(wantOf(opener)))}. That’s the one you lose here, and you should hear it from me rather than read it off the plan.`),
      why: squeeze(
        `${scenario.premiumTemplate.label} was never going to clear everyone at ${money(scenario.premiumPrice)} ${unit}. I held it into the second round, then traded it for ${lower(wantOf(trader))} and a price nobody had to argue with.`,
      ),
    };
  }

  if (speaker === holdout.participantId) {
    const under =
      holdout.ceiling === null
        ? ""
        : `, ${money(Math.max(0, holdout.ceiling - scenario.agreedPrice))} under your number`;
    return {
      ...base,
      gotYou: squeeze(`${price} ${unit}${under}. ${scenario.keptWants[0] ?? label}, and nothing you said you couldn’t do.`),
      tradedAway: squeeze(`${opener.name} wanted ${lower(scenario.premiumTemplate.label)}; you get ${lower(label)} instead. That’s the only thing that moved.`),
      why: squeeze(
        `${trader.name}’s agent wouldn’t budge on ${lower(wantOf(trader))}, so I let ${opener.name}’s version go rather than your money. Out there I only ever said it was over what works for us. Nobody heard your number.`,
      ),
    };
  }

  if (speaker === trader.participantId) {
    return {
      ...base,
      gotYou: squeeze(`${capitalize(lower(wantOf(trader)))}, in writing, at ${price} ${unit}.`),
      tradedAway: squeeze(`${capitalize(lower(scenario.premiumTemplate.label))}. You’d have taken it; other people at the table couldn’t.`),
      why: squeeze(
        `${opener.name}’s agent traded the expensive version to keep the one thing you said you’d be annoyed to lose, so I spent every turn I had holding that and let the rest go.`,
      ),
    };
  }

  return {
    ...base,
    gotYou: squeeze(`${capitalize(lower(wantOf(backer)))}, at ${price} ${unit}. Everything you actually asked for.`),
    tradedAway: squeeze(`Nothing. You were the cheapest person in the room to satisfy and it cost you no ground.`),
    why: squeeze(
      `${label} cleared what you wanted on its own, so I spent my turns backing ${holdout.name}’s side instead of arguing for you.`,
    ),
  };
}
