/**
 * What the offline provider answers when it is handed a photograph.
 *
 * With no API key every model call in this app is answered by a script, and
 * the README calls that a supported mode rather than a degraded one. Reading a
 * screenshot is the one task where that promise is genuinely hard to keep:
 * there is no honest way to guess what is in a picture you cannot see.
 *
 * So it does not guess. It answers with the grad trip — the room the rest of
 * the demo is built around and timed against — and it marks every person
 * `confidence: "unsure"` with an empty `evidence` quote. That is not a hedge,
 * it is *literally true*: nothing was read, so nothing can be shown as
 * evidence and nothing is certain. The review screen's "we guessed this from
 * the chat, fix it" caption therefore says something accurate on the offline
 * path, and the host corrects four drafts exactly as they would with a key.
 *
 * Frozen, like `FINAL_PLAN` next door: no randomness and no clock, so an
 * offline rehearsal is the same room every time.
 *
 * The message counts are 14/11/9/7 on purpose — four distinct numbers, so the
 * ranking that picks the top four has no tie to break and the seat order is
 * deterministic too.
 */

import type { ChatExtraction } from "./schema";

export const CHAT_PHOTO: ChatExtraction = {
  readable: true,
  isTripPlanning: true,
  topic: "Grad Trip ’27",
  dates: "Mar 14–19",
  destinationCandidates: ["Cancun", "Puerto Rico", "Lisbon"],
  notes: [],
  people: [
    {
      handle: "Maya",
      displayName: "Maya",
      messageCount: 14,
      isHost: true,
      want: "somewhere warm with a beach we can actually walk to",
      wants: ["somewhere warm", "a beach we can walk to"],
      dealbreakers: [],
      dates: "Mar 14–19",
      bio: "Reads the room first, then holds the line on the one thing that matters.",
      personality: { stubborn: 52, splurgy: 30, blunt: 25, adventurous: 58 },
      moneyTone: "cheap",
      confidence: "unsure",
      evidence: "",
      duplicateOf: null,
    },
    {
      handle: "Jordan",
      displayName: "Jordan",
      messageCount: 11,
      isHost: false,
      want: "good food and a city we can get around without renting a car",
      wants: ["good food", "somewhere walkable"],
      dealbreakers: [],
      dates: "Mar 14–19",
      bio: "Will argue the logistics until they work, then stop arguing.",
      personality: { stubborn: 45, splurgy: 55, blunt: 60, adventurous: 50 },
      moneyTone: "mixed",
      confidence: "unsure",
      evidence: "",
      duplicateOf: null,
    },
    {
      handle: "Sam",
      displayName: "Sam",
      messageCount: 9,
      isHost: false,
      want: "a proper hotel, not a hostel, and a pool",
      wants: ["a proper hotel", "a pool"],
      dealbreakers: [],
      dates: "Mar 14–19",
      bio: "Would rather pay more than spend the week wishing they had.",
      personality: { stubborn: 60, splurgy: 82, blunt: 40, adventurous: 45 },
      moneyTone: "splurgy",
      confidence: "unsure",
      evidence: "",
      duplicateOf: null,
    },
    {
      handle: "Priya",
      displayName: "Priya",
      messageCount: 7,
      isHost: false,
      want: "nothing at 6am, and one day where we do nothing at all",
      wants: ["no early starts", "a day with nothing planned"],
      dealbreakers: ["nothing before 8am"],
      dates: "Mar 14–19",
      bio: "Easy about most of it, immovable about sleep.",
      personality: { stubborn: 35, splurgy: 45, blunt: 30, adventurous: 62 },
      moneyTone: "mixed",
      confidence: "unsure",
      evidence: "",
      duplicateOf: null,
    },
  ],
};
