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
import { PARTICIPANT_IDS, type ParticipantId } from "@/lib/characters";

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
  else clauses.push("Concedes when the argument is fair");

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
  /** Consensus. The Town screen starts its transition to the plan. */
  z.object({
    type: z.literal("agreed"),
    plan: planSchema,
    runnerUp: offerSchema.nullable(),
  }),
  /** Terminal frame: everything the plan screen needs, in one payload. */
  z.object({
    type: z.literal("done"),
    fairness: fairnessReportSchema,
    reports: z.record(participantIdSchema, agentReportSchema),
    usage: usageSchema,
    elapsedMs: z.number(),
  }),
]);

/** One frame of the negotiation stream. */
export type NegotiationEvent = z.infer<typeof negotiationEventSchema>;

/* -------------------------------------------------------------------------- */
/* 12. DemoSession                                                             */
/* -------------------------------------------------------------------------- */

/** One person's whole state: what they told their agent, and how they set it. */
export const participantStateSchema = z.object({
  brief: briefSchema,
  personality: personalitySchema,
  /** The human's tap on the plan screen. Four of these end the demo. */
  approved: z.boolean(),
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
  reports: z.record(participantIdSchema, agentReportSchema).nullable(),
  usage: usageSchema,
  /** `Date.now()` at creation, used for the "agreed in" figure. */
  startedAt: z.number(),
});

/** The whole demo state. */
export type DemoSession = z.infer<typeof demoSessionSchema>;

/** Re-exported so consumers of the model need only one import. */
export type { ParticipantId };
