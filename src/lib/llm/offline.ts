/**
 * The canned provider: the demo's parachute.
 *
 * With no API key, a dead network or a model that will not answer in time,
 * this stands in and plays the run — the same beats, the same shapes.
 *
 * It answers in one of two ways. For the seeded grad trip it replays the
 * hand-written script below, word for word, because that run is what the design
 * files show and what the demo is timed against. For any other session — above
 * all the judges' round, where somebody types their own four names, their own
 * wants and their own private ceilings — it generates the same five-beat arc
 * over *that* room, via `lib/llm/scenario.ts`. Which of the two it is comes from
 * `context.offline`, built by the negotiation engine.
 *
 * Both paths are deterministic (a judge who reruns gets the identical
 * transcript) and neither can throw: every path, including a schema it has never
 * seen and hints it cannot read, ends in a value.
 *
 * Server-only. No React, no DOM, no I/O.
 */

import type { z } from "zod";
import type { ParticipantId } from "@/lib/characters";
import { EMPTY_USAGE, type Usage } from "@/lib/types";
import type {
  CompletionRequest,
  CompletionResult,
  LLMProvider,
} from "@/lib/llm/provider";
import {
  buildScenario,
  scenarioPlan,
  scenarioReport,
  scenarioTurn,
  type OfflineHints,
  type OfflinePersonHint,
  type Scenario,
} from "@/lib/llm/scenario";

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ctxString(ctx: Record<string, unknown> | undefined, ...keys: string[]): string {
  for (const key of keys) {
    const v = ctx?.[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function ctxNumber(ctx: Record<string, unknown> | undefined, ...keys: string[]): number | null {
  for (const key of keys) {
    const v = ctx?.[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function ctxStrings(ctx: Record<string, unknown> | undefined, ...keys: string[]): string[] | null {
  for (const key of keys) {
    const v = ctx?.[key];
    if (Array.isArray(v)) {
      const out = v.filter((item): item is string => typeof item === "string");
      if (out.length) return out;
    }
  }
  return null;
}

/** A run that made no model call still reports one "call", so the UI can say "offline". */
function offlineUsage(): Usage {
  return { ...EMPTY_USAGE, calls: 1, model: ["offline"] };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** Trims a human line down to something that fits inside a quoted mirror. */
function snippet(text: string, max = 58): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Detects that the human just said a number they care about. The trigger for
 * the demo's centrepiece line, so it is deliberately broad: a missed match
 * costs the best beat in the script.
 */
const MONEY_PATTERN =
  /\$\s*\d|\b\d[\d,]*\s*(dollars|bucks|usd)\b|\b(budget|afford|spend|max|cap|ceiling)\b[^.!?]*\b\d[\d,]{2,}\b/i;

function mentionsMoney(text: string): boolean {
  return MONEY_PATTERN.test(text);
}

/** Pulls a per-person ceiling out of free text, for `brief-extract`. */
function budgetIn(text: string): number | null {
  const dollar = /\$\s*(\d[\d,]*)/.exec(text);
  if (dollar) {
    const n = Number(dollar[1].replace(/,/g, ""));
    if (Number.isFinite(n)) return n;
  }
  const worded = /\b(\d[\d,]{2,})\s*(dollars|bucks|usd)?\b/i.exec(text);
  if (worded) {
    const n = Number(worded[1].replace(/,/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* 1. brief-reply                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The line the agent says when its human finally names the number. This is the
 * beat the whole pitch rests on, so it is written out rather than generated:
 * it confirms the secret is held and proves it by never repeating the figure.
 */
const MONEY_REPLIES = [
  "Locked. They’ll hear “Cancun is a stretch,” never the number. I’ll trade away the nicer hotel before I let it slip. Anything else that stays between us?",
  "Got it, and it stays with me. Out there it becomes “that’s over what works for us” — no figure, ever. What else is a hard no?",
] as const;

/**
 * The ladder the agent walks when nothing sensitive was said: acknowledge, then
 * ask the next thing it still needs. Ordered destination → dates → budget →
 * dealbreakers → done, which is the one-minute briefing the demo script allows.
 */
const BRIEF_LADDER = [
  "Noted — “{q}”. When? Give me the window, even a rough one.",
  "“{q}” — in. Now the real number: the most you can spend, all in. I won’t repeat it to anyone, including them.",
  "Got it. Anything that’s a hard no? Early flights, long layovers, a place you won’t go back to.",
  "That’s a dealbreaker, not a preference, and I’ll argue it like one. Anything you’d never say in the group chat?",
  "Locked. I have enough to argue your side. Set how I should sound and I’ll go in.",
] as const;

function briefReply(req: CompletionRequest): string {
  const last = ctxString(req.context, "lastHumanMessage", "lastMessage", "message");
  const turn = ctxNumber(req.context, "turnIndex", "turn") ?? 0;
  const step = Math.max(0, Math.trunc(turn));

  if (last && mentionsMoney(last)) {
    return MONEY_REPLIES[step % MONEY_REPLIES.length];
  }

  const template = BRIEF_LADDER[Math.min(step, BRIEF_LADDER.length - 1)];
  return template.replace("{q}", last ? snippet(last) : "that");
}

/* -------------------------------------------------------------------------- */
/* 2. voice-preview                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Sample lines indexed by the three sliders that change how an agent *sounds*
 * in the room. Nine distinct outputs, because the personality flip only reads
 * as real if dragging one slider visibly changes the sentence.
 */
/**
 * Nine canned previews, keyed `${tone}|${grip}|${wallet}`.
 *
 * `{it}` is whatever the room is actually arguing about, passed in from the
 * personality screen. The lines used to name Cancun, the catamaran day and a
 * $1,180 price outright, which was true of exactly one session: the seeded
 * grad trip. In a judges' round about dinner the preview quoted an argument
 * nobody was having, and the figure in it was a price no one had proposed.
 *
 * Only the contested option is substituted, never the person's own want. The
 * contested option arrives as a place or a plan ("Cancun", "the steakhouse")
 * and reads correctly mid-sentence; a want arrives as a sentence fragment in
 * the human's own words and does not.
 */
const VOICE_LINES: Record<string, string> = {
  "blunt|stubborn|frugal":
    "No. {it} at that price is a bad trade for how little of it we'd use. Find the cheaper version or count me out.",
  "blunt|stubborn|splurgy":
    "{it} is fine, the expensive add-ons aren't the point. If we're spending this, we're spending it on the one day we'll remember. I'm not moving on that.",
  "blunt|easy|frugal":
    "Straight up: {it} is over what works for us. Same trip, cheaper, and I'll take that trade every time.",
  "blunt|easy|splurgy":
    "Honestly? Book the better version. I'll go along with the dates, but I'm not doing the bargain option.",
  "diplomatic|stubborn|frugal":
    "I hear you on {it}. It doesn't work for us, though, and I'm going to keep saying that until we find the version that does.",
  "diplomatic|stubborn|splurgy":
    "Happy to flex on almost all of it. The one thing my person asked me for is not one of the flexible parts.",
  "diplomatic|easy|frugal":
    "{it} is a stretch for us. There's a version of this with the same upside for less. Could we look at that before we book?",
  "diplomatic|easy|splurgy":
    "Whatever the group lands on works for me. If there's room in it, I'd put the extra toward somewhere nicer to stay.",
  "balanced|balanced|balanced":
    "I'll push where it matters and let the rest go. {it} is a stretch, so let me see what else gets us the same thing.",
};

/** What the nine lines argue against when the caller named nothing. */
const DEFAULT_CONTESTED = "The expensive option";

function voicePreview(req: CompletionRequest): string {
  const personality = isRecord(req.context?.personality) ? req.context.personality : req.context;
  const blunt = ctxNumber(personality, "blunt") ?? 50;
  const stubborn = ctxNumber(personality, "stubborn") ?? 50;
  const splurgy = ctxNumber(personality, "splurgy") ?? 50;

  const tone = blunt >= 60 ? "blunt" : blunt <= 40 ? "diplomatic" : "balanced";
  const grip = stubborn >= 60 ? "stubborn" : stubborn <= 40 ? "easy" : "balanced";
  const wallet = splurgy >= 60 ? "splurgy" : splurgy <= 40 ? "frugal" : "balanced";

  const line =
    VOICE_LINES[`${tone}|${grip}|${wallet}`] ??
    VOICE_LINES[`${tone === "balanced" ? "diplomatic" : tone}|${grip === "balanced" ? "easy" : grip}|${wallet === "balanced" ? "frugal" : wallet}`] ??
    VOICE_LINES["balanced|balanced|balanced"] ??
    "";

  const contested = ctxString(req.context, "contested").trim();
  const it = contested.length > 0 ? contested : DEFAULT_CONTESTED;
  // Only the first slot opens a sentence, so the substitution keeps its case
  // where the line starts with it and lowercases a leading article elsewhere.
  return line
    .replace(/^\{it\}/, it)
    .replaceAll("{it}", it.charAt(0).toLowerCase() + it.slice(1));
}

/* -------------------------------------------------------------------------- */
/* 3. Offers and the negotiation script                                        */
/* -------------------------------------------------------------------------- */

/** Richard's opener: the plan that loses, kept in full so the transcript reads real. */
const CANCUN_OFFER = {
  id: "offer-cancun",
  destination: "Cancun",
  region: "Hotel Zone",
  dates: "Mar 14–19",
  nights: 5,
  perPerson: 1180,
  highlights: ["Resort on the beach", "All-inclusive", "One flight, no connection"],
  flightNote: "6am departure",
  lodgingNote: "Four-star resort on the strip",
  proposedBy: "sam",
} as const;

/** The plan that wins. Mirrors `design/04-plan.clean.html` exactly. */
const PUERTO_RICO_OFFER = {
  id: "offer-puerto-rico",
  destination: "Puerto Rico",
  region: "San Juan + Culebra",
  dates: "Mar 14–19",
  nights: 5,
  perPerson: 540,
  highlights: [
    "Beach every day",
    "Catamaran day kept",
    "Nothing leaves before 11am",
    "No passports needed",
  ],
  flightNote: "Nothing leaves before 11am",
  lodgingNote: "Clean 3-star, two blocks from the water",
  proposedBy: "maya",
} as const;

/** The runner-up, kept because "we considered it and dropped it" is what earns trust. */
const TULUM_OFFER = {
  id: "offer-tulum",
  destination: "Tulum",
  region: "Tulum + Akumal",
  dates: "Mar 14–19",
  nights: 5,
  perPerson: 690,
  highlights: ["Beach every day", "Cenote day", "Quieter than Cancun"],
  flightNote: "6am departure both ways",
  lodgingNote: "Beach cabanas, twenty minutes out of town",
  proposedBy: "jordan",
} as const;

/* -------------------------------------------------------------------------- */
/* 3b. Canned trip prices, for when the web search cannot run                  */
/* -------------------------------------------------------------------------- */

/**
 * Roughly what a place costs a student in shoulder season: a round trip and a
 * clean bed, per person, in USD.
 *
 * These stand in when the live check is unavailable, so the room still has real
 * numbers to argue over rather than a shrug. They are ballpark by design — the
 * check they feed decides "is this in the right neighbourhood", not "is this
 * the price", so being off by fifty dollars changes no outcome.
 */
const TRIP_PRICES: { pattern: RegExp; flights: number; perNight: number }[] = [
  { pattern: /puerto rico|san juan|culebra/i, flights: 210, perNight: 65 },
  { pattern: /cancun|tulum|akumal|mexico|oaxaca/i, flights: 260, perNight: 80 },
  { pattern: /costa rica|san jos|tamarindo/i, flights: 420, perNight: 70 },
  { pattern: /hawaii|maui|honolulu|oahu/i, flights: 550, perNight: 130 },
  { pattern: /iceland|reykjav/i, flights: 500, perNight: 110 },
  { pattern: /portugal|lisbon|porto|algarve/i, flights: 620, perNight: 70 },
  { pattern: /spain|barcelona|madrid|seville/i, flights: 650, perNight: 75 },
  { pattern: /greece|athens|santorini|crete/i, flights: 750, perNight: 85 },
  { pattern: /ital|rome|sicily|amalfi|florence/i, flights: 700, perNight: 90 },
  { pattern: /japan|tokyo|kyoto|osaka/i, flights: 1150, perNight: 95 },
  { pattern: /thailand|bangkok|phuket|chiang/i, flights: 1000, perNight: 45 },
  { pattern: /bali|indonesia/i, flights: 1100, perNight: 50 },
];

/** Somewhere we have no figure for. A mid-haul beach trip, near enough. */
const UNKNOWN_TRIP = { flights: 500, perNight: 85 };

function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/**
 * The canned verdict on one offer.
 *
 * Same rule the live prompt is given — out by roughly a third or more is not
 * bookable — so a run on canned facts and a run on real ones disagree about
 * numbers but never about what counts as a fantasy.
 */
function offerCheck(req: CompletionRequest): Record<string, unknown> {
  const ctx = req.context;
  const destination = ctxString(ctx, "destination") || "somewhere warm";
  const nights = Math.max(1, Math.trunc(ctxNumber(ctx, "nights") ?? 5));
  const claimed = ctxNumber(ctx, "perPerson") ?? 0;

  const prices = TRIP_PRICES.find((entry) => entry.pattern.test(destination)) ?? UNKNOWN_TRIP;
  const realistic = prices.flights + prices.perNight * nights;
  const bookable = claimed <= 0 || claimed >= realistic * 0.67;

  return {
    bookable,
    realisticPerPerson: realistic,
    note: bookable
      ? `Flights run about ${money(prices.flights)} and a bed about ${money(prices.perNight)} a night, so ${money(realistic)} a person is the real number.`
      : `Flights alone are about ${money(prices.flights)} — ${money(claimed)} a person does not buy ${destination}.`,
    // Empty on purpose: nothing was searched, so there is nothing to cite, and
    // a canned host name on the card would be the one lie in this file.
    sources: [],
  };
}

interface Beat {
  speaker: ParticipantId;
  kind: "proposes" | "pushes back" | "trades" | "counters" | "agrees";
  text: string;
  offer?: Record<string, unknown>;
  privateReasonKept?: string;
}

const PROPOSE_CANCUN: Beat = {
  speaker: "sam",
  kind: "proposes",
  text: "Cancun, Mar 14–19. $1,180 a person, resort right on the beach. The flight’s 6am, but it’s the cheapest one out.",
  offer: CANCUN_OFFER,
};

const MAYA_PUSHES_BACK: Beat = {
  speaker: "maya",
  kind: "pushes back",
  text: "Cancun doesn’t work for us. Puerto Rico has the same beaches and cheaper flights.",
  privateReasonKept: "$600 budget",
};

const JORDAN_TRADES: Beat = {
  speaker: "jordan",
  kind: "trades",
  text: "Fine. But we keep the catamaran day.",
};

const MAYA_COUNTERS: Beat = {
  speaker: "maya",
  kind: "counters",
  text: "Puerto Rico, same dates. About $540 a person, catamaran kept, nothing leaving before 11am.",
  offer: PUERTO_RICO_OFFER,
  privateReasonKept: "$600 budget",
};

const PRIYA_AGREES: Beat = {
  speaker: "priya",
  kind: "agrees",
  text: "That works for me. San Juan plus a day on Culebra — no passport, no 6am alarm. I’m in.",
};

/**
 * The five beats of the demo arc, keyed the way the engine addresses them.
 * Matches `design/03-town.clean.html` line for line so a canned run and a live
 * run are indistinguishable on screen.
 */
const SCRIPT: Record<string, Beat> = {
  "sam:1": PROPOSE_CANCUN,
  "maya:2": MAYA_PUSHES_BACK,
  "jordan:2": JORDAN_TRADES,
  "maya:3": MAYA_COUNTERS,
  "priya:4": PRIYA_AGREES,
};

/** Whatever round the engine asks for, each agent still has something in character to say. */
const SPEAKER_BEATS: Record<ParticipantId, Beat[]> = {
  sam: [
    PROPOSE_CANCUN,
    {
      speaker: "sam",
      kind: "pushes back",
      text: "The resort was the whole point. Strip a star off it and we’re just four people in a room with a fan.",
    },
    {
      speaker: "sam",
      kind: "agrees",
      text: "Alright — Puerto Rico. I’ll give up the resort if the beach day is real.",
    },
  ],
  maya: [
    MAYA_PUSHES_BACK,
    MAYA_COUNTERS,
    {
      speaker: "maya",
      kind: "agrees",
      text: "That’s the one. Five nights, nothing before 11am — I’m in.",
      privateReasonKept: "$600 budget",
    },
  ],
  jordan: [
    JORDAN_TRADES,
    {
      speaker: "jordan",
      kind: "trades",
      text: "Then we trade the hotel, not the boat. Three-star near the water, catamaran stays.",
    },
    { speaker: "jordan", kind: "agrees", text: "Catamaran’s in. Book it." },
  ],
  priya: [
    PRIYA_AGREES,
    {
      speaker: "priya",
      kind: "agrees",
      text: "Still a yes. Everyone gets a beach day and nobody’s up at four in the morning.",
    },
    { speaker: "priya", kind: "agrees", text: "Agreed. Let’s send it." },
  ],
};

const PARTICIPANTS: ParticipantId[] = ["maya", "jordan", "sam", "priya"];

function isParticipant(value: string): value is ParticipantId {
  return (PARTICIPANTS as string[]).includes(value);
}

function speakerOf(req: CompletionRequest): ParticipantId {
  const raw = ctxString(req.context, "speaker", "participantId", "agent").toLowerCase();
  return isParticipant(raw) ? raw : "maya";
}

function negotiationBeat(req: CompletionRequest): Beat {
  const speaker = speakerOf(req);
  const round = Math.max(1, Math.trunc(ctxNumber(req.context, "round") ?? 1));
  const scripted = SCRIPT[`${speaker}:${round}`];
  if (scripted) return scripted;
  const list = SPEAKER_BEATS[speaker];
  return list[Math.min(round - 1, list.length - 1)];
}

/* -------------------------------------------------------------------------- */
/* 4. The plan and the private reports                                         */
/* -------------------------------------------------------------------------- */

/**
 * The agreed plan, flattened *and* nested in one object. The nested shape fits
 * `planSchema`; the flat mirror fits a bare offer schema. Whichever the caller
 * asks for, the seed already has the fields, so nothing has to be invented.
 */
const FINAL_PLAN = {
  ...PUERTO_RICO_OFFER,
  offer: PUERTO_RICO_OFFER,
  runnerUp: TULUM_OFFER,
  runnerUpLostBecause: "Tulum came in at $690 and every flight left at 6am.",
  groupTotal: 2160,
  keptWants: [
    "Beach every day",
    "Catamaran day kept",
    "Nothing leaves before 11am",
    "No passports needed",
  ],
  agreedInMs: 112_000,
  summary:
    "Puerto Rico, San Juan plus Culebra, Mar 14–19. Five nights, $540 a person, catamaran day kept and nothing leaving before 11am.",
} as const;

/**
 * One private debrief per person, matching `design/04-plan.clean.html`. Will's
 * is the one the demo reads out loud, so it names the saving without ever
 * having said the ceiling in the room.
 */
const REPORTS: Record<ParticipantId, Record<string, unknown>> = {
  maya: {
    participantId: "maya",
    gotYou: "$540 a head, $60 under your number. Nothing before 11am. A beach every day.",
    tradedAway:
      "The nicer hotel. Richard wanted the resort; you get a clean 3-star two blocks from the water.",
    why: "Angela’s agent wouldn’t budge on the catamaran, so I gave up the hotel to protect your budget. Nobody heard your number.",
    secretsKept: ["$600 budget"],
  },
  jordan: {
    participantId: "jordan",
    gotYou: "The catamaran day, in writing, and a flight nobody has to set an alarm for.",
    tradedAway: "Cancun. You wanted the strip; this is quieter and $640 cheaper.",
    why: "Richard’s agent traded the resort to keep the boat day, so I spent that goodwill on the one thing you said you’d be annoyed to lose.",
    secretsKept: [],
  },
  sam: {
    participantId: "sam",
    gotYou: "Five nights, a real beach every day, and the group actually going.",
    tradedAway: "The resort. That’s the one you lose here, and I want you to hear it from me.",
    why: "Two agents were never going to clear $1,180 a head. I held the resort into round three, then traded it for the catamaran day and the late flights.",
    secretsKept: [],
  },
  priya: {
    participantId: "priya",
    gotYou: "No passport, no early flight, and a day out on Culebra. Everything you asked for.",
    tradedAway: "Nothing. You came in the cheapest to satisfy and it cost you no ground.",
    why: "Puerto Rico cleared your no-passport rule on its own, so I spent my turns backing Will’s number instead of arguing for you.",
    secretsKept: [],
  },
};

function reportFor(req: CompletionRequest): Record<string, unknown> {
  return REPORTS[speakerOf(req)];
}

/* -------------------------------------------------------------------------- */
/* 5. brief-extract                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Rebuilds a `Brief`-shaped object from whatever the caller put in `context`,
 * falling back to Will's briefing from `design/01-brief.clean.html`. The
 * transcript is scanned for a dollar figure so an offline run of a *live*
 * briefing still captures the number the human actually typed.
 */
function briefExtract(req: CompletionRequest): Record<string, unknown> {
  const ctx = req.context;
  const transcript = Array.isArray(ctx?.transcript) ? ctx.transcript : [];
  const humanText = transcript
    .map((entry) => (isRecord(entry) && typeof entry.text === "string" ? entry.text : ""))
    .concat(ctxString(ctx, "lastHumanMessage", "lastMessage", "message"))
    .join(" ");

  const budget = ctxNumber(ctx, "budgetCeiling", "budget") ?? budgetIn(humanText) ?? 600;
  const participantId = speakerOf(req);

  return {
    participantId,
    destinationWant: ctxString(ctx, "destinationWant", "destination") || "Somewhere warm, with a beach",
    dates: ctxString(ctx, "dates") || "Mar 14–19",
    nights: ctxNumber(ctx, "nights") ?? 5,
    budgetCeiling: budget,
    budgetIsPrivate: ctx?.budgetIsPrivate === false ? false : true,
    dealbreakers: ctxStrings(ctx, "dealbreakers") ?? ["No flights before 8am"],
    wants: ctxStrings(ctx, "wants") ?? ["A beach every day", "Late flights", "No passport hassle"],
    notes: ctxStrings(ctx, "notes") ?? ["private: money is tight until the job starts"],
    rawTranscript: transcript,
  };
}

/* -------------------------------------------------------------------------- */
/* 6. The generated path                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Reads the engine's offline hints out of `context`, defensively.
 *
 * Every field is checked rather than trusted: this provider is the thing that
 * runs when everything else has failed, so it may not assume the shape of what
 * it was handed. A hint block it cannot read is no hint block at all, and the
 * scripted grad trip below answers instead.
 */
function readHints(ctx: Record<string, unknown> | undefined): OfflineHints | null {
  const raw = ctx?.offline;
  if (!isRecord(raw)) return null;

  const rawPeople = Array.isArray(raw.people) ? raw.people : [];
  const people: OfflinePersonHint[] = [];
  for (const entry of rawPeople) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.participantId === "string" ? entry.participantId : "";
    if (!isParticipant(id)) continue;
    const wants = Array.isArray(entry.wants)
      ? entry.wants.filter((want): want is string => typeof want === "string" && want.trim().length > 0)
      : [];
    const want = typeof entry.want === "string" && entry.want.trim() ? entry.want.trim() : (wants[0] ?? "");
    const ceiling =
      typeof entry.ceiling === "number" && Number.isFinite(entry.ceiling) && entry.ceiling > 0
        ? entry.ceiling
        : null;
    people.push({
      participantId: id,
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id,
      want: want || "Something everyone can live with",
      wants: wants.length > 0 ? wants : [want || "Something everyone can live with"],
      ceiling,
    });
  }
  if (people.length === 0) return null;

  const priceCapRaw = ctxNumber(raw, "priceCap");
  const offerIds = Array.isArray(raw.offerIds)
    ? raw.offerIds.filter((id): id is string => typeof id === "string")
    : [];

  return {
    scenarioId: typeof raw.scenarioId === "string" && raw.scenarioId.trim() ? raw.scenarioId.trim() : null,
    topic: ctxString(raw, "topic") || "the plan",
    when: ctxString(raw, "when") || "Soon",
    nights: ctxNumber(raw, "nights"),
    priceCap:
      priceCapRaw !== null && priceCapRaw > 0 ? priceCapRaw : Number.POSITIVE_INFINITY,
    people,
    offerIds,
    spokenCount: Math.max(0, Math.trunc(ctxNumber(raw, "spokenCount") ?? 0)),
    attempt: Math.max(0, Math.trunc(ctxNumber(raw, "attempt") ?? 0)),
  };
}

/**
 * The scenario for this request, or null when the scripted run should answer.
 *
 * `scenarioId` is the switch: the engine sets it for a session that came out of
 * `createSeedSession`, and that run has to keep producing the exact strings
 * below. Everything else is generated.
 */
function scenarioFor(req: CompletionRequest): { hints: OfflineHints; scenario: Scenario } | null {
  const hints = readHints(req.context);
  if (!hints || hints.scenarioId !== null) return null;
  return { hints, scenario: buildScenario(hints) };
}

/** The generated answer for one request, or null when there is nothing to generate. */
function generatedData(req: CompletionRequest): unknown {
  let built: { hints: OfflineHints; scenario: Scenario } | null = null;
  try {
    built = scenarioFor(req);
  } catch {
    return null;
  }
  if (!built) return null;
  const { hints, scenario } = built;

  try {
    switch (req.tag) {
      case "negotiation-turn": {
        const speaker = speakerOf(req);
        const round = Math.max(1, Math.trunc(ctxNumber(req.context, "round") ?? 1));
        const beat = scenarioTurn(hints, scenario, speaker);
        return {
          id: `turn-${beat.speaker}-${round}`,
          round,
          speaker: beat.speaker,
          kind: beat.kind,
          text: beat.text,
          ...(beat.offer ? { offer: beat.offer } : {}),
          ...(beat.privateReasonKept ? { privateReasonKept: beat.privateReasonKept } : {}),
        };
      }
      case "final-plan":
        return scenarioPlan(scenario);
      case "agent-report":
        return scenarioReport(scenario, speakerOf(req));
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* 7. Canned data and the schema walker                                        */
/* -------------------------------------------------------------------------- */

/** The seed object for a structured call: generated if it can be, scripted if not. */
function cannedData(req: CompletionRequest): unknown {
  const generated = generatedData(req);
  if (generated !== null && generated !== undefined) return generated;

  switch (req.tag) {
    case "brief-reply": {
      const text = briefReply(req);
      return { text, reply: text, message: text };
    }
    case "brief-extract":
      return briefExtract(req);
    case "voice-preview": {
      const text = voicePreview(req);
      return { text, line: text, preview: text };
    }
    case "negotiation-turn": {
      const beat = negotiationBeat(req);
      const round = Math.max(1, Math.trunc(ctxNumber(req.context, "round") ?? 1));
      return {
        id: `turn-${beat.speaker}-${round}`,
        round,
        speaker: beat.speaker,
        kind: beat.kind,
        text: beat.text,
        ...(beat.offer ? { offer: beat.offer } : {}),
        ...(beat.privateReasonKept ? { privateReasonKept: beat.privateReasonKept } : {}),
      };
    }
    case "offer-check":
      return offerCheck(req);
    case "final-plan":
      return FINAL_PLAN;
    case "agent-report":
      return reportFor(req);
  }
}

/** The subset of a zod v4 internal definition this walker reads. */
interface ZodDef {
  type: string;
  shape?: Record<string, unknown>;
  element?: unknown;
  innerType?: unknown;
  options?: unknown[];
  entries?: Record<string, string | number>;
  values?: unknown[];
  defaultValue?: unknown;
  keyType?: unknown;
  valueType?: unknown;
  items?: unknown[];
}

/** Reads a schema's definition without importing zod's internals as types. */
function defOf(schema: unknown): ZodDef | null {
  if (!isRecord(schema)) return null;
  const direct = schema.def;
  if (isRecord(direct) && typeof direct.type === "string") return direct as unknown as ZodDef;
  const internal = schema._zod;
  if (isRecord(internal) && isRecord(internal.def) && typeof internal.def.type === "string") {
    return internal.def as unknown as ZodDef;
  }
  return null;
}

function accepts(schema: unknown, value: unknown): boolean {
  if (!isRecord(schema) || typeof schema.safeParse !== "function") return false;
  const parse = schema.safeParse as (v: unknown) => { success: boolean };
  try {
    return parse(value).success;
  } catch {
    return false;
  }
}

/**
 * Builds the smallest value a schema will accept, reusing anything in `seed`
 * that already fits. This is the last line of defence: the offline provider is
 * handed schemas it was never written for, and returning a wrong-but-valid
 * object beats throwing in front of a judge.
 */
function fabricate(schema: unknown, seed: unknown): unknown {
  const def = defOf(schema);
  if (!def) return seed ?? null;

  switch (def.type) {
    case "object": {
      const out: Record<string, unknown> = {};
      const seeded = isRecord(seed) ? seed : {};
      for (const [key, field] of Object.entries(def.shape ?? {})) {
        const value = fabricate(field, seeded[key]);
        if (value !== undefined) out[key] = value;
      }
      return out;
    }
    case "string":
      return typeof seed === "string" ? seed : "";
    case "number":
    case "int":
      return typeof seed === "number" ? seed : 0;
    case "boolean":
      return typeof seed === "boolean" ? seed : false;
    case "date":
      return seed instanceof Date ? seed : new Date(0);
    case "null":
      return null;
    case "undefined":
    case "void":
      return undefined;
    case "any":
    case "unknown":
      return seed ?? null;
    case "literal": {
      const values = def.values ?? [];
      return values.includes(seed) ? seed : (values[0] ?? null);
    }
    case "enum": {
      const values = Object.values(def.entries ?? {});
      return values.includes(seed as string) ? seed : (values[0] ?? null);
    }
    case "array":
      return Array.isArray(seed) ? seed.map((item) => fabricate(def.element, item)) : [];
    case "tuple": {
      const seeded = Array.isArray(seed) ? seed : [];
      return (def.items ?? []).map((item, i) => fabricate(item, seeded[i]));
    }
    case "optional":
      return seed === undefined ? undefined : fabricate(def.innerType, seed);
    case "nullable":
      return seed === null || seed === undefined ? null : fabricate(def.innerType, seed);
    case "nullish":
      return seed === null || seed === undefined ? null : fabricate(def.innerType, seed);
    case "default":
    case "prefault": {
      if (seed !== undefined) return fabricate(def.innerType, seed);
      const fallback = def.defaultValue;
      return typeof fallback === "function" ? (fallback as () => unknown)() : fallback;
    }
    case "catch":
    case "readonly":
    case "nonoptional":
      return fabricate(def.innerType, seed);
    case "union": {
      const options = def.options ?? [];
      for (const option of options) {
        if (accepts(option, seed)) return seed;
      }
      return options.length > 0 ? fabricate(options[0], seed) : null;
    }
    case "record": {
      const out: Record<string, unknown> = {};
      const seeded = isRecord(seed) ? seed : {};
      const keyDef = defOf(def.keyType);
      if (keyDef?.type === "enum") {
        for (const key of Object.values(keyDef.entries ?? {})) {
          out[String(key)] = fabricate(def.valueType, seeded[String(key)]);
        }
      } else {
        for (const [key, value] of Object.entries(seeded)) {
          out[key] = fabricate(def.valueType, value);
        }
      }
      return out;
    }
    default:
      return seed ?? null;
  }
}

/* -------------------------------------------------------------------------- */
/* 8. The provider                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Answers every request from the script. Deterministic and total: the same
 * `(tag, context)` always yields the same words, and no input path throws.
 */
export class OfflineProvider implements LLMProvider {
  readonly name = "offline";
  readonly live = false;

  async text(req: CompletionRequest): Promise<CompletionResult<string>> {
    const value = this.line(req);
    return { value, raw: value, usage: offlineUsage() };
  }

  async json<T>(
    req: CompletionRequest,
    schema: z.ZodType<T>,
  ): Promise<CompletionResult<T>> {
    const seed = cannedData(req);

    const direct = schema.safeParse(seed);
    if (direct.success) {
      return { value: direct.data, raw: safeStringify(seed), usage: offlineUsage() };
    }

    let built: unknown;
    try {
      built = fabricate(schema, seed);
    } catch {
      built = seed;
    }
    const second = schema.safeParse(built);
    const value = (second.success ? second.data : built) as T;
    return { value, raw: safeStringify(value), usage: offlineUsage() };
  }

  /** The spoken form of each tag, for callers that want prose rather than fields. */
  private line(req: CompletionRequest): string {
    const generated = generatedData(req);
    if (isRecord(generated)) {
      if (typeof generated.text === "string" && generated.text.trim()) return generated.text;
      if (typeof generated.summary === "string" && generated.summary.trim()) return generated.summary;
      if (typeof generated.gotYou === "string") {
        return `${String(generated.gotYou)} ${String(generated.tradedAway)} ${String(generated.why)}`;
      }
    }

    switch (req.tag) {
      case "brief-reply":
        return briefReply(req);
      case "voice-preview":
        return voicePreview(req);
      case "negotiation-turn":
        return negotiationBeat(req).text;
      case "final-plan":
        return FINAL_PLAN.summary;
      case "agent-report": {
        const report = reportFor(req);
        return `${String(report.gotYou)} ${String(report.tradedAway)} ${String(report.why)}`;
      }
      case "offer-check":
        return String(offerCheck(req).note);
      case "brief-extract":
        return safeStringify(briefExtract(req));
    }
  }
}
