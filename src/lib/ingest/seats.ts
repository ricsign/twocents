/**
 * Choosing four people out of a group chat, and sitting them down.
 *
 * A chat has however many people in it; the table has four chairs. Something
 * has to decide, and doing it in the browser or in a prompt would both be
 * worse than doing it here, where the rule can be written down and the people
 * who did not get a seat can still be handed back for the host to swap in.
 *
 * Pure: no session, no network, no model. Everything below is arithmetic over
 * what was read.
 */

import { PARTICIPANT_IDS, type ParticipantId } from "@/lib/characters";
import type { SeatBrief } from "@/lib/room/seat";
import type { ChatExtraction, ExtractedPerson } from "./schema";

/** A person the chat turned up who did not get one of the four chairs. */
export interface DroppedPerson {
  handle: string;
  displayName: string;
  messageCount: number;
}

export interface SeatedChat {
  topic: string;
  when: string;
  seats: SeatBrief[];
  /** Everyone who did not fit, most talkative first, for the host to swap in. */
  dropped: DroppedPerson[];
  /** Anything worth saying out loud on the review screen. */
  notes: string[];
}

/** Trim and bound one string, since the schema deliberately does not. */
function tidy(value: string, max: number): string {
  return value.trim().slice(0, max);
}

/**
 * Folds two handles that are the same person into one.
 *
 * Done before ranking rather than after, because it changes the ranking: a
 * person posting half their messages under each handle would otherwise lose a
 * seat to somebody quieter than them. Their counts add up, their wants and
 * dealbreakers union, and the more confident read wins.
 *
 * Conservative in one direction on purpose — it merges only what the model
 * explicitly flagged with `duplicateOf`, never two names that merely look
 * alike. Merging two real people is far worse than leaving a duplicate for the
 * host to notice: one is a person who has been deleted from their own trip.
 */
function mergeDuplicates(people: readonly ExtractedPerson[]): {
  people: ExtractedPerson[];
  merged: string[];
} {
  const byHandle = new Map<string, ExtractedPerson>();
  for (const person of people) byHandle.set(person.handle, { ...person });

  const merged: string[] = [];
  for (const person of people) {
    const target = person.duplicateOf?.trim();
    if (!target || target === person.handle) continue;

    const into = byHandle.get(target);
    const from = byHandle.get(person.handle);
    if (!into || !from) continue;

    byHandle.set(target, {
      ...into,
      messageCount: into.messageCount + from.messageCount,
      wants: [...new Set([...into.wants, ...from.wants])].slice(0, 4),
      dealbreakers: [...new Set([...into.dealbreakers, ...from.dealbreakers])].slice(0, 3),
      displayName:
        into.displayName.length >= from.displayName.length
          ? into.displayName
          : from.displayName,
      confidence: into.confidence === "clear" || from.confidence === "clear" ? "clear" : "unsure",
      isHost: into.isHost || from.isHost,
    });
    byHandle.delete(person.handle);
    merged.push(`${from.handle} and ${into.handle} read as the same person.`);
  }

  return { people: [...byHandle.values()], merged };
}

/**
 * Who gets a chair.
 *
 * By message count, because "who is doing the planning" is the one thing a
 * screenshot can honestly answer — a chat cannot tell you who is actually
 * coming, but it can tell you who is in the conversation about it. Ties break
 * on the host, then on having said what they want, then on the order they
 * appeared, so the same chat always seats the same four.
 */
function rank(people: readonly ExtractedPerson[]): ExtractedPerson[] {
  return people
    .map((person, index) => ({ person, index }))
    .sort((a, b) => {
      if (b.person.messageCount !== a.person.messageCount) {
        return b.person.messageCount - a.person.messageCount;
      }
      if (a.person.isHost !== b.person.isHost) return a.person.isHost ? -1 : 1;
      const aSaid = a.person.want.trim().length > 0;
      const bSaid = b.person.want.trim().length > 0;
      if (aSaid !== bSaid) return aSaid ? -1 : 1;
      return a.index - b.index;
    })
    .map((entry) => entry.person);
}

/** One extracted person, as a seat the room seeder understands. */
function seatFrom(person: ExtractedPerson, participantId: ParticipantId): SeatBrief {
  const want = tidy(person.want, 240) || "whatever works for everybody";
  return {
    participantId,
    name: tidy(person.displayName, 40) || tidy(person.handle, 40) || "Someone",
    want,
    // Never from a photograph. The person supplies it to their own agent, on
    // the briefing screen, which is the only place it is ever theirs to give.
    budget: null,
    wants: person.wants.map((entry) => tidy(entry, 120)).filter(Boolean).slice(0, 4),
    dealbreakers: person.dealbreakers
      .map((entry) => tidy(entry, 120))
      .filter(Boolean)
      .slice(0, 3),
    ...(person.dates.trim() ? { dates: tidy(person.dates, 60) } : {}),
    ...(person.bio.trim() ? { bio: tidy(person.bio, 200) } : {}),
    personality: person.personality,
    moneyTone: person.moneyTone,
    draft: {
      source: "photo",
      handle: tidy(person.handle, 40),
      confidence: person.confidence,
    },
  };
}

/**
 * The whole reading, turned into at most four seats.
 *
 * Fewer than four is fine and is not padded here: `seedRoom` fills the rest
 * with open seats that keep their cast persona, which is what lets a chat with
 * three people in it still negotiate four-way — and leaves a chair for a
 * fourth friend to claim later.
 */
export function seatsFrom(extraction: ChatExtraction): SeatedChat {
  const { people, merged } = mergeDuplicates(extraction.people);
  const ordered = rank(people);
  const taken = ordered.slice(0, PARTICIPANT_IDS.length);
  const rest = ordered.slice(PARTICIPANT_IDS.length);

  const notes = [...extraction.notes.map((note) => tidy(note, 160)), ...merged].filter(Boolean);
  if (rest.length > 0) {
    notes.unshift(
      `We found ${ordered.length} people. These ${taken.length} talked the most.`,
    );
  }

  return {
    topic: tidy(extraction.topic, 60) || "The plan",
    when: tidy(extraction.dates, 60) || "To be decided",
    // Seated in ranked order, so the most active person lands in the first
    // cast slot. Seats carry sprites and colours, never identities, so which
    // chair somebody gets is a rendering detail rather than a decision.
    seats: taken.map((person, index) => seatFrom(person, PARTICIPANT_IDS[index])),
    dropped: rest.map((person) => ({
      handle: tidy(person.handle, 40),
      displayName: tidy(person.displayName, 40) || tidy(person.handle, 40),
      messageCount: person.messageCount,
    })),
    notes: notes.slice(0, 4),
  };
}
