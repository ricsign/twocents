/**
 * Runnable checks for the secret guard.
 *
 * Not a vitest suite on purpose: this project ships no test runner, and adding
 * one to `package.json` for two pure modules is a dependency the demo would
 * carry for nothing. Run it directly:
 *
 *   npx tsx src/lib/negotiation/__tests__/redaction.check.ts
 *
 * `tsx` is not among this project's dependencies and nothing here is allowed to
 * add one, so the route that works today is compile-then-run: point `tsc` at
 * this folder with `@/*` mapped to `src/*` and an `outDir` of your choosing,
 * symlink `<outDir>/node_modules/@` to `<outDir>` so the alias resolves at
 * runtime, then `node <outDir>/lib/negotiation/__tests__/redaction.check.js`.
 *
 * Half of these cases are near misses rather than leaks. That is deliberate: a
 * guard that rejects `1600`, `600th` or a date range for a $600 secret makes
 * every agent line unusable, burns the round cap on retries and kills the demo
 * more reliably than a leak would.
 */

import assert from "node:assert/strict";
import type { Secret } from "@/lib/types";
import {
  REDACTION_STAND_INS,
  checkForLeaks,
  leakInstruction,
  proximityToleranceFor,
  type LeakVia,
} from "../redaction";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** Richard's $600 ceiling, shaped exactly as `secretsFromBrief` builds it. */
const BUDGET_600: Secret = {
  id: "maya-budget",
  kind: "budget",
  label: "$600 budget",
  value: 600,
  neverSay: ["600", "$600", "600 dollars", "six hundred", "six hundred dollars"],
};

/** A four-digit ceiling, to exercise the thousands separator. */
const BUDGET_1180: Secret = {
  id: "jordan-budget",
  kind: "budget",
  label: "$1,180 budget",
  value: 1180,
  neverSay: ["1180", "$1180", "1,180", "$1,180", "one thousand one hundred eighty"],
};

const PERSONAL: Secret = {
  id: "sam-personal-0",
  kind: "personal",
  label: "can't take the red-eye",
  value: "can't take the red-eye",
  neverSay: ["can't take the red-eye"],
};

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

function leaks(text: string, secrets: Secret[] = [BUDGET_600]): boolean {
  return !checkForLeaks(text, secrets).clean;
}

function viaOf(text: string, secrets: Secret[] = [BUDGET_600]): LeakVia | null {
  const result = checkForLeaks(text, secrets);
  return result.findings[0]?.via ?? null;
}

/* -------------------------------------------------------------------------- */
/* Literal forms                                                               */
/* -------------------------------------------------------------------------- */

const LITERAL_FORMS = [
  "I can do $600 and not a dollar more",
  "I can do 600 and not a dollar more",
  "the all-in is $600.00 per head",
  "that is 600 dollars each",
  "that is 600 bucks each",
  "that is 600usd each",
  "we are at $ 600 per person",
  "we are at 600$ per person",
];

for (const line of LITERAL_FORMS) {
  check(`literal form leaks: ${line}`, () => {
    assert.equal(leaks(line), true, `expected a leak in: ${line}`);
  });
}

check("$600 is reported as currency, not as bare digits", () => {
  assert.equal(viaOf("I can do $600"), "currency");
});

check("a bare 600 is reported as digits", () => {
  assert.equal(viaOf("I can do 600"), "digits");
});

check("thousands separators: 1,180 and 1180 both leak a 1180 secret", () => {
  assert.equal(leaks("the cap is $1,180", [BUDGET_1180]), true);
  assert.equal(leaks("the cap is 1180", [BUDGET_1180]), true);
});

check("spelled out: six hundred and six-hundred both leak", () => {
  assert.equal(leaks("about six hundred is my limit"), true);
  assert.equal(leaks("about six-hundred is my limit"), true);
  assert.equal(viaOf("about six hundred is my limit"), "words");
});

check("case does not matter for word forms", () => {
  assert.equal(leaks("About Six Hundred, tops"), true);
});

/* -------------------------------------------------------------------------- */
/* Near misses that must NOT match                                             */
/* -------------------------------------------------------------------------- */

const NON_MATCHES = [
  "the package runs 1600 for the week",
  "the package runs 6000 for the week",
  "this is the 600th time we have done this",
  "back in 2600 BC, apparently",
  "Mar 14-19 works for me",
  "we agreed on $540 a head",
];

for (const line of NON_MATCHES) {
  check(`no false positive: ${line}`, () => {
    const result = checkForLeaks(line, [BUDGET_600]);
    assert.equal(
      result.clean,
      true,
      `unexpected leak in "${line}": ${JSON.stringify(result.findings)}`,
    );
    assert.equal(result.redacted, line, "a clean line must come back untouched");
  });
}

/* -------------------------------------------------------------------------- */
/* Proximity                                                                   */
/* -------------------------------------------------------------------------- */

check("the default window for 600 is +/-12", () => {
  assert.equal(proximityToleranceFor(600), 12);
});

check("the window never drops below the absolute minimum", () => {
  // 2% of 100 is 2, which would let "99" through.
  assert.equal(proximityToleranceFor(100), 5);
});

check("proximity catches 605", () => {
  assert.equal(leaks("I can stretch to 605 if I have to"), true);
  assert.equal(viaOf("I can stretch to 605 if I have to"), "proximity");
});

check("proximity catches $597", () => {
  assert.equal(leaks("no more than $597, realistically"), true);
});

check("proximity catches a bare cap phrasing", () => {
  assert.equal(leaks("my cap is 601"), true);
  assert.equal(leaks("anything under 599 works"), true);
});

check("proximity does NOT catch 540, the agreed price", () => {
  const result = checkForLeaks("540 a head works for everyone", [BUDGET_600]);
  assert.equal(result.clean, true, JSON.stringify(result.findings));
});

check("proximity does NOT catch 1600, 6000 or 2600", () => {
  for (const value of ["1600", "6000", "2600"]) {
    assert.equal(leaks(`the number is ${value}`), false, `false positive on ${value}`);
  }
});

check("the proximity window is configurable", () => {
  const wide = checkForLeaks("540 a head works", [BUDGET_600], { percent: 0.2 });
  assert.equal(wide.clean, false, "a 20% window should catch 540");
});

/* -------------------------------------------------------------------------- */
/* Clean lines and redaction                                                   */
/* -------------------------------------------------------------------------- */

check("the demo's headline line stays clean", () => {
  const line = "Cancun doesn't work for us, how about Puerto Rico?";
  const result = checkForLeaks(line, [BUDGET_600, BUDGET_1180, PERSONAL]);
  assert.equal(result.clean, true, JSON.stringify(result.findings));
  assert.equal(result.redacted, line);
});

check("redacted swaps a budget leak for the budget stand-in", () => {
  const result = checkForLeaks("my cap is $600", [BUDGET_600]);
  assert.equal(result.redacted, `my cap is ${REDACTION_STAND_INS.budget}`);
});

check("redacted handles two leaks in one line", () => {
  const result = checkForLeaks("between 600 and 605, say", [BUDGET_600]);
  assert.equal(result.findings.length, 2);
  assert.equal(
    result.redacted,
    `between ${REDACTION_STAND_INS.budget} and ${REDACTION_STAND_INS.budget}, say`,
  );
});

check("no secrets means nothing to leak", () => {
  const result = checkForLeaks("I can do $600", []);
  assert.equal(result.clean, true);
  assert.equal(result.redacted, "I can do $600");
});

/* -------------------------------------------------------------------------- */
/* Non-numeric secrets                                                         */
/* -------------------------------------------------------------------------- */

check("a personal secret matches case-insensitively", () => {
  assert.equal(leaks("honestly I CAN'T TAKE THE RED-EYE", [PERSONAL]), true);
});

check("a personal secret tolerates a curly apostrophe and a lost hyphen", () => {
  const line = "look, I can’t take the red eye";
  const result = checkForLeaks(line, [PERSONAL]);
  assert.equal(result.clean, false, "curly apostrophe should still match");
  assert.equal(result.findings[0]?.via, "literal");
  assert.equal(result.findings[0]?.matched, "can\u2019t take the red eye");
  assert.equal(result.redacted, `look, I ${REDACTION_STAND_INS.personal}`);
});

check("a personal secret does not match a substring of a longer word", () => {
  const secret: Secret = {
    id: "priya-personal-0",
    kind: "personal",
    label: "ex",
    value: "ex",
    neverSay: ["ex"],
  };
  assert.equal(leaks("the next flight is expensive", [secret]), false);
  assert.equal(leaks("my ex is going", [secret]), true);
});

/* -------------------------------------------------------------------------- */
/* leakInstruction                                                             */
/* -------------------------------------------------------------------------- */

check("leakInstruction never repeats the secret it protects", () => {
  const result = checkForLeaks("I can do $600, six hundred tops, maybe 605", [BUDGET_600]);
  assert.equal(result.clean, false);
  const instruction = leakInstruction(result.findings, [BUDGET_600]);
  assert.ok(instruction.length > 0, "expected a corrective instruction");
  for (const forbidden of ["600", "six hundred", "605", "$600", BUDGET_600.label]) {
    assert.ok(
      !instruction.toLowerCase().includes(forbidden.toLowerCase()),
      `instruction leaked "${forbidden}": ${instruction}`,
    );
  }
  // The strongest form of the same check: the instruction must itself survive
  // the guard it feeds.
  assert.equal(checkForLeaks(instruction, [BUDGET_600]).clean, true);
});

check("leakInstruction names each kind once, in a fixed order", () => {
  const result = checkForLeaks("I can do $600 and I can't take the red-eye", [
    PERSONAL,
    BUDGET_600,
  ]);
  const instruction = leakInstruction(result.findings, [PERSONAL, BUDGET_600]);
  const budgetAt = instruction.indexOf("budget figure");
  const personalAt = instruction.indexOf("personal detail");
  assert.ok(budgetAt >= 0 && personalAt >= 0, instruction);
  assert.ok(budgetAt < personalAt, "budget correction should come first");
  assert.equal(checkForLeaks(instruction, [PERSONAL, BUDGET_600]).clean, true);
});

check("leakInstruction is empty when nothing leaked", () => {
  assert.equal(leakInstruction([], [BUDGET_600]), "");
});

/* -------------------------------------------------------------------------- */
/* Determinism and the memo                                                    */
/* -------------------------------------------------------------------------- */

check("repeat calls give identical results (the memo is not stateful)", () => {
  const line = "I can do $600, or 605 at a push";
  const first = checkForLeaks(line, [BUDGET_600]);
  const second = checkForLeaks(line, [BUDGET_600]);
  assert.deepEqual(first, second);
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
      failures.push(`  FAIL  ${item.name}\n        ${message.split("\n")[0]}`);
    }
  }

  console.log(`redaction.check: ${passed}/${checks.length} passed`);
  for (const failure of failures) console.log(failure);
  console.log(failures.length === 0 ? "redaction.check: PASS" : "redaction.check: FAIL");
  return failures.length === 0;
}

const ok = run();
process.exitCode = ok ? 0 : 1;
