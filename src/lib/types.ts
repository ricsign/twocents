/**
 * The domain model for twocents.ai.
 *
 * Every shape here is defined once as a zod schema and the TypeScript type is
 * inferred from it. The reason is the LLM: the negotiation engine asks a model
 * for JSON, and the same definition that types the UI has to be able to reject
 * a malformed offer at runtime. One source of truth, two jobs.
 *
 * This file is imported from both server routes and client components, so it
 * holds no I/O, no React and no Node APIs.
 */

import { z } from "zod";
import {
  PARTICIPANT_IDS,
  type DisplayNames,
  type ParticipantId,
} from "@/lib/characters";

/**
 * Runtime gate for the four fixed friends. Built from the same tuple the UI
 * iterates, so adding a fifth character can never leave validation behind.
 */
export const participantIdSchema = z.enum(PARTICIPANT_IDS);

/* -------------------------------------------------------------------------- */
/* 1. Personality                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The four sliders the human drags on the personality screen. Each runs 0-100
 * from the first named pole to the second; the midpoint is a real answer, not
 * an absence of one.
 */
export const personalitySchema = z.object({
  /** 0 easygoing, 100 stubborn. Governs how long the agent holds a position. */
  stubborn: z.number().min(0).max(100),
  /** 0 frugal, 100 splurgy. Governs what it trades money away for. */
  splurgy: z.number().min(0).max(100),
  /** 0 diplomatic, 100 blunt. Governs word choice, never content. */
  blunt: z.number().min(0).max(100),
  /** 0 cautious, 100 adventurous. Governs appetite for the unfamiliar option. */
  adventurous: z.number().min(0).max(100),
  /** One or two sentences in the human's own words. Quoted into the prompt. */
  bio: z.string(),
});

/** How one person's agent behaves in the room. */
export type Personality = z.infer<typeof personalitySchema>;

/**
 * Slider thresholds, named once. The demo's "personality flip" moment depends
 * on these being the only place a number decides a behaviour, so a judge
 * dragging a slider crosses a boundary we can point at.
 */
export const PERSONALITY_THRESHOLDS = {
  /** At or above: the trait reads as strongly present. */
  high: 70,
  /** At or above (but below `high`): the trait leans present. */
  lean: 55,
  /** At or below: the opposite pole reads as strongly present. */
  low: 30,
  /** At or below (but above `low`): the opposite pole leans present. */
  leanLow: 45,
} as const;

/**
 * Starting points offered as one-tap buttons, so briefing an agent stays under
 * the one-minute budget the demo script allows.
 */
export const PERSONALITY_PRESETS: Record<string, Personality> = {
  diplomat: {
    stubborn: 40,
    splurgy: 50,
    blunt: 20,
    adventurous: 55,
    bio: "Reads the room first. Would rather find the trade than win the point.",
  },
  bulldog: {
    stubborn: 88,
    splurgy: 60,
    blunt: 85,
    adventurous: 70,
    bio: "Says the thing nobody wants to say. Does not let a bad plan pass.",
  },
  pennyPincher: {
    stubborn: 72,
    splurgy: 8,
    blunt: 55,
    adventurous: 30,
    bio: "Counts every dollar. Will take the worse flight to save the money.",
  },
};

/**
 * Turns the sliders into one line of plain instruction for the system prompt.
 * Kept here rather than in the prompt file because the same string is shown to
 * the human as a live "voice preview" on the personality screen, and the two
 * must never drift apart.
 */
export function describePersonality(p: Personality): string {
  const t = PERSONALITY_THRESHOLDS;
  const clauses: string[] = [];

  if (p.stubborn >= t.high) clauses.push("Holds its position hard");
  else if (p.stubborn >= t.lean) clauses.push("Gives ground slowly");
  else if (p.stubborn <= t.low) clauses.push("Folds early to keep the peace");
  else clauses.push("Gives ground when the trade is fair");

  if (p.blunt >= t.high) clauses.push("says it flat, no cushioning");
  else if (p.blunt >= t.lean) clauses.push("opens diplomatically but gets blunt under pressure");
  else if (p.blunt <= t.low) clauses.push("stays warm even while refusing");
  else clauses.push("keeps it polite and direct");

  if (p.splurgy <= t.low) clauses.push("protects money over comfort");
  else if (p.splurgy <= t.leanLow) clauses.push("watches the per-person number");
  else if (p.splurgy >= t.high) clauses.push("will pay up for the better version");
  else clauses.push("spends where it buys something real");

  if (p.adventurous >= t.high) clauses.push("pushes for the option nobody has done");
  else if (p.adventurous <= t.low) clauses.push("wants the known quantity");

  const voice = clauses.join("; ") + ".";
  return p.bio.trim() ? `${voice} In their own words: "${p.bio.trim()}"` : voice;
}

/* -------------------------------------------------------------------------- */
/* 2. Brief                                                                    */
/* -------------------------------------------------------------------------- */

/** One line of the private briefing chat, kept so the agent can re-read it. */
export const briefMessageSchema = z.object({
  role: z.enum(["agent", "human"]),
  text: z.string(),
  /**
   * The badge under an agent line: "Kept private: $600 budget".
   *
   * Stored on the message rather than recomputed on render because the label
   * belongs to the turn that earned it. A reload that re-derived it from the
   * finished brief would stamp it on every agent line at once, and the moment
   * the demo is selling is the one line where the agent says it will sit on
   * the number.
   */
  keptPrivate: z.string().optional(),
});

/** A single turn of the briefing conversation. */
export type BriefMessage = z.infer<typeof briefMessageSchema>;

/**
 * Everything one person told their agent in private. This object is the thing
 * that must never reach a public prompt intact: the engine derives a
 * `PublicMandate` from it and keeps the brief in that one agent's context.
 */
export const briefSchema = z.object({
  participantId: participantIdSchema,
  /** Where they said they want to go, in their words. */
  destinationWant: z.string(),
  /** Free text on purpose: "Mar 14-19" beats a date picker in a 60s briefing. */
  dates: z.string(),
  /** Null until the agent has pinned it down. */
  nights: z.number().nullable(),
  /** THE SECRET. The number nobody says in the group chat. */
  budgetCeiling: z.number().nullable(),
  /** False lets a frank person opt out of the whole redaction dance. */
  budgetIsPrivate: z.boolean(),
  /** Hard nos. Arguable in the open unless marked private. */
  dealbreakers: z.array(z.string()),
  /** What a good trip gives them. The fairness meter scores against these. */
  wants: z.array(z.string()),
  /** Loose context the agent may use but not necessarily repeat. */
  notes: z.array(z.string()),
  /** The chat as it happened, so the brief can be re-derived or shown back. */
  rawTranscript: z.array(briefMessageSchema),
});

/** What one person told their agent, in private. */
export type Brief = z.infer<typeof briefSchema>;

/**
 * Prefix a human (or the briefing agent) can put on a dealbreaker or note to
 * mark it unsayable. Gives the "personal" secret kind a deterministic source
 * rather than asking a model to guess what is sensitive.
 */
export const PRIVATE_MARKER = "private:";

/** True when a line was explicitly marked as not-for-the-room. */
export function isPrivateLine(line: string): boolean {
  return line.trim().toLowerCase().startsWith(PRIVATE_MARKER);
}

/** Strips the marker so the text can be used as a secret's label. */
export function stripPrivateMarker(line: string): string {
  return isPrivateLine(line) ? line.trim().slice(PRIVATE_MARKER.length).trim() : line.trim();
}

/* -------------------------------------------------------------------------- */
/* 3. Secret                                                                   */
/* -------------------------------------------------------------------------- */

/** Why a thing is secret, which decides how the redactor phrases the block. */
export const secretKindSchema = z.enum(["budget", "dealbreaker", "personal"]);

/** The three reasons an agent holds something back. */
export type SecretKind = z.infer<typeof secretKindSchema>;

/**
 * One thing the agent must never say out loud. Explicit rather than implied by
 * the brief, because `lib/negotiation/redaction.ts` scans generated lines
 * against this list and re-rolls on a hit. The guarantee lives in code.
 */
export const secretSchema = z.object({
  id: z.string(),
  kind: secretKindSchema,
  /** Human-facing, shown on the plan screen: "Kept private: $600 budget". */
  label: z.string(),
  /** The literal that must never appear in a public line. */
  value: z.union([z.string(), z.number()]),
  /** Other spellings of the same fact: "600", "six hundred", "$600". */
  neverSay: z.array(z.string()),
});

/** A fact the agent knows and will not say. */
export type Secret = z.infer<typeof secretSchema>;

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];
const TENS = [
  "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
];

/**
 * Spells a budget in words so the redactor can also catch an agent that tries
 * "about six hundred". Only covers 0-9999, which is every trip budget the demo
 * will ever see.
 */
function spellNumber(n: number): string {
  const v = Math.round(Math.abs(n));
  if (v >= 10000) return String(v);
  if (v < 20) return ONES[v];
  if (v < 100) {
    const rest = v % 10;
    return rest === 0 ? TENS[Math.floor(v / 10)] : `${TENS[Math.floor(v / 10)]}-${ONES[rest]}`;
  }
  if (v < 1000) {
    const rest = v % 100;
    const head = `${ONES[Math.floor(v / 100)]} hundred`;
    return rest === 0 ? head : `${head} ${spellNumber(rest)}`;
  }
  const rest = v % 1000;
  const head = `${spellNumber(Math.floor(v / 1000))} thousand`;
  return rest === 0 ? head : `${head} ${spellNumber(rest)}`;
}

/**
 * Derives the block list from a brief. Deterministic on purpose: the demo
 * promise is "your agent will never say the number", and a promise a model
 * decides case by case is not a promise.
 */
export function secretsFromBrief(brief: Brief): Secret[] {
  const secrets: Secret[] = [];

  if (brief.budgetIsPrivate && brief.budgetCeiling !== null) {
    const n = brief.budgetCeiling;
    secrets.push({
      id: `${brief.participantId}-budget`,
      kind: "budget",
      label: `$${n} budget`,
      value: n,
      // Deduped: for small numbers the grouped and plain forms coincide.
      neverSay: Array.from(
        new Set([
          String(n),
          `$${n}`,
          `${n} dollars`,
          n.toLocaleString("en-US"),
          `$${n.toLocaleString("en-US")}`,
          spellNumber(n),
          `${spellNumber(n)} dollars`,
        ]),
      ),
    });
  }

  brief.dealbreakers.filter(isPrivateLine).forEach((line, i) => {
    const text = stripPrivateMarker(line);
    secrets.push({
      id: `${brief.participantId}-dealbreaker-${i}`,
      kind: "dealbreaker",
      label: text,
      value: text,
      neverSay: [text],
    });
  });

  brief.notes.filter(isPrivateLine).forEach((line, i) => {
    const text = stripPrivateMarker(line);
    secrets.push({
      id: `${brief.participantId}-personal-${i}`,
      kind: "personal",
      label: text,
      value: text,
      neverSay: [text],
    });
  });

  return secrets;
}

/* -------------------------------------------------------------------------- */
/* 4. PublicMandate                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The budget, said the way a person says it at a table. This is the swap that
 * makes the whole product work: a ceiling becomes a stance, and the stance is
 * arguable without being revealing.
 */
export const priceStanceSchema = z.enum([
  "must be cheap",
  "prefers value",
  "flexible",
  "happy to splurge",
]);

/** How an agent may talk about money in the open. */
export type PriceStance = z.infer<typeof priceStanceSchema>;

/**
 * The only view of a person the negotiation prompt ever sees. Anything absent
 * here cannot leak, because it was never in the context that generated the
 * public line.
 */
export const publicMandateSchema = z.object({
  participantId: participantIdSchema,
  destinationWant: z.string(),
  dates: z.string(),
  nights: z.number().nullable(),
  /** The qualitative stand-in for `Brief.budgetCeiling`. */
  priceStance: priceStanceSchema,
  /** Public dealbreakers only; the private ones became `Secret`s. */
  dealbreakers: z.array(z.string()),
  /** What to fight for, and what fairness later scores. */
  wants: z.array(z.string()),
  /** `describePersonality` output, so the agent sounds like its human. */
  voiceNote: z.string(),
});

/** What an agent is allowed to argue from in the open. */
export type PublicMandate = z.infer<typeof publicMandateSchema>;

/**
 * Per-person totals, in USD, that separate one stance from the next. Named so
 * the mapping from a real number to a public posture is auditable.
 */
export const PRICE_STANCE_BANDS = {
  /** At or below: "must be cheap". */
  cheapMax: 850,
  /** At or below: "prefers value". */
  valueMax: 1500,
  /** At or below: "flexible". Above it: "happy to splurge". */
  flexibleMax: 2600,
} as const;

/**
 * Collapses a real ceiling plus the frugal/splurgy slider into a sayable
 * stance. Personality gets a vote because two people with the same ceiling do
 * not hold it the same way at a table.
 */
export function priceStanceFor(
  budgetCeiling: number | null,
  personality: Personality,
): PriceStance {
  const t = PERSONALITY_THRESHOLDS;
  if (budgetCeiling === null) {
    if (personality.splurgy >= t.high) return "happy to splurge";
    if (personality.splurgy <= t.low) return "must be cheap";
    if (personality.splurgy <= t.leanLow) return "prefers value";
    return "flexible";
  }

  const base: PriceStance =
    budgetCeiling <= PRICE_STANCE_BANDS.cheapMax
      ? "must be cheap"
      : budgetCeiling <= PRICE_STANCE_BANDS.valueMax
        ? "prefers value"
        : budgetCeiling <= PRICE_STANCE_BANDS.flexibleMax
          ? "flexible"
          : "happy to splurge";

  // A frugal person with room to spare still argues like a frugal person.
  if (personality.splurgy <= t.low && base === "flexible") return "prefers value";
  if (personality.splurgy <= t.low && base === "happy to splurge") return "flexible";
  if (personality.splurgy >= t.high && base === "prefers value") return "flexible";
  return base;
}

/**
 * Builds the sanitized mandate. The engine calls this instead of ever handing
 * a `Brief` to a shared prompt; rule 1 in `docs/ARCHITECTURE.md`.
 */
export function mandateFromBrief(
  brief: Brief,
  personality: Personality,
): PublicMandate {
  return {
    participantId: brief.participantId,
    destinationWant: brief.destinationWant,
    dates: brief.dates,
    nights: brief.nights,
    priceStance: priceStanceFor(brief.budgetCeiling, personality),
    dealbreakers: brief.dealbreakers.filter((d) => !isPrivateLine(d)),
    wants: brief.wants,
    voiceNote: describePersonality(personality),
  };
}

/* -------------------------------------------------------------------------- */
/* 5. Offer                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A concrete proposal on the table. Deliberately a whole trip rather than a
 * field-by-field itinerary: agents trade entire options, which is what makes
 * the transcript readable in the ten seconds a judge gives it.
 */
/**
 * What the live web said about an offer.
 *
 * Attached by the engine after the line was spoken, never taken from the agent
 * that proposed it — a model grading its own price is not evidence, for the
 * same reason `secretsKept` and `groupTotal` are computed rather than
 * generated. See `lib/negotiation/feasibility.ts`.
 */
/**
 * One page a live search actually opened.
 *
 * Distinct from the bare `sources` host list below, which is the model's own
 * account of where it looked. These come back from the API alongside the
 * answer, so they are pages that were fetched — which is what makes them safe
 * to render as a link a person can click from the transcript.
 */
export const searchSourceSchema = z.object({
  title: z.string(),
  url: z.string(),
  host: z.string(),
});

/** A page a search opened. */
export type SearchSource = z.infer<typeof searchSourceSchema>;

export const offerFeasibilitySchema = z.object({
  /** False only when the claimed price is clearly out of reach. */
  bookable: z.boolean(),
  /** The all-in per-person figure the search supports, or null if it found none. */
  realisticPerPerson: z.number().nullable(),
  /** One short sentence, written to be read aloud at the table. */
  note: z.string(),
  /** Bare host names behind the verdict. Empty when nothing was searched. */
  sources: z.array(z.string()),
  /**
   * The pages the check opened, as the API reported them.
   *
   * Defaulted rather than required because sessions written by an earlier build
   * are read back from disk through this schema, and a missing field should
   * mean "no links recorded", not "throw the whole session away".
   */
  links: z.array(searchSourceSchema).default([]),
});

/** The verdict on one offer. */
export type OfferFeasibility = z.infer<typeof offerFeasibilitySchema>;

export const offerSchema = z.object({
  id: z.string(),
  /** Headline, as printed on the offer card: "Puerto Rico". */
  destination: z.string(),
  /** The specific shape of it: "San Juan + Culebra". */
  region: z.string(),
  dates: z.string(),
  nights: z.number(),
  /** All-in per person, USD. The number the Ramp story is told with. */
  perPerson: z.number(),
  /** Three or four short phrases; these become the fairness `keptWants`. */
  highlights: z.array(z.string()),
  flightNote: z.string(),
  lodgingNote: z.string(),
  /** Whose agent put it on the table. Drives the card's name tag colour. */
  proposedBy: participantIdSchema,
  /** Set by the engine, not the proposer. Absent until the check has run. */
  feasibility: offerFeasibilitySchema.optional(),
});

/** One trip proposal. */
export type Offer = z.infer<typeof offerSchema>;

/* -------------------------------------------------------------------------- */
/* 6. NegotiationTurn                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The verb printed next to the agent's name in the transcript. These strings
 * are rendered verbatim, so they are lowercase and already in the right tense.
 */
export const turnKindSchema = z.enum([
  "proposes",
  "pushes back",
  "trades",
  "counters",
  "agrees",
]);

/** What an agent just did. */
export type TurnKind = z.infer<typeof turnKindSchema>;

/**
 * One line of the public negotiation. `privateReasonKept` is the demo's payoff:
 * it records the real reason behind the line so the plan screen can show "kept
 * private: $600 budget" beside a sentence that never mentioned money.
 */
/**
 * A line's receipt: the sentence to print and the pages behind it.
 *
 * Shared by the stored turn and the `speak` frame, so what the town renders
 * live and what the transcript renders on a reload can never disagree.
 */
export const negotiationSourcedSchema = z.object({
  /** "A quick web search shows nonstop flights from $340." */
  note: z.string(),
  links: z.array(searchSourceSchema),
});

/** What a line is sourced on. */
export type NegotiationSourced = z.infer<typeof negotiationSourcedSchema>;

export const negotiationTurnSchema = z.object({
  id: z.string(),
  round: z.number(),
  speaker: participantIdSchema,
  kind: turnKindSchema,
  /** The redacted, spoken line. Goes in the speech bubble and the transcript. */
  text: z.string(),
  /** Set when this turn put a new option on the table. */
  offer: offerSchema.optional(),
  /** Never shown in the room; surfaced only to the speaker's own human. */
  privateReasonKept: z.string().optional(),
  /**
   * Where this line's facts came from, when it has any.
   *
   * Set by the engine — never by the model — on a turn whose option was priced
   * against the live web, and rendered in the transcript as a sentence plus the
   * pages behind it. An agent that says "a quick web search shows" and cannot
   * show you the search is exactly the thing this product is arguing against.
   *
   * Written when the check lands rather than when the line is spoken: the
   * engine does not hold the room for a web search, so this field appears on
   * a turn that already exists, carried by an `offer-checked` frame.
   */
  sourced: negotiationSourcedSchema.optional(),
});

/** One line in the transcript. */
export type NegotiationTurn = z.infer<typeof negotiationTurnSchema>;

/* -------------------------------------------------------------------------- */
/* 7. Plan                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What the agents settled on. Carries the runner-up and why it lost, because
 * "we considered this and dropped it for that reason" is what makes the group
 * trust a decision they did not make themselves.
 */
export const planSchema = z.object({
  offer: offerSchema,
  runnerUp: offerSchema.nullable(),
  /** One sentence. Empty when there was no runner-up. */
  runnerUpLostBecause: z.string(),
  /** `offer.perPerson` times the party size, precomputed for the plan screen. */
  groupTotal: z.number(),
  /** The wants, across all four people, this plan actually delivers. */
  keptWants: z.array(z.string()),
  /** Wall-clock length of the negotiation: the "three weeks to 90s" number. */
  agreedInMs: z.number(),
});

/** The agreed outcome. */
export type Plan = z.infer<typeof planSchema>;

/* -------------------------------------------------------------------------- */
/* 8. Fairness                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One person's bar on the fairness meter. `gaveUp` is named explicitly so the
 * meter can be honest: a plan where somebody conceded is fine, a plan where
 * somebody conceded silently is the failure mode this product exists to fix.
 */
export const fairnessRowSchema = z.object({
  participantId: participantIdSchema,
  wantsKept: z.number(),
  wantsTotal: z.number(),
  /** The one thing they lost, in their own framing. Null when they lost nothing. */
  gaveUp: z.string().nullable(),
});

/** One row of the fairness meter. */
export type FairnessRow = z.infer<typeof fairnessRowSchema>;

/**
 * The claim the plan screen makes out loud. `nobodyOverruled` is computed, not
 * asserted by the model, so the badge cannot lie.
 */
export const fairnessReportSchema = z.object({
  rows: z.array(fairnessRowSchema),
  /** False if any person kept none of their wants. */
  nobodyOverruled: z.boolean(),
});

/** The fairness meter, whole. */
export type FairnessReport = z.infer<typeof fairnessReportSchema>;

/* -------------------------------------------------------------------------- */
/* 9. AgentReport                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The private note one agent writes to its own human after the room clears.
 * Structured into got/traded/why rather than free prose so every person gets
 * the same three answers and the screen can render four of them side by side.
 */
export const agentReportSchema = z.object({
  participantId: participantIdSchema,
  /** "You got the beach days and the Thursday flight." */
  gotYou: z.string(),
  /** "I let go of the extra night." */
  tradedAway: z.string(),
  /** The reasoning, including the private reason it could not say in the room. */
  why: z.string(),
  /** `Secret.label` for each secret held: "$600 budget". The proof of the pitch. */
  secretsKept: z.array(z.string()),
});

/** An agent's private debrief to its human. */
export type AgentReport = z.infer<typeof agentReportSchema>;

/* -------------------------------------------------------------------------- */
/* 10. Usage                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Token accounting for one run. Tracked because the plan screen shows a real
 * cost figure, and because the small-model-for-banter / large-model-for-the-plan
 * split is only a claim if we can print the number.
 */
export const usageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  /** How many provider round trips. Rounds are capped, so this is bounded. */
  calls: z.number(),
  estimatedCostUsd: z.number(),
  /** Every model id that contributed, deduped. Usually one haiku, one sonnet. */
  model: z.array(z.string()),
});

/** Token and cost accounting for a run. */
export type Usage = z.infer<typeof usageSchema>;

/**
 * Hard ceiling on negotiation rounds. Bounds cost, bounds latency, and bounds
 * the demo: five rounds is roughly the 45 seconds the Town screen has.
 */
export const NEGOTIATION_ROUND_CAP = 5;

/** A run that has made no calls yet. */
export const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  calls: 0,
  estimatedCostUsd: 0,
  model: [],
};

/**
 * Folds one call's usage into the running total. Pure and associative so the
 * engine can accumulate it inside the stream without holding a mutable tally.
 */
export function sumUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    calls: a.calls + b.calls,
    estimatedCostUsd: a.estimatedCostUsd + b.estimatedCostUsd,
    model: Array.from(new Set([...a.model, ...b.model])),
  };
}

/* -------------------------------------------------------------------------- */
/* 11. NegotiationEvent                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The SSE wire format for `/api/negotiate`, one variant per row of the event
 * table in `docs/ARCHITECTURE.md`. The Town screen validates each frame with
 * this before touching state, so a malformed stream degrades to a dropped
 * bubble rather than a broken room.
 */
export const negotiationEventSchema = z.discriminatedUnion("type", [
  /** A new round started. `of` is `NEGOTIATION_ROUND_CAP`. */
  z.object({
    type: z.literal("round"),
    round: z.number(),
    of: z.number(),
  }),
  /** This agent is composing; the UI shows the blinking dots above its head. */
  z.object({
    type: z.literal("thinking"),
    speaker: participantIdSchema,
  }),
  /** A redacted public line. Becomes a speech bubble and a transcript row. */
  z.object({
    type: z.literal("speak"),
    speaker: participantIdSchema,
    kind: turnKindSchema,
    text: z.string(),
    privateReasonKept: z.string().optional(),
  }),
  /** A new option hit the table; the UI slides in an offer card. */
  z.object({
    type: z.literal("offer"),
    speaker: participantIdSchema,
    offer: offerSchema,
  }),
  /**
   * The web's verdict on an option that is already on the table.
   *
   * A patch, not a new row. The offer frame above is emitted the moment the
   * agent proposes, without waiting for the price check, because a room that
   * freezes for the length of two web searches every time somebody names a
   * number is a room nobody watches. The verdict follows whenever it lands and
   * the card it belongs to fills in — which is why this carries an `offerId`
   * rather than a speaker: the consumer's job is to find that offer and patch
   * it, not to append anything.
   *
   * `sourced` is the same sentence-plus-links block a turn carries, built here
   * so the transcript row and the card cannot come apart; absent when the
   * check opened no pages, which is what stops an unchecked offer from
   * claiming a search.
   */
  z.object({
    type: z.literal("offer-checked"),
    offerId: z.string(),
    feasibility: offerFeasibilitySchema,
    sourced: negotiationSourcedSchema.optional(),
  }),
  /**
   * Consensus. The Town screen starts its transition to the plan.
   *
   * Emitted the instant the round loop settles, from the offer it settled on,
   * before any of the finalisation calls have run. The plan on it is therefore
   * the offer itself rather than the written-up version: the same trip, the
   * same price, without the prose. `done` carries the finished one.
   */
  z.object({
    type: z.literal("agreed"),
    plan: planSchema,
    runnerUp: offerSchema.nullable(),
    /**
     * The meter, scored at the same instant.
     *
     * Carried on this frame because the plan screen renders only when it has
     * a plan *and* a fairness report, and scoring is local arithmetic that
     * costs nothing to do here. Without it the screen would hold the plan and
     * still show nothing until `done` landed, which is the wait this frame
     * exists to end. Public, like the rest of this frame: the same rows go to
     * all four people on the shared plan screen.
     */
    fairness: fairnessReportSchema,
  }),
  /** Terminal frame: everything the plan screen needs, in one payload. */
  z.object({
    type: z.literal("done"),
    fairness: fairnessReportSchema,
    /**
     * Partial, not exhaustive, because the wire form is narrowed.
     *
     * The engine always fills all four — it wrote them and the session stores
     * them — but `/api/negotiate` sends each frame through `eventForViewer`,
     * and what reaches a browser is the one report belonging to the viewer.
     * An exhaustive record would make the honest frame fail its own schema.
     */
    reports: z.partialRecord(participantIdSchema, agentReportSchema),
    usage: usageSchema,
    elapsedMs: z.number(),
    /**
     * The written-up plan, replacing the provisional one from `agreed`.
     *
     * Same offer — the engine pins it to what the room converged on — with the
     * runner-up, the sentence saying why it lost and the kept wants the model
     * wrote. Optional because a run that produced no plan at all still ends in
     * this frame.
     */
    plan: planSchema.optional(),
    runnerUp: offerSchema.nullable().optional(),
  }),
]);

/** One frame of the negotiation stream. */
export type NegotiationEvent = z.infer<typeof negotiationEventSchema>;

/* -------------------------------------------------------------------------- */
/* 11b. Itinerary                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One thing you can click, with the site it came from.
 *
 * `host` is stored next to `url` rather than derived at render time because the
 * PDF prints the host as the visible text — a forty-character booking URL on a
 * page is unreadable, and "expedia.com" is the part a person checks before they
 * click.
 */
export const itineraryLinkSchema = z.object({
  label: z.string(),
  url: z.string(),
  host: z.string(),
});

/** One line of a day: a time, what happens, what it costs, where to book it. */
export const itineraryItemSchema = z.object({
  /** "9:00am", or "" for something that has no clock time. */
  time: z.string(),
  title: z.string(),
  detail: z.string(),
  /** Per person, USD. Null for the things that are free. */
  costPerPerson: z.number().nullable(),
  link: itineraryLinkSchema.nullable(),
});

export const itineraryDaySchema = z.object({
  day: z.number(),
  /** "Sat, Mar 14" — printed, never parsed. */
  date: z.string(),
  title: z.string(),
  items: z.array(itineraryItemSchema),
  /** Per person for this day, USD. Computed from the items, not asserted. */
  subtotalPerPerson: z.number(),
  /**
   * A real photograph of this place, already fetched and checked. Null when
   * nothing usable came back, which the PDF renders as a plain band rather than
   * a broken box.
   */
  photo: z
    .object({
      /** Data URI. Embedded rather than linked so the PDF works offline. */
      dataUri: z.string(),
      /** The Commons file page, printed as the credit line. */
      creditUrl: z.string(),
      credit: z.string(),
    })
    .nullable(),
});

/**
 * What the availability pass did, so the document can say it out loud.
 *
 * The page claims the times in it were checked against posted opening hours,
 * and a claim like that has to be answerable: these are the counts behind it.
 * Optional because a session written before the pass existed is read back
 * through this schema, and a missing field means "not checked", which is what
 * the UI then says.
 */
export const itineraryChecksSchema = z.object({
  /** How many dated rows went through the check. */
  itemsChecked: z.number(),
  /** How many the repair pass put right. */
  repaired: z.number(),
  /** How many were dropped because they could not be put right. */
  dropped: z.number(),
  /** What is still wrong, in sentences, for the page to print plainly. */
  unresolved: z.array(z.string()),
});

/** The availability pass's receipt. */
export type ItineraryChecks = z.infer<typeof itineraryChecksSchema>;

export const itinerarySchema = z.object({
  destination: z.string(),
  region: z.string(),
  dates: z.string(),
  nights: z.number(),
  /** One sentence under the title. The trip in a line. */
  headline: z.string(),
  flights: itineraryItemSchema,
  lodging: itineraryItemSchema,
  days: z.array(itineraryDaySchema),
  /** Per person all-in, USD. Computed from the parts. */
  perPerson: z.number(),
  /** Per person times the party size. */
  groupTotal: z.number(),
  /** Every host the plan was built from, deduplicated. */
  sources: z.array(z.string()),
  /** `Date.now()` when it was built, printed in the footer. */
  builtAt: z.number(),
  /** False when it came from the canned fallback rather than the live web. */
  live: z.boolean(),
  /** What the availability check found, when it ran. */
  checks: itineraryChecksSchema.optional(),
});

export type ItineraryLink = z.infer<typeof itineraryLinkSchema>;
export type ItineraryItem = z.infer<typeof itineraryItemSchema>;
export type ItineraryDay = z.infer<typeof itineraryDaySchema>;
export type Itinerary = z.infer<typeof itinerarySchema>;

/* -------------------------------------------------------------------------- */
/* 12. DemoSession                                                             */
/* -------------------------------------------------------------------------- */

/** One person's whole state: what they told their agent, and how they set it. */
export const participantStateSchema = z.object({
  brief: briefSchema,
  personality: personalitySchema,
  /** The human's tap on the plan screen. Four of these end the demo. */
  approved: z.boolean(),
  /**
   * What this person is called, when they are not the cast member in the seat.
   *
   * Absent on the seeded grad trip, which is why that run still reads Richard /
   * Angela / Will / Tsai everywhere. The judges' round sets it to the name a
   * judge typed, and `displayNameFor` is the only thing that reads it.
   */
  displayName: z.string().optional(),
  /**
   * `Date.now()` when a human took this seat, or null while nobody has.
   *
   * One field rather than a `claimed` boolean beside a timestamp, because two
   * fields can disagree and one cannot: claimed *is* `claimedAt !== null`.
   *
   * An unclaimed seat is an NPC. That is the whole rule the room runs on — it
   * decides who has to tap APPROVE (`approveUnattendedSeats`) and what the
   * lobby draws — and it is why a solo run, where nobody ever claims anything,
   * behaves exactly as it did before rooms existed.
   *
   * Defaulted rather than optional so a session written by an earlier build is
   * restored through this schema as "nobody has joined" instead of being
   * quarantined. `.default()` also makes the field required on the *output*
   * type, so every hand-built `ParticipantState` is a compile error until it
   * says what it means.
   */
  claimedAt: z.number().nullable().default(null),
  /**
   * Where this seat came from, when it was not the person themself.
   *
   * Set when a room is seeded from a group-chat photo and cleared the moment
   * that person says a first word to their own agent. Its only job is to
   * let a screen say "we guessed this from the chat — fix it", which stops a
   * draft from being mistaken for something the person actually said.
   */
  draft: z
    .object({
      source: z.literal("photo"),
      /** The handle this was read under: "@jules", "Mom". */
      handle: z.string().max(40),
      confidence: z.enum(["clear", "unsure"]),
    })
    .optional(),
});

/** Everything the app knows about one of the four friends. */
export type ParticipantState = z.infer<typeof participantStateSchema>;

/**
 * The entire demo, in one object. There is no database on purpose: this lives
 * in a server-side map and a reset is just replacing it, which is what lets a
 * judge start a fresh negotiation in one click.
 */
export const demoSessionSchema = z.object({
  id: z.string(),
  /** "Grad trip" — printed on the top bar and in the plan header. */
  tripName: z.string(),
  participants: z.record(participantIdSchema, participantStateSchema),
  turns: z.array(negotiationTurnSchema),
  /** Null until the agents agree. */
  plan: planSchema.nullable(),
  /** Null until the run finishes. */
  fairness: fairnessReportSchema.nullable(),
  /** Null until the run finishes; one private report per person. */
  reports: z.partialRecord(participantIdSchema, agentReportSchema).nullable(),
  /** Null until all four approve and the itinerary is built. Built once, then cached. */
  itinerary: itinerarySchema.nullable(),
  usage: usageSchema,
  /** `Date.now()` at creation, used for the "agreed in" figure. */
  startedAt: z.number(),
  /**
   * The seat that may start the run and clear the room, or null in a solo run.
   *
   * Set to whoever claims first, which is the person who uploaded the chat and
   * opened the link — so being the host costs no extra plumbing and no extra
   * screen. It exists because two buttons in this app are destructive to other
   * people: START spends everyone's model budget, and RESET replaces the whole
   * session, briefs included. Null means nobody has joined and both stay
   * exactly as unguarded as they were before rooms.
   */
  hostSeat: participantIdSchema.nullable().default(null),
  /**
   * `Date.now()` when the negotiation first started streaming, else null.
   *
   * The lobby's "we have begun" flag, and the reason four phones need no
   * coordination primitive: the host navigates to the town, the route stamps
   * this, and everyone else's next poll sees it and follows.
   */
  runStartedAt: z.number().nullable().default(null),
  /**
   * True only while this session is still the untouched seeded script.
   *
   * The offline provider may replay its canned grad-trip transcript only then.
   * The first edit to any brief or personality clears it, because the moment a
   * human changes what their agent knows, a hand-written transcript stops being
   * a recording of this room and becomes a lie about it.
   */
  scripted: z.boolean(),
});

/** The whole demo state. */
export type DemoSession = z.infer<typeof demoSessionSchema>;

/**
 * The name overrides this session carries, gathered into one map.
 *
 * A collector, not a decision: it only reads what was stored. What a person is
 * *called* is still decided in exactly one place, `displayNameFor`, which this
 * map is fed to.
 */
export function displayNamesOf(session: DemoSession): DisplayNames {
  const names: Partial<Record<ParticipantId, string>> = {};
  for (const id of PARTICIPANT_IDS) {
    const displayName = session.participants[id]?.displayName?.trim();
    if (displayName) names[id] = displayName;
  }
  return names;
}

/** Re-exported so consumers of the model need only one import. */
export type { ParticipantId };
