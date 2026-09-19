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
 * Pure. No React, no I/O. The bio is deliberately ignored: it reaches the
 * agent through `describePersonality`, but it must not make the line jump
 * around while somebody is mid-sentence in the textarea.
 */

import { PERSONALITY_THRESHOLDS, type Personality } from "@/lib/types";

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
 */
const STANCE: Record<string, string> = {
  "high|high": "Cancun is out for us. I am not dressing that up and I am not moving off it.",
  "high|mid": "Cancun is out for us. Bring me a version that is not Cancun and I will listen.",
  "high|low": "Cancun is a stretch, straight up. I will still go where the group goes.",
  "mid|high": "Cancun does not work for us, and I am going to keep saying that until it changes.",
  "mid|mid": "Cancun is a stretch for us. Let me find the one with the same beach.",
  "mid|low": "Cancun is a stretch for us, but I am not going to hold the group up over it.",
  "low|high": "I hear you on Cancun. It still does not work for us, and I will keep asking until we find the one that does.",
  "low|mid": "Cancun is a stretch for us. Could we look at somewhere with the same beaches first?",
  "low|low": "Cancun is a little rich for us, but I am easy. Whatever the group lands on.",
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
 * One sample line for these sliders. Deterministic, so the server render and
 * the first client render agree, and so the same drag always reads the same
 * way twice in a row on stage.
 */
export function sampleLine(p: Personality): string {
  const stance = STANCE[`${band(p.blunt)}|${band(p.stubborn)}`] ?? STANCE["mid|mid"];
  return `${stance} ${MONEY[band(p.splurgy)]} ${ADVENTURE[band(p.adventurous)]}`;
}
