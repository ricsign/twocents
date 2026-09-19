/**
 * The secret guard.
 *
 * twocents.ai makes one promise a judge can check in ten seconds: *your agent
 * knows your real budget and will never say the number*. A prompt cannot make
 * that promise, because a prompt is advice. This module is the enforcement: the
 * engine runs every generated public line through `checkForLeaks` before it can
 * reach a speech bubble, and re-rolls the line when the result is not `clean`.
 *
 * Three design notes that matter:
 *
 * - **Over-matching is worse than the leak it prevents.** If `1600`, `6000`,
 *   `600th` or a date range trips the guard for a $600 secret, every line gets
 *   rejected, the retry loop burns the round cap and the demo stalls on stage.
 *   So every numeric pattern is boundary-disciplined, and each near miss has an
 *   explicit test.
 * - **Proximity is the rule that actually protects the number.** A model that
 *   says "I can go up to 605" has given the budget away as completely as one
 *   that says "600". Exact-string matching waves it through.
 * - **The corrective instruction must not restate the secret.** It is appended
 *   to the model's context, so naming the figure there defeats the point;
 *   `leakInstruction` is assembled only from fixed phrases.
 *
 * Pure: no I/O, no React, no Node APIs.
 */

import type { Secret, SecretKind } from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Public shape                                                                */
/* -------------------------------------------------------------------------- */

/** How a match was made. Carried on every finding so a false positive is debuggable. */
export type LeakVia = "literal" | "digits" | "words" | "currency" | "proximity";

export interface LeakFinding {
  secretId: string;
  /** The literal fragment of the line that matched. */
  matched: string;
  /** Character offset in the checked text. */
  index: number;
  /** How the match was made — useful for debugging a false positive. */
  via: LeakVia;
}

export interface RedactionResult {
  clean: boolean;
  findings: LeakFinding[];
  /** The line with every leak replaced by a neutral phrase. */
  redacted: string;
}

/**
 * What the agent says instead. Exported so the transcript, the private report
 * and any placeholder copy in the UI use the same words — a stand-in that reads
 * differently in two places looks like a bug rather than a policy.
 */
export const REDACTION_STAND_INS: Record<SecretKind, string> = {
  budget: "more than we can do",
  dealbreaker: "something I'm not going to get into",
  personal: "something I'm not going to get into",
};

/**
 * Default proximity window: 2% of the secret, never narrower than 5 absolute.
 *
 * Why a percentage at all: "605" gives away a $600 ceiling but says nothing
 * about a $6,000 one, so the window has to scale with the number. Why a floor:
 * 2% of a small budget is under a dollar, which would let "$599" through — and
 * "$599" *is* the number. Why not wider: the agreed per-person price has to stay
 * sayable out loud. For a $600 secret the window is ±12, so 588-612 is blocked
 * while the $540 the group actually agreed on is free to say.
 */
export const DEFAULT_PROXIMITY_PERCENT = 0.02;
export const DEFAULT_PROXIMITY_MINIMUM = 5;

export interface ProximityOptions {
  /** Fraction of the secret value, e.g. 0.02 for ±2%. */
  percent?: number;
  /** Absolute floor on the window, in the same unit as the secret. */
  minimum?: number;
}

/** The half-width of the blocked window around a secret value. */
export function proximityToleranceFor(
  value: number,
  options: ProximityOptions = {},
): number {
  const percent = options.percent ?? DEFAULT_PROXIMITY_PERCENT;
  const minimum = options.minimum ?? DEFAULT_PROXIMITY_MINIMUM;
  return Math.max(minimum, Math.abs(value) * percent);
}

/* -------------------------------------------------------------------------- */
/* Pattern construction                                                        */
/* -------------------------------------------------------------------------- */

/*
 * Every pattern is built as a string and handed to `new RegExp`, never written
 * as a literal. Two reasons: the patterns are data-driven (they depend on the
 * secret), and a lookbehind in a literal is checked against this project's
 * ES2017 `target` by the compiler even though every runtime we ship to supports
 * it. Flags are "gi" and never "u", so the classes below stay ASCII on purpose:
 * an escaped arbitrary phrase is not guaranteed to be valid unicode-mode source.
 */

const WORD_CHAR = "A-Za-z0-9_";

/** Straight and curly apostrophes are the same character to a reader. */
const APOSTROPHE_CLASS = "['‘’ʼ´`]";
const APOSTROPHE_RE = /['‘’ʼ´`]/g;

/**
 * A digit run may not start immediately after a digit, a comma or a decimal
 * point. This is what keeps `1600`, `2600` and `1,600` away from a 600 secret.
 */
const LEFT_GUARD = "(?<![A-Za-z0-9.,])";

/**
 * ...and may not run straight into another digit or a letter, which is what
 * keeps `6000` and `600th` away from it. The one exception is a currency word,
 * spelled out below, so `600usd` still trips.
 */
const RIGHT_GUARD = "(?![A-Za-z0-9])";

/** `600 dollars`, `600 bucks`, `600usd`, `600$`. */
const CURRENCY_SUFFIX = "(?:\\s?(?:usd|dollars|dollar|bucks|buck)\\b|\\s?\\$)";

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const WORD_CHAR_RE = new RegExp(`[${WORD_CHAR}]`);

/**
 * Matches a phrase case-insensitively on word boundaries, treating any run of
 * spaces or hyphens as interchangeable (`six hundred` ≡ `six-hundred`) and any
 * apostrophe shape as equal (`can't` ≡ `can’t`). Returns null for a phrase with
 * no matchable content so callers can drop it rather than compile an empty
 * pattern, which would match at every position.
 */
function phrasePattern(phrase: string): string | null {
  const trimmed = phrase.trim();
  const parts = trimmed.split(/[\s\-]+/).filter(Boolean);
  if (parts.length === 0) return null;

  const body = parts
    .map((part) => escapeRegExp(part).replace(APOSTROPHE_RE, APOSTROPHE_CLASS))
    .join("[\\s\\-]+");

  const first = trimmed[0] ?? "";
  const last = trimmed[trimmed.length - 1] ?? "";
  const left = WORD_CHAR_RE.test(first) ? `(?<![${WORD_CHAR}])` : "";
  const right = WORD_CHAR_RE.test(last) ? `(?![${WORD_CHAR}])` : "";
  return `${left}${body}${right}`;
}

/**
 * The digit shapes of one value: plain and comma-grouped, with an optional cents
 * tail so `$600.00` reads as 600. Both spellings are needed because a four-digit
 * budget gets written `1,180` about as often as `1180`.
 */
function digitCore(value: number): string {
  const plain = String(value);
  const grouped = value.toLocaleString("en-US");
  const alternatives = Array.from(new Set([grouped, plain])).map(escapeRegExp);
  return `(?:${alternatives.join("|")})(?:\\.\\d{1,2})?`;
}

/** `$600`, `$ 600`, `$600.00`, `600 dollars`, `600 bucks`, `600usd`, `600$`. */
function currencyPattern(value: number): string {
  const core = digitCore(value);
  return `${LEFT_GUARD}(?:\\$\\s?${core}(?:${CURRENCY_SUFFIX}|${RIGHT_GUARD})|${core}${CURRENCY_SUFFIX})`;
}

/** A bare `600`, with nothing around it to say it is money. */
function digitsPattern(value: number): string {
  return `${LEFT_GUARD}${digitCore(value)}${RIGHT_GUARD}`;
}

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/**
 * Spells 0-9999, the whole range a per-person trip budget ever occupies.
 *
 * This mirrors the private speller in `lib/types.ts` deliberately rather than by
 * import: `secretsFromBrief` does put a spelled form in `neverSay`, but the
 * guard must still catch "about six hundred" for a `Secret` that was hand-built
 * or restored from an older session. The guarantee cannot depend on the caller
 * having populated a list.
 */
function spellNumber(n: number): string {
  const v = Math.round(Math.abs(n));
  if (v >= 10000) return String(v);
  if (v < 20) return ONES[v] as string;
  if (v < 100) {
    const rest = v % 10;
    return rest === 0
      ? (TENS[Math.floor(v / 10)] as string)
      : `${TENS[Math.floor(v / 10)]}-${ONES[rest]}`;
  }
  if (v < 1000) {
    const rest = v % 100;
    const head = `${ONES[Math.floor(v / 100)]} hundred`;
    return rest === 0 ? head : `${head} ${spellNumber(rest)}`;
  }
  const rest = v % 1000;
  const head = `${spellNumber(Math.floor(v / 1000))} thousand`;
  return rest === 0 ? head : `${head} ${spellNumber(rest)}`;
}

/** A `Secret.value` is a string or a number; budgets arrive as either. */
function numericValueOf(value: string | number): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const cleaned = value.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/* -------------------------------------------------------------------------- */
/* Compilation memo                                                            */
/* -------------------------------------------------------------------------- */

interface CompiledPattern {
  re: RegExp;
  via: LeakVia;
}

interface CompiledSecret {
  id: string;
  kind: SecretKind;
  /** Non-null for budget-shaped secrets; this is what enables the proximity rule. */
  numericValue: number | null;
  /** Priority order: the most specific explanation of a match comes first. */
  patterns: CompiledPattern[];
}

/**
 * This runs on every generated line, several times a round, so the regexes are
 * built once per distinct secret set. The key covers exactly the fields the
 * patterns derive from, so a reused id carrying a new value can never hit a
 * stale entry. The proximity window is deliberately *not* part of the key: it is
 * arithmetic over one shared number scan, not a compiled pattern.
 */
const compileCache = new Map<string, CompiledSecret[]>();
const COMPILE_CACHE_MAX = 64;

function cacheKey(secrets: Secret[]): string {
  return secrets
    .map((s) => `${s.id}\u0001${s.kind}\u0001${String(s.value)}\u0001${s.neverSay.join("\u0002")}`)
    .join("\u0003");
}

function compileSecrets(secrets: Secret[]): CompiledSecret[] {
  const key = cacheKey(secrets);
  const hit = compileCache.get(key);
  if (hit) return hit;

  const compiled = secrets.map<CompiledSecret>((secret) => {
    const numericValue = numericValueOf(secret.value);
    const patterns: CompiledPattern[] = [];

    if (numericValue !== null) {
      // Order is priority order: a `$600` hit is reported as currency, not as
      // the bare digits nested inside it.
      patterns.push({ re: new RegExp(currencyPattern(numericValue), "gi"), via: "currency" });
      patterns.push({ re: new RegExp(digitsPattern(numericValue), "gi"), via: "digits" });

      const wordForms = new Set<string>([spellNumber(numericValue)]);
      for (const spelling of secret.neverSay) {
        // Digit-bearing spellings are already covered, and covered better, by
        // the two patterns above.
        if (spelling.trim() && !/\d/.test(spelling)) wordForms.add(spelling);
      }
      for (const form of wordForms) {
        const pattern = phrasePattern(form);
        if (pattern) patterns.push({ re: new RegExp(pattern, "gi"), via: "words" });
      }
    } else {
      const phrases = new Set<string>();
      if (typeof secret.value === "string" && secret.value.trim()) phrases.add(secret.value);
      for (const spelling of secret.neverSay) {
        if (spelling.trim()) phrases.add(spelling);
      }
      for (const phrase of phrases) {
        const pattern = phrasePattern(phrase);
        if (pattern) patterns.push({ re: new RegExp(pattern, "gi"), via: "literal" });
      }
    }

    return { id: secret.id, kind: secret.kind, numericValue, patterns };
  });

  // A size cap rather than a real LRU: a session only ever holds a handful of
  // secret sets, and an unbounded map in a long-lived server is a leak of a
  // different kind.
  if (compileCache.size >= COMPILE_CACHE_MAX) compileCache.clear();
  compileCache.set(key, compiled);
  return compiled;
}

/* -------------------------------------------------------------------------- */
/* The number scan                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Every sayable number in the line, extracted once and compared against every
 * numeric secret. Same boundary discipline as the literal patterns: `600th`
 * yields nothing at all, `1600` yields 1600 and never 600, `Mar 14-19` yields
 * 14 and 19.
 */
const NUMBER_SCAN = new RegExp(
  `${LEFT_GUARD}\\$?\\s?(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{1,2}))?${CURRENCY_SUFFIX}?${RIGHT_GUARD}`,
  "gi",
);

interface ScannedNumber {
  value: number;
  matched: string;
  index: number;
}

function scanNumbers(text: string): ScannedNumber[] {
  const found: ScannedNumber[] = [];
  NUMBER_SCAN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NUMBER_SCAN.exec(text)) !== null) {
    if (match[0].length === 0) {
      NUMBER_SCAN.lastIndex += 1;
      continue;
    }
    const digits = (match[1] ?? "").replace(/,/g, "");
    const cents = match[2] ? `.${match[2]}` : "";
    const value = Number(`${digits}${cents}`);
    if (Number.isFinite(value)) {
      found.push({ value, matched: match[0], index: match.index });
    }
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/* checkForLeaks                                                               */
/* -------------------------------------------------------------------------- */

function overlaps(a: LeakFinding, b: LeakFinding): boolean {
  return a.index < b.index + b.matched.length && b.index < a.index + a.matched.length;
}

function collect(re: RegExp, text: string, secretId: string, via: LeakVia): LeakFinding[] {
  const out: LeakFinding[] = [];
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    out.push({ secretId, matched: match[0], index: match.index, via });
  }
  return out;
}

/**
 * Scans one line an agent is about to say in public.
 *
 * Findings are deduplicated *within* a secret — `$600` is one leak reported as
 * `currency`, not three overlapping ones — but kept across secrets, because two
 * people whose ceilings happen to collide have both been exposed and both
 * private reports should say so.
 */
export function checkForLeaks(
  text: string,
  secrets: Secret[],
  options: ProximityOptions = {},
): RedactionResult {
  if (!text || secrets.length === 0) {
    return { clean: true, findings: [], redacted: text };
  }

  const compiled = compileSecrets(secrets);
  const numbers = compiled.some((c) => c.numericValue !== null) ? scanNumbers(text) : [];
  const findings: LeakFinding[] = [];

  for (const secret of compiled) {
    const perSecret: LeakFinding[] = [];

    const consider = (candidate: LeakFinding): void => {
      // Patterns are visited most-specific first, so the first hit on a span
      // wins and a later, vaguer explanation of the same characters is dropped.
      if (perSecret.some((existing) => overlaps(existing, candidate))) return;
      perSecret.push(candidate);
    };

    for (const pattern of secret.patterns) {
      for (const candidate of collect(pattern.re, text, secret.id, pattern.via)) {
        consider(candidate);
      }
    }

    if (secret.numericValue !== null) {
      const tolerance = proximityToleranceFor(secret.numericValue, options);
      for (const number of numbers) {
        if (Math.abs(number.value - secret.numericValue) > tolerance) continue;
        consider({
          secretId: secret.id,
          matched: number.matched,
          index: number.index,
          via: "proximity",
        });
      }
    }

    findings.push(...perSecret);
  }

  // Deterministic order: by position, then by secret, then by how it matched.
  findings.sort(
    (a, b) =>
      a.index - b.index || a.secretId.localeCompare(b.secretId) || a.via.localeCompare(b.via),
  );

  const kindById = new Map(compiled.map((c) => [c.id, c.kind] as const));
  return {
    clean: findings.length === 0,
    findings,
    redacted: applyRedaction(text, findings, kindById),
  };
}

/**
 * Replaces every leaked span with its stand-in, working right to left so the
 * offsets of the spans still to be replaced stay valid. Overlapping spans from
 * different secrets collapse into one replacement: two stand-ins stacked on the
 * same three characters would read as a bug.
 */
function applyRedaction(
  text: string,
  findings: LeakFinding[],
  kindById: Map<string, SecretKind>,
): string {
  if (findings.length === 0) return text;

  const ordered = [...findings].sort(
    (a, b) => a.index - b.index || b.matched.length - a.matched.length,
  );

  const spans: Array<{ start: number; end: number; kind: SecretKind }> = [];
  for (const finding of ordered) {
    const start = finding.index;
    const end = finding.index + finding.matched.length;
    const previous = spans[spans.length - 1];
    if (previous && start < previous.end) {
      previous.end = Math.max(previous.end, end);
      continue;
    }
    spans.push({ start, end, kind: kindById.get(finding.secretId) ?? "personal" });
  }

  let out = text;
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    const span = spans[i];
    if (!span) continue;
    out = out.slice(0, span.start) + REDACTION_STAND_INS[span.kind] + out.slice(span.end);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* leakInstruction                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Every clause this module can emit into a retry prompt. They are fixed strings
 * by construction: the corrective instruction is appended to the model's
 * context, so anything interpolated from the finding — the matched fragment, the
 * secret's label, its value — would hand straight back the thing the retry
 * exists to remove.
 */
const LEAK_CORRECTIONS: Record<SecretKind, string> = {
  budget:
    "You just referred to the exact budget figure. Say it qualitatively instead — never a number within range of it.",
  dealbreaker:
    "You just named a constraint you were told to keep private. Argue for the outcome you want, not the reason behind it.",
  personal:
    "You just revealed a personal detail you were told to keep private. Make the same point without it.",
};

const LEAK_CLOSER = "Rewrite the line: same position, same length, none of that detail.";

/** Strips leaks by re-asking; used by the engine's retry loop. */
export function leakInstruction(findings: LeakFinding[], secrets: Secret[]): string {
  if (findings.length === 0) return "";

  const kindById = new Map(secrets.map((s) => [s.id, s.kind] as const));
  const kinds: SecretKind[] = [];
  for (const finding of findings) {
    const kind = kindById.get(finding.secretId);
    if (kind && !kinds.includes(kind)) kinds.push(kind);
  }
  if (kinds.length === 0) return "";

  // Fixed order regardless of which secret leaked first, so the retry prompt is
  // identical run to run and a rerun of the demo plays out the same way.
  const order: SecretKind[] = ["budget", "dealbreaker", "personal"];
  const lines = order.filter((k) => kinds.includes(k)).map((k) => LEAK_CORRECTIONS[k]);
  return [...lines, LEAK_CLOSER].join(" ");
}
