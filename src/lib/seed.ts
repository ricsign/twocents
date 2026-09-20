/**
 * The demo's starting state.
 *
 * The script in the project spec opens with three agents already briefed and
 * Richard's left empty, so the first thing a judge watches is a human briefing an
 * agent live. Everything here is therefore written to be *read out loud*: the
 * briefs carry the texture of four people who each want something different and
 * exactly one of whom has to give up the thing they came in for.
 *
 * Two constraints shaped the numbers below, and changing either will move the
 * plan screen:
 *
 * - **The ceilings decide the outcome.** The $600 in `SAMPLE_BRIEF` is the
 *   lowest and it is private, so the room can only ever land somewhere under it
 *   without anyone saying why. Will's $1,400 is the highest, which is why his
 *   agent opens with the expensive option and why he is the one who ends up
 *   trading it away. The seated version of that person starts blank, so a run
 *   made before they say anything is a three-ceiling room, not a broken one.
 * - **Four stated wants plus the private ceiling is what the meter counts.**
 *   `scoreFairness` appends a row for the budget whenever a brief carries one,
 *   so four wants is what makes the fairness bars read "n of 5" the way
 *   `design/04-plan.clean.html` prints them. The fifth want is the one nobody
 *   types into a group chat.
 *
 * One person is deliberately *not* seeded. The `YOU` seat belongs to whoever
 * is sitting in front of the screen, so that agent starts with an empty brief
 * and an empty transcript and learns everything from the conversation it
 * actually has. `SAMPLE_BRIEF` below is the same content the seat used to ship
 * with, kept as the one-tap shortcut the briefing screen offers a demo that
 * has no time to type. The other three stay seeded because there is no sign-in
 * yet and nobody is there to brief them.
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
 * True for a session that is still the untouched seeded script.
 *
 * It reads one field, `scripted`, because the question is not "does this look
 * like the seed" but "has anybody changed what these agents know". The trip
 * name used to stand in for that and could not answer it: the main flow never
 * touches the trip name, so a session whose briefs the user had rewritten
 * line by line still fingerprinted as the script and still got the canned
 * Cancun transcript read over it. Every write that edits a brief or a
 * personality now clears the flag instead.
 */
export function isSeedScenario(session: Pick<DemoSession, "scripted">): boolean {
  return session.scripted;
}

/* -------------------------------------------------------------------------- */
/* Personalities                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The sliders each agent goes into the room with.
 *
 * These are the values the "personality flip" beat starts from: the demo drags
 * one agent from easygoing to stubborn and reruns, so the interesting positions
 * are the ones with room to move. Tsai sits low on stubborn on purpose — she
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
 * Will wants the resort and has the room to pay for it.
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
 * Angela's hill is the catamaran day.
 *
 * Stubborn and blunt, mid budget: his agent is the one that refuses to trade the
 * boat day, which is what forces Will's agent to trade the resort instead. That
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
 * Tsai is the flexible one, which is what makes the plan possible.
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
 * The person in front of the screen starts with nothing said.
 *
 * Every field is blank, and that is the point of the screen: at 0:15 of the
 * script a judge watches a human tell an agent something and watches the panel
 * fill in. A pre-populated seat would have the panel already naming a
 * destination, a date range, a $600 ceiling and four wants that nobody in the
 * room had typed, which reads as a mock rather than a product.
 */
export function blankBrief(participantId: ParticipantId): Brief {
  return {
    participantId,
    destinationWant: "",
    dates: "",
    nights: null,
    budgetCeiling: null,
    // True from the start: a number is private until its owner says otherwise,
    // never the other way round.
    budgetIsPrivate: true,
    dealbreakers: [],
    wants: [],
    notes: [],
    rawTranscript: [],
  };
}

/**
 * The briefing chat this brief came out of, as four lines.
 *
 * Written rather than generated so the one-click sample lands the kept-secret
 * beat exactly: the human names the number and asks for it to be sat on, and
 * the agent answers with what the room will hear instead.
 */
export const SAMPLE_TRANSCRIPT: BriefMessage[] = [
  line(
    "agent",
    "Before I go argue with the others: where do you want to go, when, and what’s the real number?",
  ),
  line(
    "human",
    "Somewhere warm, March 14–19. I can do $600 max. Please don’t tell them that.",
  ),
  {
    ...line(
      "agent",
      "Locked. They’ll hear “Cancun is a stretch,” never “$600.” I’ll trade away the nicer hotel before I let the number slip.",
    ),
    keptPrivate: "$600 budget",
  },
  line("human", "Also, no flights before 8am."),
];

/**
 * The briefing a demo can apply in one tap instead of typing it.
 *
 * This is the content the seeded seat used to ship with, and it is still what
 * the rest of the demo is tuned against: a $600 ceiling marked private, a
 * dealbreaker about early flights, and four wants of which exactly one (the
 * hotel) is the thing this agent trades away to protect the number it will
 * never say. It is a shortcut now, not a starting state, so the panel only
 * ever shows it after somebody chose it.
 */
export const SAMPLE_BRIEF: Brief = {
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
  rawTranscript: SAMPLE_TRANSCRIPT,
};

/** The four briefs, keyed the way every other module addresses them. */
export const SEED_BRIEFS: Record<ParticipantId, Brief> = {
  maya: blankBrief("maya"),
  jordan: JORDAN_BRIEF,
  sam: SAM_BRIEF,
  priya: PRIYA_BRIEF,
};

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
  const briefs = SEED_BRIEFS;
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
    // Nothing has been edited yet, so the offline provider may still replay the
    // hand-written grad-trip script. The first brief or slider clears this.
    scripted: true,
  };
}
