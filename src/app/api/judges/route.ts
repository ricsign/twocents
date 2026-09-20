/**
 * The judges' round, in one POST.
 *
 * At 2:20 of a three-minute demo a judge gets to brief four agents for their
 * own dinner. Everything about this route is shaped by that clock: one request
 * carries the whole room, it is validated in one pass, and it lands as a
 * session the town screen can already run. There is no second call to make and
 * nothing to confirm.
 *
 * Two decisions worth naming:
 *
 * - **It replaces the demo session rather than making a new one.** Every screen
 *   in this app reads `DEFAULT_SESSION_ID`, so a judges' run stored under a
 *   fresh id would negotiate in the town and then find nothing on `/plan`.
 *   Seeding the default session means the judge gets the whole product — town,
 *   plan, private report, fairness — off one button, and the next RESET puts
 *   the scripted grad trip back.
 * - **The mini-brief is deliberately three fields.** A name, a one-line want,
 *   and the number nobody says out loud. That last field is the product; the
 *   rest is context. Anything more is typing a judge does instead of watching
 *   agents argue.
 *
 * Server-only. No React, no DOM.
 */

import { z } from "zod";
import { PARTICIPANT_IDS, YOU, type ParticipantId } from "@/lib/characters";
import { SEED_PERSONALITIES } from "@/lib/seed";
import { DEFAULT_SESSION_ID, resetSession, updateSession } from "@/lib/session";
import { sessionViewFor } from "@/lib/session-view";
import {
  EMPTY_USAGE,
  participantIdSchema,
  type Brief,
  type BriefMessage,
  type ParticipantState,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Request                                                                     */
/* -------------------------------------------------------------------------- */

/** One seat at the table, as the judges' form collects it. */
const miniBriefSchema = z.object({
  participantId: participantIdSchema,
  /** Who the agent speaks for. Quoted into the agent's own persona. */
  name: z.string().trim().min(1).max(40),
  /** One line: "somewhere with actual vegetarian food, not a side salad". */
  want: z.string().trim().min(1).max(240),
  /** The private ceiling. Null when the judge left it blank. */
  budget: z.number().min(0).max(100_000).nullable(),
});

type MiniBrief = z.infer<typeof miniBriefSchema>;

const requestSchema = z.object({
  /** Printed on the top bar and argued over. "Dinner tonight". */
  topic: z.string().trim().min(1).max(60),
  /** Free text, the way the briefing chat takes it. "Tonight, 7pm". */
  when: z.string().trim().min(1).max(60),
  /** All four seats, in any order; the handler indexes them by id. */
  people: z.array(miniBriefSchema).length(PARTICIPANT_IDS.length),
});

/* -------------------------------------------------------------------------- */
/* Building a brief out of three fields                                        */
/* -------------------------------------------------------------------------- */

/**
 * Splits one typed line into separate wants.
 *
 * The fairness meter counts wants kept against wants stated, so a judge who
 * typed "cheap, close to campus and not Italian" should get three bars' worth
 * of scoring rather than one. Conservative on purpose: it only cuts on commas
 * and a standalone "and", never mid-phrase, so "fish and chips" survives.
 */
function splitWants(line: string): string[] {
  return line
    .split(/\s*,\s*|\s+and\s+/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 1)
    .slice(0, 4);
}

/** The briefing chat the judge did not have time to have, written out. */
function transcriptFor(mini: MiniBrief, topic: string): BriefMessage[] {
  const lines: BriefMessage[] = [
    { role: "agent", text: `What does a good ${topic} look like for you?` },
    { role: "human", text: mini.want },
  ];
  if (mini.budget !== null) {
    lines.push({
      role: "agent",
      text: "And the most you want to spend? I will argue around it, never say it.",
    });
    lines.push({ role: "human", text: `${mini.budget}. Keep that between us.` });
  }
  return lines;
}

function briefFrom(mini: MiniBrief, topic: string, when: string): Brief {
  const wants = splitWants(mini.want);
  return {
    participantId: mini.participantId,
    destinationWant: mini.want,
    dates: when,
    // A dinner has no nights, and the engine fills the field on the offer it
    // builds. Claiming a number here would put one in the prompt that nobody
    // asked for.
    nights: null,
    budgetCeiling: mini.budget,
    // The whole point of the round: the number is private unless it is absent.
    budgetIsPrivate: mini.budget !== null,
    dealbreakers: [],
    wants: wants.length > 0 ? wants : [mini.want],
    notes: [],
    rawTranscript: transcriptFor(mini, topic),
  };
}

/**
 * Where each seat sits on frugal-to-splurgy, by how its budget compares to the
 * other three. Four points, spread wide enough to cross the thresholds in
 * `PERSONALITY_THRESHOLDS` so the room actually sounds different.
 */
const SPLURGY_BY_RANK = [12, 38, 62, 88] as const;

/** The mid-point, for a seat the judge left with no ceiling at all. */
const SPLURGY_NO_CEILING = 50;

/**
 * Turns four typed budgets into four positions on the money slider.
 *
 * `priceStanceFor` bands a ceiling against per-person *trip* totals, so four
 * dinner budgets all land on "must be cheap" and the room loses the one axis
 * it argues hardest along. Ranking the four against each other restores it:
 * the judge who typed the biggest number gets the agent that will pay up, the
 * one who typed the smallest gets the agent that protects the money, and both
 * behaviours are derived from what the judge actually entered rather than
 * assigned at random.
 *
 * The ceiling itself is untouched. It is the secret the redactor guards and
 * the figure the private report explains, and it has to stay the number the
 * judge typed for either of those to mean anything.
 */
function splurgyByBudget(people: readonly MiniBrief[]): Map<ParticipantId, number> {
  const withBudget = people
    .filter((person) => person.budget !== null)
    .sort((a, b) => (a.budget as number) - (b.budget as number));

  const out = new Map<ParticipantId, number>();
  for (const person of people) out.set(person.participantId, SPLURGY_NO_CEILING);

  withBudget.forEach((person, index) => {
    // Spread across the four points even when fewer than four seats named a
    // number, so two budgets still read as "the frugal one and the other one".
    const slot =
      withBudget.length === 1
        ? SPLURGY_NO_CEILING
        : SPLURGY_BY_RANK[
            Math.round((index / (withBudget.length - 1)) * (SPLURGY_BY_RANK.length - 1))
          ];
    out.set(person.participantId, slot);
  });

  return out;
}

/**
 * The seed personalities, re-tuned for whoever the judge named.
 *
 * Reusing the spread rather than defaulting all four to the same preset: four
 * identical agents produce a polite, boring room, and the four seeded
 * personalities are already tuned to argue with each other. The bio is
 * replaced because it is the one line quoted verbatim into the agent's own
 * voice, and `splurgy` because that is the slider the judge's budget speaks
 * through.
 */
function personalityFor(mini: MiniBrief, splurgy: number) {
  const base = SEED_PERSONALITIES[mini.participantId];
  return {
    ...base,
    splurgy,
    bio: `Speaking for ${mini.name}, who said: "${mini.want}"`,
  };
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                     */
/* -------------------------------------------------------------------------- */

export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json(
      { error: "invalid request", issues: [{ path: "", message: "body must be JSON" }] },
      { status: 400 },
    );
  }

  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      {
        error: "invalid request",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  const { topic, when, people } = parsed.data;

  const byId = new Map<ParticipantId, MiniBrief>(
    people.map((person) => [person.participantId, person]),
  );
  const missing = PARTICIPANT_IDS.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return Response.json(
      {
        error: "invalid request",
        issues: [{ path: "people", message: `missing a brief for ${missing.join(", ")}` }],
      },
      { status: 400 },
    );
  }

  const splurgy = splurgyByBudget(people);

  const participants = {} as Record<ParticipantId, ParticipantState>;
  for (const id of PARTICIPANT_IDS) {
    const mini = byId.get(id) as MiniBrief;
    participants[id] = {
      brief: briefFrom(mini, topic, when),
      personality: personalityFor(mini, splurgy.get(id) ?? SPLURGY_NO_CEILING),
      approved: false,
      // The seat keeps its sprite and its colour; only the name changes. From
      // here on `displayNameFor` is what every label and every prompt reads,
      // so the judge watches their own party argue rather than the cast.
      displayName: mini.name,
    };
  }

  // Reset first so nothing from the previous run — a plan, an approval, the
  // last judge's transcript — can survive the patch below.
  resetSession(DEFAULT_SESSION_ID);
  const session = updateSession(DEFAULT_SESSION_ID, {
    tripName: topic,
    participants,
    turns: [],
    plan: null,
    fairness: null,
    reports: null,
    usage: { ...EMPTY_USAGE },
    startedAt: Date.now(),
    // This room is the judge's, not the script's. Leaving the flag set would
    // have the offline provider read the canned Cancun transcript over four
    // briefs about dinner.
    scripted: false,
  });

  if (!session) {
    return Response.json({ error: "could not seed the session" }, { status: 500 });
  }

  // The id is what the client needs; the view rides along so a caller poking at
  // this route with curl can see what it built, already narrowed to one person.
  return Response.json({
    sessionId: session.id,
    tripName: session.tripName,
    view: sessionViewFor(session, YOU),
  });
}
