/**
 * The instant sample line.
 *
 * The personality flip is the beat that proves the agents are not scripted: a
 * judge drags one slider and the sentence under the stage changes. A network
 * round trip would put 300ms of nothing between the drag and the proof, so the
 * screen answers locally first and lets `/api/voice` upgrade the line once the
 * hand stops moving.
 *
 * Keyed off `PERSONALITY_THRESHOLDS` — the same numbers `describePersonality`
 * uses to write the agent's instruction — so the preview a human reads and the
 * voice note the agent is given can never drift into disagreeing.
 *
 * The nine stances used to name Cancun in their own text, which was true of
 * exactly one room: the seeded grad trip, where the most expensive seat wants
 * the hotel zone. Anywhere else — a rewritten brief, a judges' round about
 * dinner — the screen was quoting an argument nobody in the room was having.
 * So the two nouns come in from outside as a `SampleTopic`, derived from the
 * session the person is actually sitting in, and the lines stay hand-written
 * around them.
 *
 * Pure. No React, no I/O. The bio is deliberately ignored: it reaches the
 * agent through `describePersonality`, but it must not make the line jump
 * around while somebody is mid-sentence in the textarea.
 */

import type { SessionView } from "@/lib/session-view";
import { PERSONALITY_THRESHOLDS, type Personality } from "@/lib/types";

/**
 * The two things a sample line has to name to sound like it belongs in this
 * room: what is on the table, and what this agent wants instead.
 */
export interface SampleTopic {
  /** The option this agent is pushing back on, as a short phrase. */
  contested: string;
  /** What its own human asked for, in their own words. */
  mine: string;
}

/** Used when a room has nothing on the table yet. Reads as a stance, not a gap. */
const NO_CONTESTED = "The expensive option";
/** Used when a brief names no destination. The screen guards against this. */
const NO_MINE = "Something that works for all four of us";

/**
 * How loose each stance is with money, lowest first.
 *
 * The agent proposing the expensive option is the one everybody else pushes
 * back on, and `priceStance` is the only read on that which is public — it is
 * the ceiling already collapsed into something sayable, which is precisely why
 * this preview may look at it and may not look at a number.
 */
const STANCE_ORDER: Record<string, number> = {
  "must be cheap": 0,
  "prefers value": 1,
  flexible: 2,
  "happy to splurge": 3,
};

/**
 * Trims a want down to the part that reads as a name.
 *
 * Briefs are written by people and derived by a model, so a destination want
 * arrives as "Cancun — the hotel zone, right on the strip" about as often as
 * it arrives as "Cancun". Dropping everything after the first dash or comma
 * keeps a sentence that has to be read out loud from running away.
 */
function headPhrase(want: string): string {
  const head = want.split(/[,;—–]|\s-\s/)[0] ?? want;
  return head.trim();
}

/**
 * What this room is arguing about, read off the view the browser is allowed to
 * have.
 *
 * Everything here is already public: `mandate` is the sanitized view every
 * other agent in the town is given, and `you.brief` is this person's own. No
 * ceiling is read, and none could be — `PublicMandate` does not carry one.
 */
export function sampleTopicFor(view: SessionView): SampleTopic {
  let loosest: { want: string; rank: number } | null = null;
  for (const other of view.others) {
    const want = headPhrase(other.mandate.destinationWant);
    if (!want) continue;
    const rank = STANCE_ORDER[other.mandate.priceStance] ?? 0;
    if (!loosest || rank > loosest.rank) loosest = { want, rank };
  }

  const mine =
    headPhrase(view.you.brief.destinationWant) ||
    headPhrase(view.you.brief.wants[0] ?? "");

  return {
    contested: loosest ? loosest.want : NO_CONTESTED,
    mine: mine || NO_MINE,
  };
}

type Band = "low" | "mid" | "high";

/** Which side of the slider this value reads as, in three steps. */
function band(value: number): Band {
  const t = PERSONALITY_THRESHOLDS;
  if (value >= t.lean) return "high";
  if (value <= t.leanLow) return "low";
  return "mid";
}

/**
 * How it opens, keyed `${blunt}|${stubborn}`. Nine lines rather than a
 * template, because a judge reads this sentence out loud and a stitched-together
 * one sounds like a form letter.
 *
 * `{it}` and `{mine}` are the room's two nouns. Both always open a clause, so
 * a want that arrives capitalised ("Somewhere warm with a beach") reads right
 * without the line having to guess whether it is a proper noun.
 */
const STANCE: Record<string, string> = {
  "high|high": "{it} is out for us. I am not dressing that up and I am not moving off it.",
  "high|mid": "{it} is out for us. {mine} is the version I will listen to.",
  "high|low": "{it} is a stretch, straight up. I will still go where the group goes.",
  "mid|high": "{it} does not work for us, and I am going to keep saying that until it changes.",
  "mid|mid": "{it} is a stretch for us. {mine} is what I came here for, so let me find the one that does both.",
  "mid|low": "{it} is a stretch for us, but I am not going to hold the group up over it.",
  "low|high": "I hear you on {it}. It still does not work for us. {mine} is what I keep coming back to.",
  "low|mid": "{it} is a stretch for us. {mine}. Could we look at that first?",
  "low|low": "{it} is a little rich for us, but I am easy. Whatever the group lands on.",
};

/** What it does with money, keyed off the frugal/splurgy slider. */
const MONEY: Record<Band, string> = {
  low: "Every dollar we keep there is a dollar we keep.",
  mid: "I will spend where it buys us something real.",
  high: "And if we are spending it, spend it on the good version.",
};

/** What it does with the unfamiliar option, keyed off cautious/adventurous. */
const ADVENTURE: Record<Band, string> = {
  low: "Somewhere we already know how to get to, please.",
  mid: "Somewhere easy to get to works for me.",
  high: "Bonus if it is a place none of us has done.",
};

/**
 * One sample line for these sliders, in this room. Deterministic, so the server
 * render and the first client render agree, and so the same drag always reads
 * the same way twice in a row on stage.
 */
export function sampleLine(p: Personality, topic: SampleTopic): string {
  const key = `${band(p.blunt)}|${band(p.stubborn)}`;
  const template = STANCE[key] ?? STANCE["mid|mid"] ?? "";
  const stance = template
    .replaceAll("{it}", topic.contested)
    .replaceAll("{mine}", topic.mine);
  return `${stance} ${MONEY[band(p.splurgy)]} ${ADVENTURE[band(p.adventurous)]}`;
}
