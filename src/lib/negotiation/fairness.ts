/**
 * The fairness meter.
 *
 * The plan screen makes a claim out loud — "nobody was overruled" — and a claim
 * a model asserts is a claim that can be wrong on stage. So the badge is
 * computed here, from the briefs the humans gave their agents and the plan the
 * agents came back with, and the model never gets a vote.
 *
 * Two properties this file is built around:
 *
 * - **Determinism.** The demo reruns the negotiation live (the personality flip
 *   beat), and a fairness bar that twitches between identical runs reads as
 *   noise. Every traversal here is over an array in a fixed order, every
 *   tie-break is explicit, and nothing consults a clock or a random source.
 * - **Honest matching.** A want is "kept" only when the plan actually says so.
 *   Naive substring matching is the trap: the want "no flights before 8am" and
 *   the flight note "6am flight" share the token `flight`, and a substring check
 *   would score a violation as a win. See `negationAwareVerdict` below.
 *
 * Pure: no I/O, no React, no Node APIs.
 */

import {
  PARTICIPANT_IDS,
  displayNameFor,
  type DisplayNames,
} from "@/lib/characters";
import type {
  Brief,
  FairnessReport,
  FairnessRow,
  NegotiationTurn,
  ParticipantId,
  Plan,
} from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Thresholds                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A person has to keep 60% of what they asked for before the meter will say
 * they were not overruled.
 *
 * Why 60% and not a majority, or everything: a negotiation where nobody concedes
 * is not a negotiation, so demanding 100% would make the badge unearnable and
 * therefore meaningless. 50% is too low — losing half of what you asked for is
 * exactly the feeling this product exists to prevent. 60% is the first
 * threshold above a coin flip: on the three-to-five wants a person actually
 * gives their agent it means at most one concession, which is what a fair trade
 * looks like. Below it you were outvoted, not traded with.
 */
export const NOBODY_OVERRULED_MIN_KEPT_RATIO = 0.6;

/**
 * Share of a want's significant tokens that must show up in the plan before the
 * want counts as kept. Two tokens both have to land (ceil(2 × 0.6) = 2), which
 * keeps "beach house" from being satisfied by the word "beach" alone; at three
 * or more, one may be missing, because people pad wants with words the plan has
 * no reason to echo ("a beach place with a real kitchen").
 */
export const WANT_MATCH_TOKEN_RATIO = 0.6;

/** Used for open interval edges, in the same units as the compared value. */
const EPSILON = 1e-6;
const NEGATIVE_INFINITY = Number.NEGATIVE_INFINITY;
const POSITIVE_INFINITY = Number.POSITIVE_INFINITY;

/* -------------------------------------------------------------------------- */
/* Normalisation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Words that carry no constraint. Negation and comparison words are absent on
 * purpose: they are consumed by the constraint parser before tokenisation, and
 * anything that reaches the token path has already had them stripped.
 */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "at", "is", "are",
  "be", "been", "am", "it", "its", "this", "that", "these", "those", "i", "we",
  "my", "our", "us", "me", "you", "your", "they", "them", "there", "here", "as",
  "by", "from", "with", "want", "wants", "wanted", "need", "needs", "needed",
  "like", "would", "should", "could", "can", "get", "got", "have", "has", "had",
  "some", "any", "all", "really", "just", "very", "too", "so", "but", "if",
  "please", "prefer", "prefers", "rather", "must", "let", "lets", "make",
  "makes", "something", "anything", "thing", "things", "one", "us",
]);

/**
 * Light stemming: drop the plural ending from a word long enough for it to be a
 * plural rather than a stem. A real stemmer would be more accurate and far
 * harder to predict, and predictability is what this file is for.
 */
function stem(token: string): string {
  if (token.length > 4 && token.endsWith("es")) {
    const base = token.slice(0, -2);
    // "beaches" -> "beach", but "leaves" -> "leave". Getting this wrong is not
    // cosmetic: `leaves` is how a flight note says `flights`, and a stem of
    // "leav" would never meet "leave" in the synonym table below.
    if (/(?:s|x|z|ch|sh)$/.test(base)) return base;
    return token.slice(0, -1);
  }
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

/** Lowercase, punctuation to spaces, stop words dropped, everything stemmed. */
function significantTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9$:]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token))
    .map(stem);
}

/* -------------------------------------------------------------------------- */
/* Subject synonyms                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Small, domain-specific equivalence classes.
 *
 * Needed because a want and the plan sentence that answers it rarely use the
 * same noun: the want says "no flights before 8am" and the flight note says
 * "nothing leaves before 11am". Without knowing that *leaves* is *flights*, the
 * two sentences look unrelated and a real constraint goes unchecked. Kept
 * deliberately short — this is a trip planner, not a thesaurus, and every entry
 * is a place two sentences can be wrongly joined.
 */
const SUBJECT_GROUPS: readonly (readonly string[])[] = [
  ["flight", "flights", "fly", "flying", "leave", "leaves", "leaving", "depart",
   "departs", "departure", "departures", "departing", "takeoff", "plane",
   "planes", "redeye", "board", "boarding"],
  ["hotel", "hostel", "airbnb", "lodging", "resort", "room", "rooms", "stay",
   "staying", "house", "villa", "place"],
  ["food", "dinner", "meal", "meals", "eat", "eating", "restaurant", "kitchen",
   "cook", "cooking"],
  ["cost", "price", "budget", "total", "spend", "spending", "money", "fare"],
  ["beach", "beaches", "ocean", "sea", "shore", "coast"],
];

/** stem -> group index, built once. */
const SUBJECT_GROUP_INDEX: Map<string, number> = (() => {
  const map = new Map<string, number>();
  SUBJECT_GROUPS.forEach((group, index) => {
    for (const word of group) map.set(stem(word), index);
  });
  return map;
})();

/** True when the two token sets name the same thing, directly or by synonym. */
function subjectsOverlap(a: readonly string[], b: readonly string[]): boolean {
  for (const left of a) {
    for (const right of b) {
      if (left === right) return true;
      const groupA = SUBJECT_GROUP_INDEX.get(left);
      const groupB = SUBJECT_GROUP_INDEX.get(right);
      if (groupA !== undefined && groupA === groupB) return true;
    }
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Constraint parsing                                                          */
/* -------------------------------------------------------------------------- */

type Relation = "before" | "after" | "atMost" | "atLeast";

/** A closed numeric range; open edges are expressed by nudging with EPSILON. */
interface Interval {
  lo: number;
  hi: number;
}

interface RelationHit {
  relation: Relation;
  /** The phrase, removed from the clause before looking for a negation word. */
  phrase: string;
}

interface CompiledRelation {
  relation: Relation;
  re: RegExp;
}

/**
 * Longest phrase first, and multi-word phrases before their own substrings.
 *
 * "no more than 600" is a single comparison, not a negation of "more than 600" —
 * reading the leading "no" as a negation would flip the constraint and score
 * every budget want backwards. Matching "no more than" as one unit first is what
 * prevents that.
 */
const RELATION_PHRASES: readonly RelationHit[] = [
  { phrase: "no more than", relation: "atMost" },
  { phrase: "not more than", relation: "atMost" },
  { phrase: "no less than", relation: "atLeast" },
  { phrase: "not less than", relation: "atLeast" },
  { phrase: "no earlier than", relation: "after" },
  { phrase: "no later than", relation: "before" },
  { phrase: "at most", relation: "atMost" },
  { phrase: "at least", relation: "atLeast" },
  { phrase: "less than", relation: "atMost" },
  { phrase: "more than", relation: "atLeast" },
  { phrase: "earlier than", relation: "before" },
  { phrase: "later than", relation: "after" },
  { phrase: "before", relation: "before" },
  { phrase: "after", relation: "after" },
  { phrase: "under", relation: "atMost" },
  { phrase: "below", relation: "atMost" },
  { phrase: "over", relation: "atLeast" },
  { phrase: "above", relation: "atLeast" },
  { phrase: "max", relation: "atMost" },
  { phrase: "maximum", relation: "atMost" },
  { phrase: "min", relation: "atLeast" },
  { phrase: "minimum", relation: "atLeast" },
];

/** Built once: `parseClause` runs over every sentence in the plan. */
const COMPILED_RELATIONS: readonly CompiledRelation[] = RELATION_PHRASES.map((hit) => ({
  relation: hit.relation,
  re: new RegExp(`\\b${hit.phrase.replace(/\s+/g, "\\s+")}\\b`, "i"),
}));

const NEGATION_WORDS = new Set([
  "no", "not", "never", "nothing", "none", "nobody", "without", "avoid", "skip",
  "zero", "cant", "dont", "wont", "isnt", "arent", "n/a",
]);

interface ParsedValue {
  value: number;
  /** Times and plain quantities must never be compared with each other. */
  isTime: boolean;
}

/** `8am`, `8:30pm`, `11 am` -> minutes since midnight. */
const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;
/** `$600`, `1,180`, `4` -> a plain quantity. */
const QUANTITY_RE = /\$?\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\b/;

function parseValue(text: string): ParsedValue | null {
  const time = TIME_RE.exec(text);
  if (time) {
    const rawHour = Number(time[1]);
    const minutes = time[2] ? Number(time[2]) : 0;
    const meridiem = (time[3] ?? "").toLowerCase();
    const hour = meridiem === "pm" ? (rawHour % 12) + 12 : rawHour % 12;
    return { value: hour * 60 + minutes, isTime: true };
  }
  const quantity = QUANTITY_RE.exec(text);
  if (quantity) {
    const digits = (quantity[1] ?? "").replace(/,/g, "");
    const cents = quantity[2] ? `.${quantity[2]}` : "";
    const value = Number(`${digits}${cents}`);
    if (Number.isFinite(value)) return { value, isTime: false };
  }
  return null;
}

/** The region a relation describes, e.g. "before 8am" -> everything under 8am. */
function regionFor(relation: Relation, value: number): Interval {
  switch (relation) {
    case "before":
      return { lo: NEGATIVE_INFINITY, hi: value - EPSILON };
    case "after":
      return { lo: value + EPSILON, hi: POSITIVE_INFINITY };
    case "atMost":
      return { lo: NEGATIVE_INFINITY, hi: value };
    case "atLeast":
      return { lo: value, hi: POSITIVE_INFINITY };
  }
}

/** Everything the region excludes. Used to turn a prohibition into a window. */
function complementOf(region: Interval): Interval {
  if (region.lo === NEGATIVE_INFINITY) return { lo: region.hi + EPSILON, hi: POSITIVE_INFINITY };
  return { lo: NEGATIVE_INFINITY, hi: region.lo - EPSILON };
}

function containsPoint(interval: Interval, value: number): boolean {
  return value >= interval.lo && value <= interval.hi;
}

function containsInterval(outer: Interval, inner: Interval): boolean {
  return inner.lo >= outer.lo && inner.hi <= outer.hi;
}

interface Clause {
  /** What the clause is about, as stems. */
  subjects: string[];
  negated: boolean;
  relation: Relation | null;
  parsed: ParsedValue | null;
}

/**
 * Splits one sentence into clauses and reads each one's polarity, comparison
 * and value. Splitting matters: "nothing leaves before 11am and the hotel is
 * walkable" holds one constraint and one unrelated fact, and merging them would
 * attach the negation to the hotel.
 */
function parseClauses(text: string): Clause[] {
  return text
    .split(/[,;.()]+|\s+(?:and|but|then|plus)\s+|\s+[—–-]\s+/i)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)
    .map(parseClause);
}

function parseClause(text: string): Clause {
  const lowered = text.toLowerCase();

  let relation: Relation | null = null;
  let remainder = lowered;
  for (const candidate of COMPILED_RELATIONS) {
    if (candidate.re.test(remainder)) {
      relation = candidate.relation;
      // Consume the phrase so the leading "no" inside "no more than" is not
      // double-counted as a negation.
      remainder = remainder.replace(candidate.re, " ");
      break;
    }
  }

  const rawTokens = remainder.replace(/[^a-z0-9$:\s]+/g, " ").split(/\s+/).filter(Boolean);
  const negated = rawTokens.some((token) => NEGATION_WORDS.has(token));

  const subjects = rawTokens
    .filter((token) => !NEGATION_WORDS.has(token))
    .filter((token) => !/\d/.test(token))
    .filter((token) => !STOP_WORDS.has(token))
    .map(stem);

  return { subjects, negated, relation, parsed: parseValue(lowered) };
}

interface WantConstraint {
  subjects: string[];
  /** The values the want will accept. */
  acceptable: Interval;
  isTime: boolean;
  /** True when the want is phrased as a prohibition ("no flights before 8am"). */
  prohibition: boolean;
}

/**
 * Reads a want as a numeric constraint, or returns null when it is just a wish
 * ("somewhere warm") and the token path should handle it.
 */
function parseWantConstraint(want: string): WantConstraint | null {
  const clause = parseClause(want);
  if (clause.relation === null || clause.parsed === null) return null;
  if (clause.subjects.length === 0) return null;

  const region = regionFor(clause.relation, clause.parsed.value);
  return {
    subjects: clause.subjects,
    acceptable: clause.negated ? complementOf(region) : region,
    isTime: clause.parsed.isTime,
    prohibition: clause.negated,
  };
}

type Verdict = "satisfied" | "violated" | "unknown";

/**
 * Compares a want's acceptable window against what the plan actually asserts.
 *
 * This is the explicit comparison the module is built around, and the reason it
 * exists is one pair of sentences: the want "no flights before 8am" is *kept* by
 * the flight note "nothing leaves before 11am" and *violated* by "6am flight".
 * Both notes mention flights and a time; a substring or token check cannot tell
 * them apart, because the difference is entirely in the polarity of the clause
 * and the direction of the comparison.
 *
 * So each plan clause is read as one of two things:
 *
 * - a **point assertion** ("6am flight") — the plan puts a value on the table,
 *   and the want is satisfied exactly when that value falls inside its window;
 * - a **region assertion** ("nothing leaves before 11am") — the plan promises a
 *   whole range, and the want is satisfied only when that entire range fits
 *   inside its window. A promise of "after 11am" fits inside "8am or later";
 *   the reverse would not.
 */
function negationAwareVerdict(constraint: WantConstraint, clauses: Clause[]): Verdict {
  let sawRelevant = false;

  for (const clause of clauses) {
    if (clause.parsed === null) continue;
    // Never compare a clock time with a dollar figure or a night count.
    if (clause.parsed.isTime !== constraint.isTime) continue;
    if (!subjectsOverlap(constraint.subjects, clause.subjects)) continue;

    sawRelevant = true;

    if (clause.relation !== null) {
      const region = regionFor(clause.relation, clause.parsed.value);
      const asserted = clause.negated ? complementOf(region) : region;
      if (!containsInterval(constraint.acceptable, asserted)) return "violated";
      continue;
    }

    // A bare value with a negation in front of it ("no 6am flight") asserts
    // nothing about what the plan *does* contain, so it cannot violate a window.
    if (clause.negated) continue;

    if (!containsPoint(constraint.acceptable, clause.parsed.value)) return "violated";
  }

  return sawRelevant ? "satisfied" : "unknown";
}

/* -------------------------------------------------------------------------- */
/* Want scoring                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Every sentence in the plan a want could be answered by.
 *
 * `destination` is included alongside the fields the fairness meter is specified
 * against because a want of "Puerto Rico" is plainly honoured by a plan whose
 * destination is Puerto Rico, and leaving it out would mark that as a loss.
 */
function planSentences(plan: Plan): string[] {
  return [
    ...plan.keptWants,
    ...plan.offer.highlights,
    plan.offer.flightNote,
    plan.offer.lodgingNote,
    plan.offer.region,
    plan.offer.destination,
  ].filter((sentence) => sentence.trim().length > 0);
}

interface PlanIndex {
  sentences: string[];
  clauses: Clause[];
  tokens: Set<string>;
}

function indexPlan(plan: Plan): PlanIndex {
  const sentences = planSentences(plan);
  const clauses: Clause[] = [];
  const tokens = new Set<string>();
  for (const sentence of sentences) {
    for (const clause of parseClauses(sentence)) clauses.push(clause);
    for (const token of significantTokens(sentence)) tokens.add(token);
  }
  return { sentences, clauses, tokens };
}

/** How many of a want's significant tokens have to land for it to count. */
function requiredTokenHits(total: number): number {
  return Math.max(1, Math.ceil(total * WANT_MATCH_TOKEN_RATIO));
}

interface ScoredWant {
  /** The want as the human wrote it, or a synthetic label for the budget. */
  text: string;
  kept: boolean;
  /** Budget ceilings are phrased differently when they show up in `gaveUp`. */
  isBudget: boolean;
  /** A numeric constraint reads differently too: you give up a limit, not a thing. */
  isLimit: boolean;
}

function scoreWant(want: string, index: PlanIndex): ScoredWant {
  const constraint = parseWantConstraint(want);

  if (constraint) {
    const verdict = negationAwareVerdict(constraint, index.clauses);
    if (verdict !== "unknown") {
      return {
        text: want,
        kept: verdict === "satisfied",
        isBudget: false,
        isLimit: true,
      };
    }
    // Nothing in the plan speaks to it. A prohibition that nothing contradicts
    // is kept — "no flights before 8am" is honoured by a plan that never
    // mentions a departure time at all. A positive constraint ("at least four
    // nights") still has to be found, so it falls through to the token path.
    if (constraint.prohibition) {
      return { text: want, kept: true, isBudget: false, isLimit: true };
    }
  }

  const tokens = significantTokens(want);
  if (tokens.length === 0) {
    // Nothing to check. Counting it as lost would punish someone for writing
    // "the usual".
    return { text: want, kept: true, isBudget: false, isLimit: false };
  }

  let hits = 0;
  for (const token of new Set(tokens)) {
    if (index.tokens.has(token)) hits += 1;
  }
  return {
    text: want,
    kept: hits >= requiredTokenHits(new Set(tokens).size),
    isBudget: false,
    isLimit: constraint !== null,
  };
}

/* -------------------------------------------------------------------------- */
/* gaveUp                                                                      */
/* -------------------------------------------------------------------------- */

/** Reverse of `stem` for display: a clause reads better in the singular. */
function singularize(token: string): string {
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

/**
 * Long words that are not the thing anybody wanted.
 *
 * `headToken` picks the longest word, which works because in "a beach resort
 * with a pool" the long word is the noun. It breaks on the placeholders, which
 * are long and mean nothing: a judges' round produced "gave up the somewhere"
 * from "somewhere worth dressing up for" and "gave up the nothing" from
 * "nothing too loud". They are excluded rather than special-cased downstream,
 * because the failure is that they were chosen, not how they were printed.
 */
const NOT_A_NOUN = new Set([
  // `stem` only strips plural endings, so these are the words as typed.
  "somewhere",
  "someplace",
  "anywhere",
  "everywhere",
  "nowhere",
  "nothing",
  "everything",
  "whatever",
  "wherever",
  "whenever",
  "somebody",
  "everybody",
  "anybody",
  "nobody",
  "people",
  "actually",
  "basically",
  "honestly",
  "probably",
  "proper",
  "properly",
  "decent",
  "reasonable",
  "reasonably",
]);

/**
 * The most concrete word in a short want.
 *
 * Heuristic: the longest significant token, earliest wins ties. In the phrases
 * people actually type — "a beach resort with a pool", "cheap direct flights" —
 * the longest word is reliably the noun the person cares about, and the shorter
 * ones are the modifiers. It is not grammar, but it is stable, cheap and right
 * often enough to print.
 */
function headToken(want: string): string | null {
  const tokens = significantTokens(want).filter(
    (token) => !/^\d/.test(token) && !NOT_A_NOUN.has(token),
  );
  let best: string | null = null;
  for (const token of tokens) {
    if (best === null || token.length > best.length) best = token;
  }
  return best;
}

/**
 * The want itself, short enough to sit under a bar.
 *
 * The fallback when no word in it is a noun worth naming. Printing the phrase
 * beats printing "ground on the plan": "gave up somewhere worth dressing up
 * for" is what the person actually lost, and they are the only one reading it.
 */
function shortWant(want: string): string | null {
  const words = want.trim().replace(/\s+/g, " ").split(" ").slice(0, 6);
  const phrase = words.join(" ").replace(/[.,;:]+$/, "");
  if (phrase.length === 0) return null;
  return `${phrase.charAt(0).toLowerCase()}${phrase.slice(1)}`;
}

/**
 * Never contains a figure: the bar is shown on the shared plan screen, so
 * "gave up staying under budget" is sayable and "gave up their $600 ceiling"
 * would undo the entire product in one label.
 */
/** "no flights before 8am", "nothing too loud": a want phrased as a refusal. */
const NEGATED = /^(?:no|not|nothing|never|without|avoid)\b/i;

/**
 * The one line under a fairness bar. Never contains a figure.
 *
 * A want people stated positively is printed as they stated it, trimmed to a
 * caption. Naming the single longest word in it was the old approach and it
 * produced "gave up the dressing" out of "somewhere worth dressing up for" and
 * "gave up the enough" out of "somewhere quiet enough to talk" — the heuristic
 * is sound for picking a noun to *match* on, which is what it was written for,
 * and wrong for picking one to print.
 *
 * A want phrased as a refusal cannot be printed that way: "gave up no flights
 * before 8am" says the opposite of what happened. Those keep the one-word form
 * and are named as the limit they were.
 */
function gaveUpClause(want: ScoredWant): string {
  if (want.isBudget) return "gave up staying under budget";

  if (want.isLimit || NEGATED.test(want.text.trim())) {
    const head = headToken(want.text);
    return head ? `gave up the ${singularize(head)} limit` : "gave up a hard no";
  }

  const phrase = shortWant(want.text);
  if (phrase) return `gave up ${phrase}`;
  const head = headToken(want.text);
  return head ? `gave up the ${singularize(head)}` : "gave up ground on the plan";
}

/**
 * How hard this person argued for a want, counted from their own public lines.
 *
 * A want they pushed for three times and still lost is a bigger concession than
 * one they mentioned in the briefing and never raised, so the transcript gets a
 * vote in which loss the meter names.
 */
function advocacyScore(want: ScoredWant, ownTurns: NegotiationTurn[]): number {
  const tokens = new Set(significantTokens(want.text));
  if (tokens.size === 0) return 0;
  let score = 0;
  for (const turn of ownTurns) {
    const spoken = new Set(significantTokens(turn.text));
    let overlap = 0;
    for (const token of tokens) if (spoken.has(token)) overlap += 1;
    if (overlap >= requiredTokenHits(tokens.size)) score += 1;
  }
  return score;
}

/* -------------------------------------------------------------------------- */
/* scoreFairness                                                               */
/* -------------------------------------------------------------------------- */

export function scoreFairness(
  briefs: Record<ParticipantId, Brief>,
  plan: Plan,
  turns: NegotiationTurn[],
): FairnessReport {
  const index = indexPlan(plan);
  const rows: FairnessRow[] = [];
  let anyCeilingBroken = false;

  // PARTICIPANT_IDS, not Object.keys: a fixed order makes the bars land in the
  // same places on every rerun.
  for (const participantId of PARTICIPANT_IDS) {
    const brief = briefs[participantId];
    if (!brief) continue;

    const scored: ScoredWant[] = brief.wants.map((want) => scoreWant(want, index));

    if (brief.budgetCeiling !== null) {
      // A ceiling is a want the person never had to type: it is the whole
      // reason they briefed an agent in private.
      const withinCeiling = plan.offer.perPerson <= brief.budgetCeiling;
      if (!withinCeiling) anyCeilingBroken = true;
      scored.push({
        text: "staying under budget",
        kept: withinCeiling,
        isBudget: true,
        isLimit: false,
      });
    }

    const wantsKept = scored.filter((want) => want.kept).length;
    const wantsTotal = scored.length;

    const lost = scored.filter((want) => !want.kept);
    let gaveUp: string | null = null;
    if (lost.length > 0) {
      const ownTurns = turns.filter((turn) => turn.speaker === participantId);
      // Ranking, in order: a broken ceiling outranks everything (money is the
      // concession people resent); then how hard they argued for it; then the
      // order they briefed it in, because people say the important thing first.
      const ranked = lost
        .map((want, position) => ({ want, position, advocacy: advocacyScore(want, ownTurns) }))
        .sort(
          (a, b) =>
            Number(b.want.isBudget) - Number(a.want.isBudget) ||
            b.advocacy - a.advocacy ||
            a.position - b.position,
        );
      const top = ranked[0];
      if (top) gaveUp = gaveUpClause(top.want);
    }

    rows.push({ participantId, wantsKept, wantsTotal, gaveUp });
  }

  const everyoneAboveThreshold = rows.every(
    (row) =>
      row.wantsTotal === 0 || row.wantsKept / row.wantsTotal >= NOBODY_OVERRULED_MIN_KEPT_RATIO,
  );

  return { rows, nobodyOverruled: everyoneAboveThreshold && !anyCeilingBroken };
}

/** Kept ratio, with an empty brief treated as fully satisfied. */
function keptRatio(row: FairnessRow): number {
  return row.wantsTotal === 0 ? 1 : row.wantsKept / row.wantsTotal;
}

/**
 * The headline over the fairness meter. Either the claim the product is selling,
 * or an honest naming of who paid for the plan — never a number, because the
 * plan screen is the one place all four humans look at the same time.
 */
export function fairnessSummaryLine(
  report: FairnessReport,
  names?: DisplayNames,
): string {
  if (report.nobodyOverruled || report.rows.length === 0) return "Nobody overruled";

  // Rows are already in PARTICIPANT_IDS order, so a tie resolves the same way
  // every run.
  let worst = report.rows[0] as FairnessRow;
  for (const row of report.rows) {
    if (keptRatio(row) < keptRatio(worst)) worst = row;
  }
  return `${displayNameFor(names, worst.participantId)} gave up the most`;
}
