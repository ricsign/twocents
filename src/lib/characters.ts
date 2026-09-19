/**
 * The four friends on the trip. Ids are stable and used as keys everywhere:
 * sprite lookup, negotiation state, fairness rows, approvals.
 */

export const PARTICIPANT_IDS = ["maya", "jordan", "sam", "priya"] as const;

export type ParticipantId = (typeof PARTICIPANT_IDS)[number];

export interface Character {
  id: ParticipantId;
  /** Display name, as it appears in the UI. */
  name: string;
  /** Per-person accent, used for fairness bars and name tags. */
  color: string;
  /** 16x16 portrait used in transcript rows, rosters and reports. */
  avatar: string;
  /** 16x48 sheet: three stacked 16x16 frames, animated for talk/walk. */
  sheet: string;
}

export const CHARACTERS: Record<ParticipantId, Character> = {
  maya: {
    id: "maya",
    name: "Maya",
    color: "#E2593F",
    avatar: "/sprites/maya.png",
    sheet: "/sprites/maya-sheet.png",
  },
  jordan: {
    id: "jordan",
    name: "Jordan",
    color: "#3B82C4",
    avatar: "/sprites/jordan.png",
    sheet: "/sprites/jordan-sheet.png",
  },
  sam: {
    id: "sam",
    name: "Sam",
    color: "#5C9E4A",
    avatar: "/sprites/sam.png",
    sheet: "/sprites/sam-sheet.png",
  },
  priya: {
    id: "priya",
    name: "Priya",
    color: "#8B5CC7",
    avatar: "/sprites/priya.png",
    sheet: "/sprites/priya-sheet.png",
  },
};

export const CHARACTER_LIST: Character[] = PARTICIPANT_IDS.map(
  (id) => CHARACTERS[id],
);

/** The person sitting in front of the screen during the demo. */
export const YOU: ParticipantId = "maya";

export function characterOf(id: ParticipantId): Character {
  return CHARACTERS[id];
}

/** "Maya's agent" — used constantly in transcript and report copy. */
export function agentName(id: ParticipantId): string {
  return `${CHARACTERS[id].name}’s agent`;
}
