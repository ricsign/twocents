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
    name: "Richard",
    color: "#E2593F",
    avatar: "/sprites/maya.png",
    sheet: "/sprites/maya-sheet.png",
  },
  jordan: {
    id: "jordan",
    name: "Angela",
    color: "#3B82C4",
    avatar: "/sprites/jordan.png",
    sheet: "/sprites/jordan-sheet.png",
  },
  sam: {
    id: "sam",
    name: "Will",
    color: "#5C9E4A",
    avatar: "/sprites/sam.png",
    sheet: "/sprites/sam-sheet.png",
  },
  priya: {
    id: "priya",
    name: "Tsai",
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

/**
 * A per-person override of the cast names, keyed by id.
 *
 * Partial on purpose: the seeded grad trip carries none of these, so every id
 * falls through to `Character.name` and the scripted run is untouched. The
 * judges' round carries four, and the whole room is renamed by handing one map
 * around rather than by editing the cast.
 */
export type DisplayNames = Readonly<Partial<Record<ParticipantId, string>>>;

/**
 * THE resolver: the one function in the app that decides what a person is
 * called.
 *
 * Every visible label - name tags, transcript rows, fairness bars, approval
 * rosters, the briefing header - and every generated line goes through here.
 * Sprites, colours and ids are untouched by it: a renamed Richard is still the
 * coral seat with the coral sprite, because only the name is overridable.
 *
 * Total: a missing or blank override is not an override, so there is no state
 * in which a person renders nameless.
 */
export function displayNameFor(
  names: DisplayNames | undefined,
  id: ParticipantId,
): string {
  const override = names?.[id]?.trim();
  return override ? override : CHARACTERS[id].name;
}

/** "Dana's agent" - used constantly in transcript and report copy. */
export function agentName(id: ParticipantId, names?: DisplayNames): string {
  return `${displayNameFor(names, id)}’s agent`;
}
