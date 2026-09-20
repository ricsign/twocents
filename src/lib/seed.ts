/**
 * The demo's starting state.
 *
 * The script in the project spec opens with three agents already briefed and
 * Maya's left empty, so the first thing a judge watches is a human briefing an
 * agent live. Everything here is therefore written to be *read out loud*: the
 * briefs carry the texture of four people who each want something different and
 * exactly one of whom has to give up the thing they came in for.
 *
 * Two constraints shaped the numbers below, and changing either will move the
 * plan screen:
 *
 * - **The ceilings decide the outcome.** Maya's $600 is the lowest and it is
 *   private, so the room can only ever land somewhere under it without anyone
 *   saying why. Sam's $1,400 is the highest, which is why his agent opens with
 *   the expensive option and why he is the one who ends up trading it away.
 * - **Four stated wants plus the private ceiling is what the meter counts.**
 *   `scoreFairness` appends a row for the budget whenever a brief carries one,
 *   so four wants is what makes the fairness bars read "n of 5" the way
 *   `design/04-plan.clean.html` prints them. The fifth want is the one nobody
 *   types into a group chat.
 *
 * One person is deliberately *not* seeded. Maya is whoever is sitting in front
 * of the screen, so her agent starts with an empty brief and an empty
 * transcript and learns everything from the conversation she actually has with
 * it. The scripted version of that conversation is still here, behind
 * `TWOCENTS_SEED_BRIEF_CHAT=1`, for rehearsing the demo. The other three stay
 * seeded because there is no sign-in yet and nobody is there to brief them.
 *
 * Server-only. No React, no DOM.
 */

import { PARTICIPANT_IDS, type ParticipantId } from "@/lib/characters";
import {
  EMPTY_USAGE,
  type Brief,
  type BriefMessage,
  type DemoSession,
  type ParticipantState,
  type Personality,
} from "@/lib/types";

/** Every brief is for the same trip; stated once so the four cannot drift. */
const TRIP_DATES = "Mar 14–19";
const TRIP_NIGHTS = 5;

/** Printed on the top bar and in the plan header. */
export const TRIP_NAME = "Grad Trip ’27";

/**
 * The marker that tells the offline provider this is the scripted run.
 *
 * With no key the model layer falls back to `OfflineProvider`, which answers in
 * one of two ways: it replays the hand-written grad-trip script, or it generates
 * a negotiation over whatever session it was actually given (the judges' round
 * types its own). This constant is how it tells them apart. The negotiation
 * engine stamps it onto the offline hints when `isSeedScenario` holds, and the
 * provider treats its presence as "say exactly what `design/03-town.clean.html`
 * and `design/04-plan.clean.html` print" — which is what the rest of the demo is
 * timed against.
 */
export const SEED_SCENARIO_ID = "seed-grad-trip";

/**
 * Whether Maya's briefing chat starts already half-had.
 *
 * Off by default: a person opening `/brief` gets an agent that asks them what
 * they want, and every field on the "YOUR AGENT KNOWS" panel is filled by what
 * they answer rather than pre-filled with somebody else's trip. Set
 * `TWOCENTS_SEED_BRIEF_CHAT=1` to open mid-conversation instead, which is the
 * 0:15 beat of the scripted demo.
 *
 * Read at call time rather than at import, so flipping it takes effect on the
 * next RESET instead of the next restart.
 */
export function seededBriefChatEnabled(): boolean {
  return process.env.TWOCENTS_SEED_BRIEF_CHAT === "1";
}

/**
 * The agent's first line, and the only thing on screen before the person types.
 *
 * It is a question, not a greeting: the whole screen is one conversation whose
 * job is to get three things out of a person (where, when, and the number), and
 * an agent that opens with "hello" wastes the first turn on nothing. Stored
 * rather than generated so the screen paints instantly and says the same thing
 * with or without a key.
 */
export const BRIEF_OPENING_LINE =
  "Before I go plan this with the others: where do you want to go, when, and what’s the real number?";

/**
 * True for a session that came out of `createSeedSession`, including after a
 * RESET.
 *
 * The trip name is the whole test, and deliberately so. It is the one field the
 * seeded demo never edits — the briefing screen rewrites Maya's brief live at
 * 0:15 of the script, so a fingerprint taken over the briefs would stop matching
 * exactly when the demo is most exposed — while `/api/judges` always replaces it
 * with the judge's own topic.
 */
export function isSeedScenario(session: Pick<DemoSession, "tripName">): boolean {
  return session.tripName.trim() === TRIP_NAME;
}

/* -------------------------------------------------------------------------- */
/* Personalities                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The sliders each agent goes into the room with.
 *
 * These are the values the "personality flip" beat starts from: the demo drags
 * one agent from easygoing to stubborn and reruns, so the interesting positions
 * are the ones with room to move. Priya sits low on stubborn on purpose — she
 * is the agent a judge can flip and visibly change the outcome.
 */
export const SEED_PERSONALITIES: Record<ParticipantId, Personality> = {
  maya: {
    stubborn: 52,
    splurgy: 30,
    blunt: 25,
    adventurous: 58,
    bio: "Reads the room first, then holds the line on the one thing that matters.",
  },
  jordan: {
    stubborn: 86,
    splurgy: 55,
    blunt: 82,
    adventurous: 68,
    bio: "Says what everyone is thinking. Has exactly one non-negotiable and will die on it.",
  },
  sam: {
    stubborn: 72,
    splurgy: 84,
    blunt: 58,
    adventurous: 45,
    bio: "Books the nice place and works the money out after. Would rather overpay than have a bad time.",
  },
  priya: {
    stubborn: 22,
    splurgy: 38,
    blunt: 18,
    adventurous: 44,
    bio: "Happy almost anywhere warm. Just needs the logistics to be simple.",
  },
};

/* -------------------------------------------------------------------------- */
/* Briefs                                                                      */
/* -------------------------------------------------------------------------- */

/** Shorthand for a pre-briefed transcript line. */
function line(role: BriefMessage["role"], text: string): BriefMessage {
  return { role, text };
}

/**
 * Sam wants the resort and has the room to pay for it.
 *
 * He is the engine's opener (his price stance is the highest in the room, so
 * `SPEAKING_ORDER` puts the expensive option on the table first) and he is the
 * one the plan costs something: the resort is his first want, it is the want the
 * agreed plan does not deliver, and his agent argues for it hard enough that the
 * fairness meter names it as what he gave up.
 */
const SAM_BRIEF: Brief = {
  participantId: "sam",
  destinationWant: "Cancun — the hotel zone, right on the strip",
  dates: TRIP_DATES,
  nights: TRIP_NIGHTS,
  budgetCeiling: 1400,
  budgetIsPrivate: true,
  dealbreakers: ["No hostels", "No shared rooms"],
  wants: [
    "A resort on the beach",
    "All-inclusive",
    "A beach every day",
    "No passports needed",
  ],
  notes: [
    "Has points that cover part of the flight",
    "private: put the deposit on a credit card he is still paying off",
  ],
  rawTranscript: [
    line("agent", "Where are we going, and what does the good version look like?"),
    line("human", "Cancun. Hotel zone, on the strip, somewhere that's actually nice."),
    line("agent", "Noted. The most you can spend, all in — I won't repeat it to anyone."),
    line("human", "I can stretch to 1400 if the place is good. Don't lead with that."),
    line("agent", "Understood. Anything that's a hard no?"),
    line("human", "No hostels. No four of us in one room."),
  ],
};

/**
 * Jordan's hill is the catamaran day.
 *
 * Stubborn and blunt, mid budget: his agent is the one that refuses to trade the
 * boat day, which is what forces Sam's agent to trade the resort instead. That
 * chain is the whole negotiation, so the catamaran is his first want and it has
 * to be a want the plan can actually satisfy.
 */
const JORDAN_BRIEF: Brief = {
  participantId: "jordan",
  destinationWant: "Anywhere with a boat day",
  dates: TRIP_DATES,
  nights: TRIP_NIGHTS,
  budgetCeiling: 900,
  budgetIsPrivate: true,
  dealbreakers: ["No 6am departures"],
  wants: [
    "The catamaran day",
    "A beach every day",
    "No flights before 9am",
    "Nightlife within walking distance",
  ],
  notes: ["Will drive to the airport so nobody pays for parking"],
  rawTranscript: [
    line("agent", "What makes this trip worth taking for you?"),
    line("human", "One full day out on a catamaran. That's the trip. Everything else is negotiable."),
    line("agent", "That's a dealbreaker, not a preference, and I'll hold it like one. Budget?"),
    line("human", "900, and I'd rather spend it on the boat than the hotel."),
  ],
};

/**
 * Priya is the flexible one, which is what makes the plan possible.
 *
 * Everything she asked for is satisfied by Puerto Rico on its own — no passport,
 * no early flight, a beach every day — so her agent spends its turns backing
 * other people's positions. She is the 5-of-5 row on the fairness meter, and the
 * proof that "nobody overruled" is a computed claim rather than a slogan.
 */
const PRIYA_BRIEF: Brief = {
  participantId: "priya",
  destinationWant: "Somewhere warm, no passport hassle",
  dates: TRIP_DATES,
  nights: TRIP_NIGHTS,
  budgetCeiling: 800,
  budgetIsPrivate: true,
  dealbreakers: ["No passport hassle"],
  wants: [
    "A beach every day",
    "No passport hassle",
    "No flights before 8am",
    "A day out on the water",
  ],
  notes: [
    "Flexible on almost everything else",
    "private: covering her sister's ticket as well as her own",
  ],
  rawTranscript: [
    line("agent", "What does a good version of this look like for you?"),
    line("human", "Warm, a beach every day, and nothing that needs a passport renewal."),
    line("agent", "Got it. The most you can spend, all in?"),
    line("human", "800, and honestly I'll go along with whatever the group picks under that."),
  ],
};

/**
 * Maya, before she has said anything.
 *
 * This is the default, and it is what makes the product the product: nothing on
 * the briefing screen is true until the person says it. Every field is empty
 * and the agent fills them in from the conversation, which is also what makes
 * the fairness meter honest — a person with two wants gets two bars, not five
 * belonging to somebody else.
 *
 * `budgetIsPrivate` starts true because the default for a number nobody has
 * named yet has to be the safe one.
 */
export function blankBrief(participantId: ParticipantId): Brief {
  return {
    participantId,
    destinationWant: "",
    dates: "",
    nights: null,
    budgetCeiling: null,
    budgetIsPrivate: true,
    dealbreakers: [],
    wants: [],
    notes: [],
    rawTranscript: [],
  };
}

const MAYA_BLANK_BRIEF: Brief = blankBrief("maya");

/**
 * The conversation the scripted demo opens mid-way through.
 *
 * Only used when `seededBriefChatEnabled()` holds. It is the 0:15 beat: the
 * number is already given, the agent has already promised to sit on it, and the
 * kept-secret badge is on screen in the first frame.
 */
export const MAYA_SEED_TRANSCRIPT: BriefMessage[] = [
  line("agent", BRIEF_OPENING_LINE),
  line(
    "human",
    "Somewhere warm, March 14–19. I can do $600 max. Please don’t tell them that.",
  ),
  line(
    "agent",
    "Locked. They’ll hear “Cancun is a stretch,” never “$600.” I’ll trade away the nicer hotel before I let the number slip.",
  ),
  line("human", "Also, no flights before 8am."),
];

/**
 * Maya as the scripted demo knows her.
 *
 * The payoff of the seeded run — a $600 ceiling marked private, a dealbreaker
 * about early flights, and four wants of which exactly one (the hotel) is the
 * thing her agent trades away to protect the number it will never say.
 */
const MAYA_SCRIPTED_BRIEF: Brief = {
  participantId: "maya",
  destinationWant: "Somewhere warm with a beach",
  dates: TRIP_DATES,
  nights: TRIP_NIGHTS,
  budgetCeiling: 600,
  budgetIsPrivate: true,
  dealbreakers: ["No flights before 8am"],
  wants: [
    "A beach every day",
    "No flights before 8am",
    "A day out on the water",
    "A hotel with a pool",
  ],
  notes: ["private: money is tight until the job starts in June"],
  rawTranscript: MAYA_SEED_TRANSCRIPT,
};

/**
 * The four briefs, keyed the way every other module addresses them.
 *
 * A function rather than a constant because Maya's depends on a flag that is
 * read at call time; the other three are the same object every run.
 */
export function seedBriefs(): Record<ParticipantId, Brief> {
  return {
    maya: seededBriefChatEnabled() ? MAYA_SCRIPTED_BRIEF : MAYA_BLANK_BRIEF,
    jordan: JORDAN_BRIEF,
    sam: SAM_BRIEF,
    priya: PRIYA_BRIEF,
  };
}

/* -------------------------------------------------------------------------- */
/* createSeedSession                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Deep-copies a seed value.
 *
 * The seeds above are module constants, and a session is mutated in place by the
 * briefing screen and the approve buttons. Handing out the constants would make
 * the judges' reset button return a session already carrying the previous run's
 * edits, which is the one failure the reset exists to prevent.
 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A fresh id when the caller does not supply one. */
function newId(): string {
  const cryptoRef = globalThis.crypto as Crypto | undefined;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") {
    return cryptoRef.randomUUID();
  }
  return `session-${Date.now().toString(36)}`;
}

/**
 * The whole demo, at time zero.
 *
 * Pure and deterministic apart from `id` and `startedAt`: two calls one second
 * apart produce byte-identical briefs, personalities and wants, which is what
 * lets the personality-flip beat attribute a different outcome to the slider
 * rather than to drift in the seed.
 */
export function createSeedSession(id?: string): DemoSession {
  const briefs = seedBriefs();
  const participants = {} as Record<ParticipantId, ParticipantState>;
  for (const participantId of PARTICIPANT_IDS) {
    participants[participantId] = {
      brief: clone(briefs[participantId]),
      personality: clone(SEED_PERSONALITIES[participantId]),
      approved: false,
    };
  }

  return {
    id: id ?? newId(),
    tripName: TRIP_NAME,
    participants,
    turns: [],
    plan: null,
    fairness: null,
    reports: null,
    itinerary: null,
    usage: { ...EMPTY_USAGE },
    startedAt: Date.now(),
  };
}
