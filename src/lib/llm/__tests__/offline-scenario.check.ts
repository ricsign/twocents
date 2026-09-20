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
import { PARTICIPANT_IDS, type ParticipantId } from "@/lib/characters";
import { OfflineProvider } from "@/lib/llm/offline";
import {
  buildScenario,
  scenarioPlan,
  scenarioReport,
  scenarioTurn,
  type OfflineHints,
} from "@/lib/llm/scenario";
import { runNegotiation } from "@/lib/negotiation/engine";
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
  "plan|offer-puerto-rico|offer-tulum|2160|Beach every day / Catamaran day kept / Nothing leaves before 11am / No passports needed|Tulum came in at $690 and every flight left at 6am.",
  "fair|maya:4/5:gave up a hotel with a pool jordan:4/5:gave up nightlife within walking distance sam:3/5:gave up a resort on the beach priya:5/5:-|true"
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
      { participantId: "maya", name: "Will", want: "", wants: [], ceiling: null },
      { participantId: "jordan", name: "Angela", want: "a city with nightlife", wants: ["a city with nightlife"], ceiling: 900 },
      { participantId: "sam", name: "Richard", want: "a resort on the beach", wants: ["a resort on the beach"], ceiling: 1400 },
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
      { participantId: "maya", name: "Will", want: "", wants: [], ceiling: 1400 },
      { participantId: "jordan", name: "Angela", want: "a city with nightlife", wants: ["a city with nightlife"], ceiling: 900 },
      { participantId: "sam", name: "Richard", want: "", wants: [], ceiling: 800 },
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

    // Every string the plan carries to the screen, which is what the plan
    // header and the ticks under it are assembled from.
    const written = [
      agreed.plan.runnerUpLostBecause,
      agreed.plan.offer.dates,
      agreed.plan.offer.destination,
      agreed.plan.offer.region,
      agreed.plan.offer.flightNote,
      agreed.plan.offer.lodgingNote,
      ...agreed.plan.offer.highlights,
      ...agreed.plan.keptWants,
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
