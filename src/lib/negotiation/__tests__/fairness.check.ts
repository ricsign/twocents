/**
 * Runnable checks for the fairness meter.
 *
 *   npx tsx src/lib/negotiation/__tests__/fairness.check.ts
 *
 * `tsx` is not among this project's dependencies and nothing here is allowed to
 * add one, so the route that works today is compile-then-run: point `tsc` at
 * this folder with `@/*` mapped to `src/*` and an `outDir` of your choosing,
 * symlink `<outDir>/node_modules/@` to `<outDir>` so the alias resolves at
 * runtime, then `node <outDir>/lib/negotiation/__tests__/fairness.check.js`.
 *
 * The cases that matter most are the negation pair: "no flights before 8am" has
 * to read as *kept* against a flight note of "nothing leaves before 11am" and as
 * *violated* against "6am flight". Both notes mention flights and a time, so a
 * substring or bag-of-tokens check scores them identically — and scores one of
 * them backwards.
 */

import assert from "node:assert/strict";
import { PARTICIPANT_IDS } from "@/lib/characters";
import type {
  Brief,
  FairnessReport,
  FairnessRow,
  NegotiationTurn,
  Offer,
  ParticipantId,
  Plan,
} from "@/lib/types";
import {
  NOBODY_OVERRULED_MIN_KEPT_RATIO,
  fairnessSummaryLine,
  scoreFairness,
} from "../fairness";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function brief(
  participantId: ParticipantId,
  wants: string[],
  budgetCeiling: number | null,
): Brief {
  return {
    participantId,
    destinationWant: "somewhere warm",
    dates: "Mar 14-19",
    nights: 4,
    budgetCeiling,
    budgetIsPrivate: true,
    dealbreakers: [],
    wants,
    notes: [],
    rawTranscript: [],
  };
}

function offer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: "offer-pr",
    destination: "Puerto Rico",
    region: "San Juan + Culebra",
    dates: "Mar 14-19",
    nights: 4,
    perPerson: 540,
    highlights: ["beach days", "a real kitchen", "four nights"],
    flightNote: "nothing leaves before 11am, direct both ways",
    lodgingNote: "two-bed place with a kitchen",
    proposedBy: "maya",
    ...overrides,
  };
}

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    offer: offer(),
    runnerUp: null,
    runnerUpLostBecause: "",
    groupTotal: 2160,
    keptWants: ["beach days", "direct flights"],
    agreedInMs: 41_000,
    ...overrides,
  };
}

/** Maya asked for four things and privately capped herself at $600. */
const MAYA_WANTS = [
  "beach days",
  "direct flights",
  "a real kitchen",
  "no flights before 8am",
];

function briefs(
  overrides: Partial<Record<ParticipantId, Brief>> = {},
): Record<ParticipantId, Brief> {
  return {
    maya: brief("maya", MAYA_WANTS, 600),
    jordan: brief("jordan", ["four nights"], null),
    sam: brief("sam", ["beach days", "a real kitchen"], null),
    priya: brief("priya", ["four nights"], null),
    ...overrides,
  };
}

const TURNS: NegotiationTurn[] = [
  { id: "t1", round: 1, speaker: "maya", kind: "proposes", text: "Puerto Rico, four nights, beach days" },
  { id: "t2", round: 1, speaker: "maya", kind: "pushes back", text: "no flights before 8am, please" },
  { id: "t3", round: 2, speaker: "sam", kind: "counters", text: "I want a beach resort with a pool" },
  { id: "t4", round: 2, speaker: "priya", kind: "agrees", text: "four nights works" },
];

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

interface Check {
  name: string;
  fn: () => void;
}

const checks: Check[] = [];
function check(name: string, fn: () => void): void {
  checks.push({ name, fn });
}

/** Throws rather than asserts, so the return type narrows without help. */
function rowFor(report: FairnessReport, id: ParticipantId): FairnessRow {
  const row = report.rows.find((candidate) => candidate.participantId === id);
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

/** The `gaveUp` clause, with the "there was one" check folded in. */
function gaveUpOf(report: FairnessReport, id: ParticipantId): string {
  const { gaveUp } = rowFor(report, id);
  if (gaveUp === null) throw new Error(`expected ${id} to have given something up`);
  return gaveUp;
}

/* -------------------------------------------------------------------------- */
/* The happy plan                                                              */
/* -------------------------------------------------------------------------- */

check("a plan honouring everything gives Maya 5/5 and nobody is overruled", () => {
  const report = scoreFairness(briefs(), plan(), TURNS);
  const maya = rowFor(report, "maya");
  // Four stated wants plus the implicit budget ceiling.
  assert.equal(maya.wantsTotal, 5, JSON.stringify(maya));
  assert.equal(maya.wantsKept, 5, JSON.stringify(maya));
  assert.equal(maya.gaveUp, null);
  assert.equal(report.nobodyOverruled, true);
  assert.equal(fairnessSummaryLine(report), "Nobody overruled");
});

check("every participant gets exactly one row, in character order", () => {
  const report = scoreFairness(briefs(), plan(), TURNS);
  assert.deepEqual(
    report.rows.map((row) => row.participantId),
    [...PARTICIPANT_IDS],
  );
});

/* -------------------------------------------------------------------------- */
/* Budget ceilings                                                             */
/* -------------------------------------------------------------------------- */

check("a plan over one person's ceiling flips nobodyOverruled to false", () => {
  const report = scoreFairness(
    briefs({ sam: brief("sam", ["beach days", "a real kitchen"], 500) }),
    plan(), // $540 per person
    TURNS,
  );
  const sam = rowFor(report, "sam");
  assert.equal(sam.wantsTotal, 3);
  assert.equal(sam.wantsKept, 2);
  assert.equal(sam.gaveUp, "gave up staying under budget");
  assert.equal(report.nobodyOverruled, false);
  assert.equal(fairnessSummaryLine(report), "Richard gave up the most");
});

check("gaveUp never names the figure it is about", () => {
  const report = scoreFairness(
    briefs({ sam: brief("sam", ["beach days"], 500) }),
    plan(),
    TURNS,
  );
  const gaveUp = gaveUpOf(report, "sam");
  assert.ok(!/\d/.test(gaveUp), `gaveUp leaked a number: ${gaveUp}`);
});

check("a ceiling met exactly is kept", () => {
  const report = scoreFairness(
    briefs({ sam: brief("sam", ["beach days"], 540) }),
    plan(),
    TURNS,
  );
  assert.equal(rowFor(report, "sam").wantsKept, 2);
  assert.equal(report.nobodyOverruled, true);
});

/* -------------------------------------------------------------------------- */
/* Negation awareness                                                          */
/* -------------------------------------------------------------------------- */

check('"no flights before 8am" is KEPT by "nothing leaves before 11am"', () => {
  const report = scoreFairness(
    { ...briefs(), maya: brief("maya", ["no flights before 8am"], null) },
    plan({ offer: offer({ flightNote: "nothing leaves before 11am" }) }),
    TURNS,
  );
  const maya = rowFor(report, "maya");
  assert.equal(maya.wantsTotal, 1);
  assert.equal(maya.wantsKept, 1);
  assert.equal(maya.gaveUp, null);
});

check('"no flights before 8am" is VIOLATED by "6am flight"', () => {
  const report = scoreFairness(
    { ...briefs(), maya: brief("maya", ["no flights before 8am"], null) },
    plan({ offer: offer({ flightNote: "6am flight out of Boston" }) }),
    TURNS,
  );
  const maya = rowFor(report, "maya");
  assert.equal(maya.wantsTotal, 1);
  assert.equal(maya.wantsKept, 0, "a 6am departure violates an 8am floor");
  assert.equal(maya.gaveUp, "gave up the flight limit");
  assert.equal(report.nobodyOverruled, false);
});

check('"no flights before 8am" is kept when the plan never mentions a departure', () => {
  const report = scoreFairness(
    { ...briefs(), maya: brief("maya", ["no flights before 8am"], null) },
    plan({ offer: offer({ flightNote: "" }), keptWants: [] }),
    TURNS,
  );
  // A prohibition nothing contradicts has not been broken.
  assert.equal(rowFor(report, "maya").wantsKept, 1);
});

check('"no more than" reads as a comparison, not as a negation', () => {
  const kept = scoreFairness(
    { ...briefs(), maya: brief("maya", ["no more than 4 nights"], null) },
    plan({ offer: offer({ highlights: ["4 nights on the island"] }) }),
    TURNS,
  );
  assert.equal(rowFor(kept, "maya").wantsKept, 1, "4 nights satisfies a 4-night cap");

  const broken = scoreFairness(
    { ...briefs(), maya: brief("maya", ["no more than 4 nights"], null) },
    plan({ offer: offer({ highlights: ["7 nights on the island"] }) }),
    TURNS,
  );
  assert.equal(rowFor(broken, "maya").wantsKept, 0, "7 nights busts a 4-night cap");
  assert.equal(rowFor(broken, "maya").gaveUp, "gave up the night limit");
});

check("a clock time is never compared against a night count", () => {
  // "4 nights" must not be read as 4am and satisfy an 8am floor by accident.
  const report = scoreFairness(
    { ...briefs(), maya: brief("maya", ["no flights before 8am"], null) },
    plan({ offer: offer({ flightNote: "", highlights: ["4 nights"] }), keptWants: [] }),
    TURNS,
  );
  assert.equal(rowFor(report, "maya").wantsKept, 1);
});

/* -------------------------------------------------------------------------- */
/* gaveUp                                                                      */
/* -------------------------------------------------------------------------- */

check("gaveUp names the want that was lost, in the words it was asked for in", () => {
  const report = scoreFairness(
    { ...briefs(), sam: brief("sam", ["a beach resort with a pool"], null) },
    plan(),
    TURNS,
  );
  const sam = rowFor(report, "sam");
  assert.equal(sam.wantsKept, 0);
  assert.equal(sam.gaveUp, "gave up a beach resort with a pool");
});

check("gaveUp never prints a placeholder word as the thing somebody lost", () => {
  // Observed in a judges' round: "somewhere worth dressing up for" came out as
  // "gave up the somewhere", and a second pass at the same heuristic turned it
  // into "gave up the dressing". Picking the longest word is right for
  // matching a want against a plan and wrong for printing one.
  for (const want of [
    "somewhere worth dressing up for",
    "somewhere quiet enough to talk",
    "a place people actually like",
  ]) {
    const report = scoreFairness(
      { ...briefs(), sam: brief("sam", [want], null) },
      plan(),
      TURNS,
    );
    const gaveUp = rowFor(report, "sam").gaveUp ?? "";
    assert.equal(gaveUp, `gave up ${want}`, `for ${want}`);
    for (const placeholder of ["the somewhere", "the dressing", "the enough", "the people"]) {
      assert.ok(!gaveUp.includes(placeholder), `${gaveUp} still says "${placeholder}"`);
    }
  }
});

check("a want phrased as a refusal reads as the limit it was", () => {
  // "gave up no flights before 8am" says the opposite of what happened, so a
  // negated want keeps the one-word form and is named as a limit.
  const report = scoreFairness(
    { ...briefs(), sam: brief("sam", ["no flights before 8am"], null) },
    // The refusal has to actually be broken for anything to be given up: the
    // default offer leaves at 11am, which keeps it.
    plan({ offer: offer({ flightNote: "6am departure, one connection" }) }),
    TURNS,
  );
  const row = rowFor(report, "sam");
  assert.equal(row.wantsKept, 0, JSON.stringify(row));
  const gaveUp = row.gaveUp ?? "";
  assert.ok(gaveUp.endsWith(" limit"), gaveUp);
  assert.ok(!gaveUp.startsWith("gave up no "), gaveUp);
});

check("gaveUp prefers the want the person actually argued for", () => {
  const report = scoreFairness(
    {
      ...briefs(),
      sam: brief("sam", ["a quiet hostel downtown", "a beach resort with a pool"], null),
    },
    plan(),
    TURNS,
  );
  // Both are unmet, but only the resort shows up in Sam's own transcript lines,
  // so the resort is the one named — the hostel would render differently.
  assert.equal(rowFor(report, "sam").gaveUp, "gave up a beach resort with a pool");
});

check("the 60% threshold is what decides nobodyOverruled", () => {
  assert.equal(NOBODY_OVERRULED_MIN_KEPT_RATIO, 0.6);
  // 3 of 5 kept is 0.6 exactly, which passes; 2 of 5 is 0.4, which does not.
  const threeOfFive = scoreFairness(
    {
      ...briefs(),
      maya: brief(
        "maya",
        ["beach days", "a real kitchen", "four nights", "a rooftop bar", "a rental car"],
        null,
      ),
    },
    plan(),
    TURNS,
  );
  const maya = rowFor(threeOfFive, "maya");
  assert.equal(maya.wantsKept, 3, JSON.stringify(maya));
  assert.equal(threeOfFive.nobodyOverruled, true);

  const oneOfFive = scoreFairness(
    {
      ...briefs(),
      maya: brief(
        "maya",
        ["a rooftop bar", "a rental car", "a spa day", "a food tour", "beach days"],
        null,
      ),
    },
    plan(),
    TURNS,
  );
  assert.equal(rowFor(oneOfFive, "maya").wantsKept, 1);
  assert.equal(oneOfFive.nobodyOverruled, false);
  assert.equal(fairnessSummaryLine(oneOfFive), "Will gave up the most");
});

/* -------------------------------------------------------------------------- */
/* Determinism                                                                 */
/* -------------------------------------------------------------------------- */

check("the same inputs give the same report every time", () => {
  const first = scoreFairness(briefs(), plan(), TURNS);
  const second = scoreFairness(briefs(), plan(), TURNS);
  assert.deepEqual(first, second);
});

check("a person with no wants and no ceiling is not counted against the plan", () => {
  const report = scoreFairness(
    { ...briefs(), priya: brief("priya", [], null) },
    plan(),
    TURNS,
  );
  const priya = rowFor(report, "priya");
  assert.equal(priya.wantsTotal, 0);
  assert.equal(priya.gaveUp, null);
  assert.equal(report.nobodyOverruled, true);
});

/* -------------------------------------------------------------------------- */
/* Runner                                                                      */
/* -------------------------------------------------------------------------- */

export function run(): boolean {
  const failures: string[] = [];
  let passed = 0;

  for (const item of checks) {
    try {
      item.fn();
      passed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`  FAIL  ${item.name}\n        ${message.split("\n").slice(0, 3).join(" | ")}`);
    }
  }

  console.log(`fairness.check: ${passed}/${checks.length} passed`);
  for (const failure of failures) console.log(failure);
  console.log(failures.length === 0 ? "fairness.check: PASS" : "fairness.check: FAIL");
  return failures.length === 0;
}

const ok = run();
process.exitCode = ok ? 0 : 1;
