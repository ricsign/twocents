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
import { runNegotiation } from "@/lib/negotiation/engine";
import { checkForLeaks } from "@/lib/negotiation/redaction";
import { SEED_PERSONALITIES, TRIP_NAME, createSeedSession } from "@/lib/seed";
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
  "fair|maya:4/5:gave up the hotel jordan:4/5:gave up the nightlife sam:3/5:gave up the resort priya:5/5:-|true"
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
/* Run                                                                         */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  await check("the seeded grad trip is byte-identical to the captured run", async () => {
    const session = createSeedSession("check-seed");
    assert.equal(session.tripName, TRIP_NAME);
    const actual = flatten(await runOffline(session));
    assert.deepEqual(actual, [...SEEDED_TRANSCRIPT]);
  });

  await check("rerunning the seeded trip produces the same transcript again", async () => {
    const first = flatten(await runOffline(createSeedSession("check-seed-a")));
    const second = flatten(await runOffline(createSeedSession("check-seed-b")));
    assert.deepEqual(first, second);
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
