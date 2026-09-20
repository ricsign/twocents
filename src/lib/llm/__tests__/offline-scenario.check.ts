/**
 * Runnable checks for the offline provider's two answers.
 *
 * `OfflineProvider` replays a hand-written script for the seeded grad trip and
 * generates a negotiation over the session it was actually given for anything
 * else. Both halves have a property that has to hold on stage:
 *
 * - **The seeded run never changes.** `SEEDED_TRANSCRIPT` below is the exact
 *   output of a canned run, captured before `lib/llm/scenario.ts` existed. It is
 *   the copy `design/03-town.clean.html` and `design/04-plan.clean.html` were
 *   built around and the run the whole demo is timed against, so a diff here is
 *   a regression even when the new line reads better.
 * - **A generated run holds every secret.** Every public line it produces is
 *   scanned with the same guard the engine uses. The engine would redact a leak
 *   anyway; generating one and having it patched up is a worse sentence than one
 *   that never contained the figure, so the generator is held to the stricter
 *   standard here.
 *
 * Not a vitest suite on purpose: this project ships no test runner, and adding
 * one to `package.json` for a handful of pure modules is a dependency the demo
 * would carry for nothing. Run it directly:
 *
 *   npx tsx src/lib/llm/__tests__/offline-scenario.check.ts
 *
 * `tsx` is not among this project's dependencies and nothing here is allowed to
 * add one, so the route that works today is compile-then-run: point `tsc` at
 * this folder with `@/*` mapped to `src/*` and an `outDir` of your choosing,
 * symlink `<outDir>/node_modules/@` to `<outDir>` so the alias resolves at
 * runtime, then `node <outDir>/lib/llm/__tests__/offline-scenario.check.js`.
 */

import assert from "node:assert/strict";
import type { z } from "zod";
import { PARTICIPANT_IDS, type ParticipantId } from "@/lib/characters";
import { OfflineProvider } from "@/lib/llm/offline";
import type {
  CompletionRequest,
  CompletionResult,
  LLMProvider,
  TaskTag,
} from "@/lib/llm/provider";
import {
  buildScenario,
  scenarioPlan,
  scenarioReport,
  scenarioTurn,
  type OfflineHints,
} from "@/lib/llm/scenario";
import { STANCE_CEILING, runNegotiation } from "@/lib/negotiation/engine";
import { GAVE_UP_BUDGET } from "@/lib/negotiation/fairness";
import { checkForLeaks } from "@/lib/negotiation/redaction";
import {
  SAMPLE_BRIEF,
  SEED_PERSONALITIES,
  TRIP_NAME,
  createSeedSession,
} from "@/lib/seed";
import {
  EMPTY_USAGE,
  secretsFromBrief,
  type Brief,
  type DemoSession,
  type NegotiationEvent,
  type ParticipantState,
  type TurnKind,
} from "@/lib/types";


/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

let failures = 0;

async function check(name: string, run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Every event of one offline run, in order.
 *
 * `roundCap` is left at the shipped default unless a check is deliberately
 * running the room long to see whether the generator's copy holds up.
 */
async function runOffline(session: DemoSession, roundCap?: number): Promise<NegotiationEvent[]> {
  const events: NegotiationEvent[] = [];
  for await (const event of runNegotiation({
    session,
    provider: new OfflineProvider(),
    ...(roundCap === undefined ? {} : { roundCap }),
  })) {
    events.push(event);
  }
  return events;
}

/**
 * The offline provider with a tally on it.
 *
 * Two things the events alone cannot say. **When** a call happened: `usage`
 * only reaches a browser on the `done` frame, so "no plan had been written yet
 * when the room announced its agreement" needs the count read at the moment
 * the `agreed` frame is drained. And **how** the calls overlapped: `peak` is
 * the most that were ever in flight at once, which is what tells four
 * concurrent reports apart from four sequential ones.
 *
 * Wraps rather than reimplements, so every answer is still the canned one and
 * a run through this provider is the run the checks elsewhere in this file
 * assert on.
 */
class CountingProvider implements LLMProvider {
  readonly name = "offline-counting";
  readonly live = false;

  private readonly inner = new OfflineProvider();
  private readonly counts = new Map<TaskTag, number>();
  private inFlight = 0;

  /** Every call so far, of any kind. */
  calls = 0;
  /** The most calls that were ever outstanding at the same moment. */
  peak = 0;

  async text(req: CompletionRequest): Promise<CompletionResult<string>> {
    this.enter(req.tag);
    try {
      return await this.inner.text(req);
    } finally {
      this.inFlight -= 1;
    }
  }

  async json<T>(
    req: CompletionRequest,
    schema: z.ZodType<T>,
  ): Promise<CompletionResult<T>> {
    this.enter(req.tag);
    try {
      return await this.inner.json(req, schema);
    } finally {
      this.inFlight -= 1;
    }
  }

  /** How many calls of one kind have been made. */
  made(tag: TaskTag): number {
    return this.counts.get(tag) ?? 0;
  }

  private enter(tag: TaskTag): void {
    this.calls += 1;
    this.counts.set(tag, this.made(tag) + 1);
    this.inFlight += 1;
    if (this.inFlight > this.peak) this.peak = this.inFlight;
  }
}

/**
 * The offline provider with one kind of call held at the door.
 *
 * `CountingProvider` can say how many calls happened and how many overlapped;
 * it cannot say that something reached the screen *while* a call was still
 * outstanding, because the canned provider answers in microseconds and every
 * ordering looks instantaneous. This one holds every call of one tag until
 * `release`, which makes "the offer was on the table before its check had
 * answered" a thing a check can actually observe rather than infer.
 *
 * Wraps rather than reimplements, so a released call still returns the canned
 * answer the rest of this file asserts on.
 */
class GatedProvider implements LLMProvider {
  readonly name = "offline-gated";
  readonly live = false;

  private readonly inner = new OfflineProvider();
  private readonly gate: TaskTag;
  private readonly held: (() => void)[] = [];

  /** Gated calls that have entered, and gated calls that have answered. */
  started = 0;
  finished = 0;

  constructor(gate: TaskTag) {
    this.gate = gate;
  }

  async text(req: CompletionRequest): Promise<CompletionResult<string>> {
    await this.hold(req.tag);
    const result = await this.inner.text(req);
    this.finish(req.tag);
    return result;
  }

  async json<T>(
    req: CompletionRequest,
    schema: z.ZodType<T>,
  ): Promise<CompletionResult<T>> {
    await this.hold(req.tag);
    const result = await this.inner.json(req, schema);
    this.finish(req.tag);
    return result;
  }

  /** Lets everything waiting through. Safe when nothing is. */
  release(): void {
    for (const resume of this.held.splice(0)) resume();
  }

  private hold(tag: TaskTag): Promise<void> {
    if (tag !== this.gate) return Promise.resolve();
    this.started += 1;
    return new Promise<void>((resolve) => {
      this.held.push(resolve);
    });
  }

  private finish(tag: TaskTag): void {
    if (tag === this.gate) this.finished += 1;
  }
}

/** One line of a hand-written room, as the engine's turn schema wants it. */
interface ScriptedLine {
  kind: TurnKind;
  text: string;
  /** An `offerDraftSchema` shape: everything but `proposedBy` and the verdict. */
  offer?: Record<string, unknown>;
}

/**
 * A room whose public lines are written here rather than generated.
 *
 * The canned generator is built to land on something everybody can afford,
 * which is the one run this cannot be: the rule under test is what the engine
 * does when the whole table says yes to an option nobody's stance covers. So
 * `negotiation-turn` is answered from a script and every other call still goes
 * to `OfflineProvider`, which keeps the price checks, the write-up and the
 * four reports on the same rails as the rest of this file.
 *
 * The script is indexed by call rather than by speaker, which is exact as long
 * as no line is ever generated twice: the engine re-asks when an agent repeats
 * itself verbatim, and a second call for one seat would shift every line after
 * it. Each line below is therefore unique.
 */
class ScriptedRoomProvider implements LLMProvider {
  readonly name = "offline-scripted-room";
  readonly live = false;

  private readonly inner = new OfflineProvider();
  private readonly lines: readonly ScriptedLine[];
  private spoken = 0;

  constructor(lines: readonly ScriptedLine[]) {
    this.lines = lines;
  }

  async text(req: CompletionRequest): Promise<CompletionResult<string>> {
    return this.inner.text(req);
  }

  async json<T>(
    req: CompletionRequest,
    schema: z.ZodType<T>,
  ): Promise<CompletionResult<T>> {
    if (req.tag !== "negotiation-turn") return this.inner.json(req, schema);

    const index = this.spoken;
    this.spoken += 1;
    // Past the end of the script the table keeps assenting, which is what the
    // fallback under test keys off. Numbered so no two lines are identical.
    const line: ScriptedLine = this.lines[index] ?? {
      kind: "agrees",
      text: `Still a yes here, and that is line ${index + 1}.`,
    };

    const parsed = schema.safeParse(line);
    if (!parsed.success) throw new Error(`scripted line ${index} is not a turn draft`);
    return {
      value: parsed.data,
      raw: JSON.stringify(line),
      usage: { ...EMPTY_USAGE, calls: 1, model: ["scripted"] },
      sources: [],
    };
  }
}

/**
 * The run flattened to one line per event.
 *
 * Compared as strings rather than field by field: a field-by-field check proves
 * the fields somebody remembered to list, while this catches a highlight that
 * moved, a price that shifted and a `gaveUp` clause that changed wording.
 * `agreedInMs` and the token tally are left out because they are measured, not
 * generated.
 */
function flatten(events: readonly NegotiationEvent[]): string[] {
  const lines: string[] = [];
  for (const event of events) {
    if (event.type === "speak") {
      lines.push(
        `${event.speaker}|${event.kind}|${event.text}` +
          (event.privateReasonKept ? `|${event.privateReasonKept}` : ""),
      );
    }
    if (event.type === "offer") {
      lines.push(
        `offer|${event.offer.id}|${event.offer.perPerson}|${event.offer.highlights.join(" / ")}`,
      );
    }
    if (event.type === "agreed") {
      lines.push(
        `plan|${event.plan.offer.id}|${event.plan.runnerUp?.id ?? "-"}|${event.plan.groupTotal}|` +
          `${event.plan.keptWants.join(" / ")}|${event.plan.runnerUpLostBecause}`,
      );
    }
    if (event.type === "done") {
      const rows = event.fairness.rows
        .map((row) => `${row.participantId}:${row.wantsKept}/${row.wantsTotal}:${row.gaveUp ?? "-"}`)
        .join(" ");
      lines.push(`fair|${rows}|${event.fairness.nobodyOverruled}`);
      // The written-up plan, which is a different line from the `plan|` one
      // above: `agreed` now fires the instant the room settles and carries the
      // offer it settled on, and the prose — runner-up, why it lost, the kept
      // wants — is written afterwards and arrives here.
      if (event.plan) {
        lines.push(
          `final|${event.plan.offer.id}|${event.plan.runnerUp?.id ?? "-"}|${event.plan.groupTotal}|` +
            `${event.plan.keptWants.join(" / ")}|${event.plan.runnerUpLostBecause}`,
        );
      }
    }
  }
  return lines;
}

/* -------------------------------------------------------------------------- */
/* 1. The seeded run, frozen                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Captured from a canned run of `createSeedSession()` before the generator
 * existed. Do not "fix" a line here: if the copy should change, change it in
 * `lib/llm/offline.ts`, check it still matches the design files, and recapture.
 *
 * Recaptured once, in PR #24, for the frame order rather than the copy. The
 * `plan|` line is the `agreed` frame, now emitted the instant the room settles
 * and carrying the offer it settled on with no write-up on it; the `final|`
 * line is the same plan as `done` carries it, and it is the one that has to
 * match the design files. Every spoken line, every offer and the fairness row
 * are byte for byte what they were.
 */
const SEEDED_TRANSCRIPT: readonly string[] = [
  "sam|proposes|Cancun, Mar 14–19. $1,180 a person, resort right on the beach. The flight’s 6am, but it’s the cheapest one out.",
  "offer|offer-cancun|1180|Resort on the beach / All-inclusive / One flight, no connection",
  "maya|pushes back|Cancun doesn’t work for us. Puerto Rico has the same beaches and cheaper flights.|$600 budget",
  "jordan|trades|Fine. But we keep the catamaran day.",
  "priya|agrees|That works for me. San Juan plus a day on Culebra — no passport, no 6am alarm. I’m in.",
  "sam|pushes back|The resort was the whole point. Strip a star off it and we’re just four people in a room with a fan.",
  "maya|counters|Puerto Rico, same dates. About $540 a person, catamaran kept, nothing leaving before 11am.|$600 budget",
  "offer|offer-puerto-rico|540|Beach every day / Catamaran day kept / Nothing leaves before 11am / No passports needed",
  "jordan|agrees|Catamaran’s in. Book it.",
  "priya|agrees|Still a yes. Everyone gets a beach day and nobody’s up at four in the morning.",
  "plan|offer-puerto-rico|-|2160|Beach every day / Catamaran day kept / Nothing leaves before 11am / No passports needed|",
  "fair|maya:4/5:gave up a hotel with a pool jordan:4/5:gave up nightlife within walking distance sam:3/5:gave up a resort on the beach priya:5/5:-|true",
  "final|offer-puerto-rico|offer-tulum|2160|Beach every day / Catamaran day kept / Nothing leaves before 11am / No passports needed|Tulum came in at $690 and every flight left at 6am."
];

/* -------------------------------------------------------------------------- */
/* 2. A judges-style room                                                      */
/* -------------------------------------------------------------------------- */

interface Seat {
  participantId: ParticipantId;
  want: string;
  wants: string[];
  budget: number;
}

/**
 * Builds the session `/api/judges` would build, without going through the route.
 * The three fields that matter are the ones the form collects: who they are,
 * what they want, and the number nobody says out loud.
 */
function judgesSession(topic: string, when: string, seats: readonly Seat[]): DemoSession {
  const session = createSeedSession("check-judges");
  const participants = {} as Record<ParticipantId, ParticipantState>;
  for (const seat of seats) {
    const brief: Brief = {
      participantId: seat.participantId,
      destinationWant: seat.want,
      dates: when,
      nights: null,
      budgetCeiling: seat.budget,
      budgetIsPrivate: true,
      dealbreakers: [],
      wants: seat.wants,
      notes: [],
      rawTranscript: [],
    };
    participants[seat.participantId] = {
      brief,
      personality: { ...SEED_PERSONALITIES[seat.participantId] },
      approved: false,
      // A judges' round is one human at one keyboard: nobody claims a seat, so
      // the other three stay NPCs. The generated run must not depend on that
      // either way, which is part of what these checks are proving.
      claimedAt: null,
    };
  }
  return {
    ...session,
    tripName: topic,
    participants,
    turns: [],
    plan: null,
    fairness: null,
    reports: null,
    usage: { ...EMPTY_USAGE },
    // Four briefs the judge typed, so the provider must generate rather than
    // replay. Exactly what `/api/judges` stores.
    scripted: false,
  };
}

const DINNER: readonly Seat[] = [
  { participantId: "maya", want: "real vegetarian food, walking distance", wants: ["real vegetarian food", "walking distance"], budget: 25 },
  { participantId: "jordan", want: "a proper bar, no reservation needed", wants: ["a proper bar", "no reservation needed"], budget: 45 },
  { participantId: "sam", want: "the good steak place, somewhere worth dressing up for", wants: ["the good steak place", "somewhere worth dressing up for"], budget: 95 },
  { participantId: "priya", want: "quiet enough to talk, nothing too spicy", wants: ["quiet enough to talk", "nothing too spicy"], budget: 35 },
];

const NIGHT_OUT: readonly Seat[] = [
  { participantId: "maya", want: "somewhere we can actually hear each other, no queue", wants: ["somewhere we can actually hear each other", "no queue"], budget: 30 },
  { participantId: "jordan", want: "live music, a band worth standing up for", wants: ["live music", "a band worth standing up for"], budget: 80 },
  { participantId: "sam", want: "cocktails and a view, somewhere to dress up", wants: ["cocktails", "a view", "somewhere to dress up"], budget: 140 },
  { participantId: "priya", want: "karaoke, nothing that needs a list", wants: ["karaoke", "nothing that needs a list"], budget: 55 },
];

/** Asserts the properties every generated run has to have, whatever the topic. */
async function assertGeneratedRunIsSound(
  label: string,
  topic: string,
  when: string,
  seats: readonly Seat[],
): Promise<void> {
  const session = judgesSession(topic, when, seats);
  const events = await runOffline(session);

  const spoken = events.filter(
    (event): event is Extract<NegotiationEvent, { type: "speak" }> => event.type === "speak",
  );
  assert.ok(spoken.length >= 4, `${label}: the room should actually talk`);

  // The scripted grad trip must not be what a judge's room says.
  for (const turn of spoken) {
    assert.ok(
      !/Cancun|Puerto Rico|Tulum|catamaran/i.test(turn.text),
      `${label}: a generated line replayed the grad trip: ${turn.text}`,
    );
  }

  // THE GUARANTEE, held one level stricter than the engine holds it: the line
  // has to be clean as generated, not clean after redaction.
  for (const turn of spoken) {
    const brief = session.participants[turn.speaker]?.brief;
    if (!brief) continue;
    const scan = checkForLeaks(turn.text, secretsFromBrief(brief));
    assert.ok(scan.clean, `${label}: ${turn.speaker} leaked: ${turn.text}`);
  }

  // And no line names anybody else's ceiling either, which the engine's own
  // per-speaker scan would never look for.
  for (const turn of spoken) {
    for (const seat of seats) {
      assert.ok(
        !new RegExp(`(?<![0-9.,])${seat.budget}(?![0-9])`).test(turn.text),
        `${label}: a ceiling figure reached a public line: ${turn.text}`,
      );
    }
  }

  const agreed = events.find(
    (event): event is Extract<NegotiationEvent, { type: "agreed" }> => event.type === "agreed",
  );
  assert.ok(agreed, `${label}: the room never agreed`);

  const lowest = Math.min(...seats.map((seat) => seat.budget));
  assert.ok(
    agreed.plan.offer.perPerson <= lowest,
    `${label}: agreed ${agreed.plan.offer.perPerson} is over the lowest ceiling ${lowest}`,
  );

  const done = events.find(
    (event): event is Extract<NegotiationEvent, { type: "done" }> => event.type === "done",
  );
  assert.ok(done, `${label}: the run never finished`);
  assert.equal(done.fairness.nobodyOverruled, true, `${label}: somebody was overruled`);
  assert.equal(done.fairness.rows.length, PARTICIPANT_IDS.length, `${label}: a fairness row is missing`);

  for (const participantId of PARTICIPANT_IDS) {
    const report = done.reports[participantId];
    assert.ok(report, `${label}: ${participantId} got no private report`);
    assert.ok(report.gotYou.trim().length > 0, `${label}: ${participantId}'s report says nothing`);
  }

  // A room that repeats itself verbatim reads as a stalled negotiation on screen.
  const texts = spoken.map((turn) => turn.text);
  assert.equal(new Set(texts).size, texts.length, `${label}: a line was repeated verbatim`);
}

/* -------------------------------------------------------------------------- */
/* 2b. A table that says yes to what it cannot pay for                         */
/* -------------------------------------------------------------------------- */

/**
 * Four seats that all read as "must be cheap", so the room has one stance
 * ceiling and every option below is plainly over it.
 */
const OVER_CEILING_SEATS: readonly Seat[] = [
  { participantId: "maya", want: "a beach we can afford", wants: ["a beach"], budget: 600 },
  { participantId: "jordan", want: "somewhere with a night out", wants: ["a night out"], budget: 620 },
  { participantId: "sam", want: "a room with a view", wants: ["a view"], budget: 580 },
  { participantId: "priya", want: "somewhere warm and quiet", wants: ["somewhere quiet"], budget: 640 },
];

/** The shape every option in this room shares; only the name and price move. */
function overCeilingOffer(
  id: string,
  destination: string,
  perPerson: number,
): Record<string, unknown> {
  return {
    id,
    destination,
    region: "the coast",
    dates: "Mar 14–19",
    nights: 5,
    perPerson,
    highlights: ["Beach every day", "A kitchen", "Five nights"],
    flightNote: "Direct both ways, nothing early",
    lodgingNote: "A place with a kitchen, ten minutes from the water",
  };
}

/**
 * The room the fallback exists for: two options, both past what any of these
 * four can be asked to pay, and a table that says yes to them anyway.
 *
 * The expensive one is proposed *second* on purpose. "The most recent bookable
 * offer" and "the cheapest bookable offer" are the same answer in most rooms,
 * and this is the one ordering that tells the two rules apart.
 */
const OVER_CEILING_ROOM: readonly ScriptedLine[] = [
  {
    kind: "proposes",
    text: "Sandbar Key, five nights, a kitchen and a beach. It is a stretch, but it is the cheapest thing that works.",
    offer: overCeilingOffer("offer-sandbar", "Sandbar Key", 950),
  },
  {
    kind: "counters",
    text: "Cliff Harbour is the nicer week if we are stretching anyway. Same dates, same flights.",
    offer: overCeilingOffer("offer-cliff", "Cliff Harbour", 1200),
  },
  { kind: "agrees", text: "Either of those is fine by me. Pick one and I am in." },
  { kind: "agrees", text: "Same here. I will go with whatever the rest of you land on." },
];

/* -------------------------------------------------------------------------- */
/* 3. The seat that has said nothing                                           */
/* -------------------------------------------------------------------------- */

/**
 * The room before anybody types: three seeded briefs and the seat in front of
 * the screen exactly as `createSeedSession` leaves it — no destination, no
 * dates, no ceiling, no wants.
 *
 * `scripted` is cleared because that is what the first keystroke, the sample
 * brief and a slider all do, and because the point of these checks is what the
 * *generator* does with an empty brief rather than what the canned transcript
 * says.
 */
function unbriefedSeatSession(id: string): DemoSession {
  return { ...createSeedSession(id), scripted: false };
}

/** Hints for a four-seat room where exactly one person named no ceiling. */
function hintsWithOneUnknownCeiling(): OfflineHints {
  return {
    scenarioId: null,
    topic: TRIP_NAME,
    when: "Mar 14–19",
    nights: 5,
    priceCap: 1500,
    people: [
      // Seat zero, and the one the human sits in: nothing said at all.
      { participantId: "maya", name: "Richard", want: "", wants: [], ceiling: null },
      { participantId: "jordan", name: "Angela", want: "a city with nightlife", wants: ["a city with nightlife"], ceiling: 900 },
      { participantId: "sam", name: "Will", want: "a resort on the beach", wants: ["a resort on the beach"], ceiling: 1400 },
      { participantId: "priya", name: "Tsai", want: "somewhere with no passport", wants: ["somewhere with no passport"], ceiling: 1100 },
    ],
    offerIds: [],
    spokenCount: 0,
    attempt: 0,
  };
}

/**
 * The shapes a blank leaves behind when it is interpolated into a sentence.
 *
 * Everything the generator writes goes through `squeeze`, so runs of
 * whitespace and punctuation with nothing in front of it are not style
 * questions here — each one is a slot that was filled with `""`.
 */
const BLANK_SLOT: readonly RegExp[] = [
  /(^|\s)[.,;]/,
  /,\s*,/,
  /\s{2,}/,
  /\(\s*\)/,
];

/** The first blank-slot pattern this text trips, or null. */
function blankSlotIn(text: string): string | null {
  for (const pattern of BLANK_SLOT) {
    if (pattern.test(text)) return String(pattern);
  }
  return null;
}

/**
 * Every string anywhere inside a generated object.
 *
 * The generator hands back `Record<string, unknown>` — the plan and the
 * reports are validated into their shapes downstream — so walking the value
 * is what lets this scan the whole thing rather than the handful of fields
 * somebody remembered to list, including ones added later.
 */
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(stringsIn);
  }
  return [];
}

/**
 * A room where the fields the demo fills in last are still blank: no dates, no
 * nights, and nothing said at all by the seat with the most room on money —
 * which is the seat whose want the plan is built around and whose private
 * report names what it cost them.
 */
function hintsWithBlankFields(): OfflineHints {
  return {
    scenarioId: null,
    topic: TRIP_NAME,
    when: "",
    nights: null,
    priceCap: 1500,
    people: [
      { participantId: "maya", name: "Richard", want: "", wants: [], ceiling: 1400 },
      { participantId: "jordan", name: "Angela", want: "a city with nightlife", wants: ["a city with nightlife"], ceiling: 900 },
      { participantId: "sam", name: "Will", want: "", wants: [], ceiling: 800 },
      { participantId: "priya", name: "Tsai", want: "somewhere with no passport", wants: ["somewhere with no passport"], ceiling: 1100 },
    ],
    offerIds: [],
    spokenCount: 0,
    attempt: 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Run                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The seeded session with the sample brief applied to the seat in front of the
 * screen.
 *
 * That seat starts blank now, because the briefing screen is what fills it and
 * a panel pre-loaded with four wants nobody typed is a mock. The captured run
 * below was made against `SAMPLE_BRIEF`, which is the same content under a new
 * name, so the fixture applies it rather than the assertions being relaxed:
 * the fairness rows in `SEEDED_TRANSCRIPT` are scored from real briefs, and a
 * blank seat would score 0 of 0.
 */
function scriptedSession(id: string): DemoSession {
  const session = createSeedSession(id);
  session.participants.maya.brief = { ...SAMPLE_BRIEF };
  return session;
}

async function main(): Promise<void> {
  await check("the seeded grad trip is byte-identical to the captured run", async () => {
    const session = scriptedSession("check-seed");
    assert.equal(session.tripName, TRIP_NAME);
    assert.equal(session.scripted, true);
    const actual = flatten(await runOffline(session));
    assert.deepEqual(actual, [...SEEDED_TRANSCRIPT]);
  });

  await check("rerunning the seeded trip produces the same transcript again", async () => {
    const first = flatten(await runOffline(scriptedSession("check-seed-a")));
    const second = flatten(await runOffline(scriptedSession("check-seed-b")));
    assert.deepEqual(first, second);
  });

  // The flag, not the trip name, is what unlocks the script. A seeded session
  // whose briefs were edited keeps its name and must stop replaying.
  await check("an edited session stops replaying the script", async () => {
    const edited = scriptedSession("check-edited");
    edited.scripted = false;
    const actual = flatten(await runOffline(edited));
    assert.equal(edited.tripName, TRIP_NAME);
    assert.notDeepEqual(actual, [...SEEDED_TRANSCRIPT]);
  });

  await check("a judges' dinner argues about dinner and keeps every secret", async () => {
    await assertGeneratedRunIsSound("dinner", "Dinner tonight", "Tonight, 7pm", DINNER);
  });

  await check("a judges' night out is a different argument, not the same one", async () => {
    await assertGeneratedRunIsSound("night out", "A night out on Saturday", "Saturday, 9pm", NIGHT_OUT);

    const dinner = flatten(await runOffline(judgesSession("Dinner tonight", "Tonight, 7pm", DINNER)));
    const night = flatten(
      await runOffline(judgesSession("A night out on Saturday", "Saturday, 9pm", NIGHT_OUT)),
    );
    assert.notDeepEqual(dinner, night);
  });

  // The generator used to rotate three closing lines per role, which wraps
  // inside the shipped cap of five rounds: the last speakers repeated their own
  // first sentence word for word. Run the room far longer than it will ever run
  // on stage, so the next person who adds a beat finds out here rather than in
  // front of judges.
  await check("a long room never repeats a line, however many rounds it runs", async () => {
    for (const [label, topic, when, seats] of [
      ["dinner", "Dinner tonight", "Tonight, 7pm", DINNER],
      ["night out", "A night out on Saturday", "Saturday, 9pm", NIGHT_OUT],
    ] as const) {
      const events = await runOffline(judgesSession(topic, when, seats), 14);
      const texts = events
        .filter((event): event is Extract<NegotiationEvent, { type: "speak" }> => event.type === "speak")
        .map((turn) => turn.text);
      assert.ok(texts.length >= 40, `${label}: the long run did not actually run long`);
      const seen = new Set<string>();
      for (const text of texts) {
        assert.ok(!seen.has(text), `${label}: a line was repeated verbatim in a long run: ${text}`);
        seen.add(text);
      }
    }
  });

  // A ceiling nobody stated used to sort as `POSITIVE_INFINITY`, which made
  // the one seat that had said nothing "the person with the most room": it
  // opened with the expensive option and then had its headline want taken off
  // it as the price of the plan. The seat in front of the screen starts
  // exactly there, so this is the human who types one sentence with no number
  // in it.
  await check("an unknown ceiling does not make that seat the opener", () => {
    const scenario = buildScenario(hintsWithOneUnknownCeiling());

    assert.notEqual(
      scenario.roles.opener.participantId,
      "maya",
      "the seat that named no ceiling was cast as the one with the most room",
    );
    assert.equal(
      scenario.roles.opener.participantId,
      "sam",
      "the highest stated ceiling should be the one that opens expensive",
    );
    // And the other half of the same rule: an unknown ceiling reads as the
    // tight end of the scale, which is what `priceStanceFor(null, …)` says too.
    assert.equal(scenario.roles.holdout.participantId, "maya");
  });

  // Every blank in a brief used to reach the screen as itself: a private
  // report whose second sentence opened with a full stop, and a plan summary
  // with an empty date clause in the middle of it.
  await check("a room with an unbriefed seat still reads as sentences", async () => {
    const session = unbriefedSeatSession("check-unbriefed");
    const events = await runOffline(session);

    const agreed = events.find(
      (event): event is Extract<NegotiationEvent, { type: "agreed" }> => event.type === "agreed",
    );
    assert.ok(agreed, "the room never agreed");

    const done = events.find(
      (event): event is Extract<NegotiationEvent, { type: "done" }> => event.type === "done",
    );
    assert.ok(done, "the run never finished");

    const spoken = events
      .filter((event): event is Extract<NegotiationEvent, { type: "speak" }> => event.type === "speak")
      .map((event) => event.text);

    const reports = PARTICIPANT_IDS.flatMap((participantId) => {
      const report = done.reports[participantId];
      assert.ok(report, `${participantId} got no private report`);
      return [report.gotYou, report.tradedAway, report.why];
    });

    // The written-up plan, not the provisional one from `agreed`: the prose
    // fields are what the finalisation call writes, and the frame announcing
    // the agreement legitimately carries no runner-up and no sentence about
    // why it lost. The offer underneath is the same one either way.
    const plan = done.plan;
    assert.ok(plan, "the run finished without writing the plan up");

    // Every string the plan carries to the screen, which is what the plan
    // header and the ticks under it are assembled from.
    const written = [
      plan.runnerUpLostBecause,
      plan.offer.dates,
      plan.offer.destination,
      plan.offer.region,
      plan.offer.flightNote,
      plan.offer.lodgingNote,
      ...plan.offer.highlights,
      ...plan.keptWants,
      ...spoken,
      ...reports,
    ];

    for (const text of written) {
      const tripped = blankSlotIn(text);
      assert.equal(tripped, null, `an empty field reached the page (${tripped}): ${text}`);
      assert.ok(text.trim().length > 0, "a generated field came back empty");
    }
  });

  // The unit-level version of the same rule, on the fields the end-to-end run
  // cannot leave blank: a room where the opener said nothing and nobody gave
  // dates. `opener.wants[0] ?? opener.want` used to fall through one blank to
  // the next and print a private report whose second sentence opened with a
  // full stop; an empty `when` printed "Somewhere cheap, the coast, . $540 a
  // person" as the plan.
  await check("a plan and a report built from blank fields have no empty slots", () => {
    const hints = hintsWithBlankFields();
    const scenario = buildScenario(hints);

    const texts = [
      ...stringsIn(scenarioPlan(scenario)),
      ...PARTICIPANT_IDS.flatMap((participantId) =>
        stringsIn(scenarioReport(scenario, participantId)),
      ),
      // Four roles across all three of their beats, so a blank cannot hide in
      // the one step this room happens to open on.
      ...[0, 1, 2, 3].flatMap((spokenCount) =>
        PARTICIPANT_IDS.map(
          (participantId) =>
            scenarioTurn({ ...hints, spokenCount }, scenario, participantId).text,
        ),
      ),
    ];

    for (const text of texts) {
      const tripped = blankSlotIn(text);
      assert.equal(tripped, null, `an empty field reached the page (${tripped}): ${text}`);
      assert.ok(text.trim().length > 0, "a generated field came back empty");
    }
  });

  // The plan used to appear on screen only after the finalisation block had
  // run: one `final-plan` call and four `agent-report` calls, sequentially, on
  // the large model. The room visibly settled and then nothing happened for
  // tens of seconds. The agreement is now announced from what the round loop
  // already has, and the write-up replaces it when it lands.
  await check("the agreement is announced before any of it is written up", async () => {
    const provider = new CountingProvider();
    let atAgreed: number | null = null;
    let planCallsAtAgreed = 0;
    let reportCallsAtAgreed = 0;
    let agreed: Extract<NegotiationEvent, { type: "agreed" }> | null = null;
    let done: Extract<NegotiationEvent, { type: "done" }> | null = null;

    for await (const event of runNegotiation({
      session: scriptedSession("check-early-agree"),
      provider,
    })) {
      if (event.type === "agreed") {
        agreed = event;
        atAgreed = provider.calls;
        planCallsAtAgreed = provider.made("final-plan");
        reportCallsAtAgreed = provider.made("agent-report");
      }
      if (event.type === "done") done = event;
    }

    assert.ok(agreed, "the room never agreed");
    assert.ok(done, "the run never finished");
    assert.ok(atAgreed !== null, "no call count was taken at the agreement");

    // The frame is renderable on its own: `planViewFrom` returns null without
    // both halves, so a plan with no fairness report is a plan screen that
    // still shows nothing.
    assert.equal(
      agreed.fairness.rows.length,
      PARTICIPANT_IDS.length,
      "the agreement went out without a scored fairness meter",
    );

    assert.equal(planCallsAtAgreed, 0, "the plan was written up before the agreement was announced");
    assert.equal(reportCallsAtAgreed, 0, "a private report was written before the agreement was announced");
    assert.ok(
      atAgreed < done.usage.calls,
      `the agreement cost as many calls as the whole run (${atAgreed} of ${done.usage.calls})`,
    );

    // Five: the plan and one report per person. That is the wait the early
    // frame removes, and it is the number to quote if it ever grows.
    assert.equal(done.usage.calls - atAgreed, 5, "the finalisation block changed shape");

    // The room settled on one offer, and the write-up is prose about that
    // offer. A plan screen that is already showing it must not have it
    // swapped underneath.
    assert.ok(done.plan, "the terminal frame carried no written-up plan");
    assert.equal(
      done.plan.offer.id,
      agreed.plan.offer.id,
      "the write-up changed which offer the room agreed to",
    );
  });

  // Four independent large-model calls that used to be awaited one at a time.
  await check("the four private reports are written concurrently", async () => {
    const provider = new CountingProvider();
    let done: Extract<NegotiationEvent, { type: "done" }> | null = null;

    for await (const event of runNegotiation({
      session: scriptedSession("check-concurrent-reports"),
      provider,
    })) {
      if (event.type === "done") done = event;
    }

    assert.ok(done, "the run never finished");
    assert.equal(provider.made("agent-report"), PARTICIPANT_IDS.length);
    assert.equal(
      provider.peak,
      PARTICIPANT_IDS.length,
      `reports ran ${provider.peak} at a time, not ${PARTICIPANT_IDS.length}`,
    );

    // Concurrency must not cost a report, or a token.
    for (const participantId of PARTICIPANT_IDS) {
      assert.ok(done.reports[participantId], `${participantId} got no private report`);
    }
    assert.equal(done.usage.calls, provider.calls, "the usage tally lost a call");
  });

  // The offer check searches the web, and the room used to await it before it
  // would let the offer be spoken: every proposal froze the town for the
  // length of the search, four agents over five rounds. The offer now hits the
  // table immediately and the verdict follows on its own frame.
  await check("an offer reaches the table before its price check has answered", async () => {
    const provider = new GatedProvider("offer-check");
    const order: string[] = [];
    const checked: Extract<NegotiationEvent, { type: "offer-checked" }>[] = [];
    let firstOffer: { started: number; finished: number } | null = null;
    let done: Extract<NegotiationEvent, { type: "done" }> | null = null;

    for await (const event of runNegotiation({
      session: scriptedSession("check-nonblocking-offer-check"),
      provider,
    })) {
      if (event.type === "offer") {
        order.push(`offer:${event.offer.id}`);
        if (firstOffer === null) {
          firstOffer = { started: provider.started, finished: provider.finished };
        }
        assert.equal(
          event.offer.feasibility,
          undefined,
          `${event.offer.id} hit the table carrying a verdict it could not have had yet`,
        );
      }
      if (event.type === "offer-checked") {
        order.push(`checked:${event.offerId}`);
        checked.push(event);
      }
      if (event.type === "done") done = event;

      // Nothing is released until the first offer has been seen, which is
      // what makes that frame an observation of a check still in flight
      // rather than of one that answered during the `thinking` frame before
      // it. From there on every frame releases, so no held call can deadlock
      // the join at the end of the round.
      if (firstOffer !== null) provider.release();
    }

    assert.ok(firstOffer, "no offer was ever put on the table");
    assert.equal(firstOffer.started, 1, "the check had not been started when the offer went out");
    assert.equal(firstOffer.finished, 0, "the room waited for the check before speaking");

    // Every option gets its verdict, and never before the option itself.
    const offers = order.filter((entry) => entry.startsWith("offer:"));
    assert.ok(offers.length >= 2, "the seeded room should put two options up");
    assert.equal(checked.length, offers.length, "an offer went unchecked");
    for (const entry of offers) {
      const id = entry.slice("offer:".length);
      const proposed = order.indexOf(`offer:${id}`);
      const verdict = order.indexOf(`checked:${id}`);
      assert.ok(verdict > proposed, `${id} was checked before it was proposed`);
    }

    // And the engine still had every verdict in hand before it settled: the
    // convergence rule reads `feasibility.bookable`, so an offer that reached
    // the plan unchecked would mean the join at the end of the round was not
    // doing its job.
    assert.ok(done, "the run never finished");
    assert.ok(done.plan, "the terminal frame carried no plan");
    assert.ok(
      done.plan.offer.feasibility,
      "the room settled on an offer whose check never landed on it",
    );
  });

  // A whole table can say yes to something none of them can pay for. The
  // fallback that catches that used to take the most recent bookable offer
  // whatever it cost, which is how a $1,200 plan settled a room of "must be
  // cheap" seats — and the plan screen then printed "inside everyone's real
  // budget" above a meter saying three of them went over.
  await check("a table that assents over every ceiling settles on the cheapest", async () => {
    const session = judgesSession("The grad trip", "Mar 14–19", OVER_CEILING_SEATS);
    const events: NegotiationEvent[] = [];
    for await (const event of runNegotiation({
      session,
      provider: new ScriptedRoomProvider(OVER_CEILING_ROOM),
    })) {
      events.push(event);
    }

    // The premise, asserted rather than assumed: every seat is "must be cheap"
    // and neither option is inside that stance.
    const cheap = STANCE_CEILING["must be cheap"];
    for (const seat of OVER_CEILING_SEATS) {
      assert.ok(seat.budget <= cheap, `${seat.participantId} does not read as a cheap seat`);
    }
    const offered = events
      .filter((event): event is Extract<NegotiationEvent, { type: "offer" }> => event.type === "offer")
      .map((event) => event.offer);
    assert.equal(offered.length, 2, "the scripted room put a different number of options up");
    for (const offer of offered) {
      assert.ok(offer.perPerson > cheap, `${offer.id} is not over the stance ceiling`);
      assert.notEqual(offer.feasibility?.bookable, false, `${offer.id} was ruled out as unbookable`);
    }

    const agreed = events.find(
      (event): event is Extract<NegotiationEvent, { type: "agreed" }> => event.type === "agreed",
    );
    assert.ok(agreed, "the room never agreed");

    // Nothing on the table clears the ceiling, so the cheapest bookable option
    // is the one the room is held to — not the last one anybody mentioned.
    assert.equal(
      agreed.plan.offer.id,
      "offer-sandbar",
      `the assent fallback took ${agreed.plan.offer.id} at $${agreed.plan.offer.perPerson}pp`,
    );
    assert.equal(agreed.plan.offer.perPerson, 950);

    // And the screen must not be able to call that clean. `PlanHeadline` earns
    // its budget line from these two facts.
    assert.equal(
      agreed.fairness.nobodyOverruled,
      false,
      "a plan over every stated ceiling was scored as overruling nobody",
    );
    const overBudget = agreed.fairness.rows.filter((row) => row.gaveUp === GAVE_UP_BUDGET);
    assert.equal(
      overBudget.length,
      OVER_CEILING_SEATS.length,
      "the meter did not name the budget as what each of them gave up",
    );

    const done = events.find(
      (event): event is Extract<NegotiationEvent, { type: "done" }> => event.type === "done",
    );
    assert.ok(done, "the run never finished");
    assert.ok(done.plan, "the terminal frame carried no written-up plan");
    assert.equal(done.plan.offer.id, agreed.plan.offer.id, "the write-up changed the trip");
    assert.equal(done.fairness.nobodyOverruled, false);
  });

  await check("a generated run is deterministic", async () => {
    const first = flatten(await runOffline(judgesSession("Dinner tonight", "Tonight, 7pm", DINNER)));
    const second = flatten(await runOffline(judgesSession("Dinner tonight", "Tonight, 7pm", DINNER)));
    assert.deepEqual(first, second);
  });

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exitCode = 1;
    return;
  }
  console.log("\nAll checks passed.");
}

void main();
