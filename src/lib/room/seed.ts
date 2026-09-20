/**
 * Turning a handful of described people into a session the town can run.
 *
 * Two screens arrive here from opposite directions and leave with the same
 * thing. The judges' round has four seats a human typed, including the number
 * they typed privately. The photo path has up to four seats a model read off a
 * group chat, with no number at all — because there is no honest way to learn
 * one from a screenshot, and inventing it would mean a host's photograph
 * decided somebody else's private ceiling.
 *
 * This file was the body of `/api/judges` first. Pulling it out is what lets
 * the photo path reuse a shape that has already been demonstrated on stage,
 * rather than growing a second, less-tested way to fill four seats.
 *
 * Server-only. No React, no DOM.
 */

import { PARTICIPANT_IDS, type ParticipantId } from "@/lib/characters";
import type { MoneyTone, SeatBrief } from "@/lib/room/seat";
import { SEED_PERSONALITIES } from "@/lib/seed";
import { resetSession, updateSession } from "@/lib/session";
import {
  EMPTY_USAGE,
  type Brief,
  type BriefMessage,
  type DemoSession,
  type ParticipantState,
  type Personality,
  type Usage,
} from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* One seat                                                                    */
/* -------------------------------------------------------------------------- */

// Re-exported so the two routes that seed a room need one import, not two.
export { moneyToneSchema, seatBriefSchema } from "@/lib/room/seat";
export type { MoneyTone, SeatBrief } from "@/lib/room/seat";

/* -------------------------------------------------------------------------- */
/* Building a brief out of a description                                       */
/* -------------------------------------------------------------------------- */

/**
 * Splits one typed line into separate wants.
 *
 * The fairness meter counts wants kept against wants stated, so a judge who
 * typed "cheap, close to campus and not Italian" should get three bars' worth
 * of scoring rather than one. Conservative on purpose: it only cuts on commas
 * and a standalone "and", never mid-phrase, so "fish and chips" survives.
 */
export function splitWants(line: string): string[] {
  return line
    .split(/\s*,\s*|\s+and\s+/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 1)
    .slice(0, 4);
}

/**
 * The briefing chat this person did not have, written out.
 *
 * `spoken` is the whole difference between the two paths, and getting it wrong
 * would be a quiet lie rather than a bug. A judge typed the want, so recording
 * it as a human turn is a faithful transcript. Nobody said anything to an agent
 * in a group-chat screenshot — and `/api/brief` re-derives the structured brief
 * from `rawTranscript` on every turn, so a fabricated human line would come
 * back as testimony the person never gave.
 *
 * So a photo-seeded transcript is agent turns only, and it ends on the question
 * the product exists to ask. The first thing that person types is their own
 * ceiling, to their own agent, which is exactly where it belongs.
 */
export function transcriptFor(
  seat: SeatBrief,
  topic: string,
  options: { spoken: boolean },
): BriefMessage[] {
  if (!options.spoken) {
    return [
      {
        role: "agent",
        text: `Your group chat says you are in on ${topic}. From what I read, you wanted ${seat.want} — did I get that right?`,
      },
      {
        role: "agent",
        text: "And this one stays with me: what is the most you can spend?",
      },
    ];
  }

  const lines: BriefMessage[] = [
    { role: "agent", text: `What does a good ${topic} look like for you?` },
    { role: "human", text: seat.want },
  ];
  if (seat.budget !== null) {
    lines.push({
      role: "agent",
      text: "And the most you want to spend? I will plan around it, never say it.",
    });
    lines.push({ role: "human", text: `${seat.budget}. Keep that between us.` });
  }
  return lines;
}

export function briefFrom(seat: SeatBrief, topic: string, when: string): Brief {
  const wants = seat.wants?.length ? seat.wants : splitWants(seat.want);
  return {
    participantId: seat.participantId,
    destinationWant: seat.want,
    dates: seat.dates?.trim() || when,
    // A dinner has no nights, and the engine fills the field on the offer it
    // builds. Claiming a number here would put one in the prompt that nobody
    // asked for.
    nights: null,
    budgetCeiling: seat.budget,
    // The whole point of the round: the number is private unless it is absent.
    budgetIsPrivate: seat.budget !== null,
    dealbreakers: seat.dealbreakers ?? [],
    wants: wants.length > 0 ? wants : [seat.want],
    notes: [],
    rawTranscript: transcriptFor(seat, topic, { spoken: seat.draft === undefined }),
  };
}

/* -------------------------------------------------------------------------- */
/* The money slider                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Where each seat sits on frugal-to-splurgy, by how it compares to the others.
 * Four points, spread wide enough to cross the thresholds in
 * `PERSONALITY_THRESHOLDS` so the room actually sounds different.
 */
const SPLURGY_BY_RANK = [12, 38, 62, 88] as const;

/** The mid-point, for a seat with nothing at all to go on. */
const SPLURGY_NO_CEILING = 50;

/**
 * How a *stated* tone maps onto the same four points, when no budgets exist.
 *
 * `unstated` is deliberately absent rather than mapped to the midpoint. It is
 * the enum's way of saying "this person never mentioned money", which is not a
 * position on the slider — it is the absence of one, and pinning it to 50
 * would silently outrank the two better guesses underneath it. A real reading
 * of a real chat comes back mostly `unstated`, so this is the common case
 * rather than the edge: three of four seats landing on the same number is the
 * flat room this whole function exists to prevent.
 */
const SPLURGY_BY_TONE: Record<Exclude<MoneyTone, "unstated">, number> = {
  cheap: SPLURGY_BY_RANK[0],
  mixed: SPLURGY_NO_CEILING,
  splurgy: SPLURGY_BY_RANK[3],
};

/**
 * Turns whatever is known about money into four positions on the slider.
 *
 * `priceStanceFor` bands a ceiling against per-person *trip* totals, so four
 * dinner budgets all land on "must be cheap" and the room loses the one axis
 * it argues hardest along. Ranking the seats against each other restores it:
 * the biggest number gets the agent that will pay up, the smallest gets the
 * agent that protects the money, and both behaviours are derived from what was
 * actually said rather than assigned at random.
 *
 * Four sources, in descending order of how much they actually know:
 *
 * 1. **Budgets, ranked against each other.** What the judges' round has.
 * 2. **Money tone**, when somebody actually talked about money. Without this
 *    step every photo-seeded seat would fall to the midpoint together — all
 *    four agents on the same slider, which is the failure this function exists
 *    to prevent. `unstated` is not a tone and falls through to the next source.
 * 3. **A slider that came with the seat**, from a personality guess.
 * 4. **The seeded spread**, which is already tuned to argue with itself.
 *
 * The ceiling itself is untouched. It is the secret the redactor guards and
 * the figure the private report explains, and it has to stay the number the
 * person gave for either of those to mean anything.
 */
export function splurgyFor(seats: readonly SeatBrief[]): Map<ParticipantId, number> {
  const out = new Map<ParticipantId, number>();

  const withBudget = seats
    .filter((seat) => seat.budget !== null)
    .sort((a, b) => (a.budget as number) - (b.budget as number));

  for (const seat of seats) {
    out.set(
      seat.participantId,
      seat.moneyTone && seat.moneyTone !== "unstated"
        ? SPLURGY_BY_TONE[seat.moneyTone]
        : (seat.personality?.splurgy ??
          SEED_PERSONALITIES[seat.participantId]?.splurgy ??
          SPLURGY_NO_CEILING),
    );
  }

  withBudget.forEach((seat, index) => {
    // Spread across the four points even when fewer than four seats named a
    // number, so two budgets still read as "the frugal one and the other one".
    const slot =
      withBudget.length === 1
        ? SPLURGY_NO_CEILING
        : SPLURGY_BY_RANK[
            Math.round((index / (withBudget.length - 1)) * (SPLURGY_BY_RANK.length - 1))
          ];
    out.set(seat.participantId, slot);
  });

  return out;
}

/**
 * The seed personalities, re-tuned for whoever is actually in the seat.
 *
 * Reusing the spread rather than defaulting all four to the same preset: four
 * identical agents produce a polite, boring room, and the four seeded
 * personalities are already tuned to argue with each other. The bio is
 * replaced because it is the one line quoted verbatim into the agent's own
 * voice, and `splurgy` because that is the slider money speaks through.
 */
export function personalityFor(seat: SeatBrief, splurgy: number): Personality {
  const base = SEED_PERSONALITIES[seat.participantId];
  return {
    ...base,
    ...seat.personality,
    splurgy,
    bio: seat.bio?.trim() || `Speaking for ${seat.name}, who said: "${seat.want}"`,
  };
}

/* -------------------------------------------------------------------------- */
/* Seeding a session                                                           */
/* -------------------------------------------------------------------------- */

/**
 * An open seat: a person who is not there, played by the cast member who is.
 *
 * A group chat with three people in it still negotiates four-way, because
 * `groupTotal` is `perPerson * PARTICIPANT_IDS.length` in both the engine and
 * the itinerary and a three-person room would price for four anyway. Keeping
 * the fourth seat real and seeded is the honest version of that arithmetic —
 * and it leaves somewhere for a fourth friend to join later.
 *
 * It keeps its cast name, so nothing renders nameless, and it carries no
 * `displayName` override, which is how every screen can tell it apart.
 */
function openSeat(id: ParticipantId, topic: string, when: string): ParticipantState {
  return {
    brief: {
      participantId: id,
      destinationWant: `Somewhere that works for everyone on ${topic}`,
      dates: when,
      nights: null,
      budgetCeiling: null,
      budgetIsPrivate: false,
      dealbreakers: [],
      wants: ["somewhere that works for everyone"],
      notes: [],
      rawTranscript: [],
    },
    personality: { ...SEED_PERSONALITIES[id] },
    approved: false,
    claimedAt: null,
  };
}

/**
 * Replaces a session with a room built from these seats.
 *
 * Resets first so nothing from a previous run — a plan, an approval, the last
 * judge's transcript — can survive the patch. The id is a parameter because
 * the judges' round must land on `DEFAULT_SESSION_ID` (every screen used to
 * read it by name) while a room lands on its own code.
 */
export function seedRoom(options: {
  sessionId: string;
  topic: string;
  when: string;
  seats: readonly SeatBrief[];
  /** The cost of reading the chat, so the plan screen can account for it. */
  usage?: Usage;
}): DemoSession | undefined {
  const { sessionId, topic, when, seats, usage } = options;

  const bySeat = new Map<ParticipantId, SeatBrief>(
    seats.map((seat) => [seat.participantId, seat]),
  );
  const splurgy = splurgyFor(seats);

  const participants = {} as Record<ParticipantId, ParticipantState>;
  for (const id of PARTICIPANT_IDS) {
    const seat = bySeat.get(id);
    if (!seat) {
      participants[id] = openSeat(id, topic, when);
      continue;
    }
    participants[id] = {
      brief: briefFrom(seat, topic, when),
      personality: personalityFor(seat, splurgy.get(id) ?? SPLURGY_NO_CEILING),
      approved: false,
      // The seat keeps its sprite and its colour; only the name changes. From
      // here on `displayNameFor` is what every label and every prompt reads,
      // so people watch their own party argue rather than the cast.
      displayName: seat.name,
      claimedAt: null,
      ...(seat.draft ? { draft: seat.draft } : {}),
    };
  }

  resetSession(sessionId);
  return updateSession(sessionId, {
    tripName: topic,
    participants,
    turns: [],
    plan: null,
    fairness: null,
    reports: null,
    itinerary: null,
    usage: usage ? { ...usage } : { ...EMPTY_USAGE },
    startedAt: Date.now(),
    hostSeat: null,
    runStartedAt: null,
    // This room is somebody's, not the script's. Leaving the flag set would
    // have the offline provider read the canned grad-trip transcript over four
    // briefs about a different trip entirely.
    scripted: false,
  });
}
