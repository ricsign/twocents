/**
 * Runnable checks for the room: codes, seeding, and reading a chat into seats.
 *
 * Three properties this suite exists to hold, all of which fail silently:
 *
 * - **A code is a room, and case is not.** `fileFor` writes one JSON file per
 *   session id and macOS is case-insensitive by default, so `MJ4K7P` and
 *   `mj4k7p` are one file while `Map.get` treats them as two rooms. Memory
 *   would believe in two and disk in one, and a restart would hand back
 *   whichever was written last under both names.
 * - **No figure can come out of a photograph.** The extraction schema has no
 *   field that can hold one, and the path from a reading to a seated room must
 *   not invent one either. This is the product's whole privacy claim applied
 *   to its newest input.
 * - **A room full of drafts is not a room full of people.** A seat read off a
 *   chat has something to argue from, so it passes the flow guard — but nobody
 *   has spoken for it, so the lobby must not count it as briefed and offer to
 *   start.
 *
 * Run with `npm run check`, which compiles this to CommonJS and executes it.
 */

import assert from "node:assert/strict";
import { PARTICIPANT_IDS } from "@/lib/characters";
import { hasBriefed } from "@/lib/flow";
import { normalizeRoomCode, newRoomCode } from "@/lib/room/codes";
import { seatFromToken, seatToken, withIdentity } from "@/lib/room/links";
import { seedRoom, splurgyFor, transcriptFor } from "@/lib/room/seed";
import type { SeatBrief } from "@/lib/room/seat";
import { seatsFrom } from "@/lib/ingest/seats";
import { CHAT_PHOTO } from "@/lib/ingest/canned";
import type { ChatExtraction, ExtractedPerson } from "@/lib/ingest/schema";
import { DEFAULT_SESSION_ID, clearAllSessions } from "@/lib/session";
import { sessionViewFor } from "@/lib/session-view";
import type { ParticipantState } from "@/lib/types";

let passed = 0;
let failed = 0;

function check(name: string, run: () => void): void {
  try {
    run();
    passed += 1;
  } catch (error) {
    failed += 1;
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`FAIL  ${name}\n      ${detail}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Codes                                                                       */
/* -------------------------------------------------------------------------- */

check("a room code round-trips through its own normaliser", () => {
  const code = newRoomCode();
  assert.equal(code.length, 6);
  assert.equal(normalizeRoomCode(code), code);
  assert.match(code, /^[A-Z2-9]+$/, "codes avoid the confusable characters");
});

check("case is not a room", () => {
  assert.equal(normalizeRoomCode("mj4k7p"), "MJ4K7P");
  assert.equal(normalizeRoomCode("  Mj4K7p  "), "MJ4K7P");
});

check("the demo session is recognised rather than uppercased", () => {
  // `DEMO` would be a different map key and, on a case-insensitive filesystem,
  // the same file as the real default session.
  assert.equal(normalizeRoomCode("demo"), DEFAULT_SESSION_ID);
  assert.equal(normalizeRoomCode("DEMO"), DEFAULT_SESSION_ID);
  assert.equal(normalizeRoomCode("Demo"), DEFAULT_SESSION_ID);
});

check("anything that is not a code is rejected rather than looked up", () => {
  for (const junk of ["", "   ", "ABC", "TOOLONGX", "MJ4K7!", "../../etc", "OOOOOO", "MJ4K7I"]) {
    assert.equal(normalizeRoomCode(junk), null, `expected ${JSON.stringify(junk)} to be rejected`);
  }
  assert.equal(normalizeRoomCode(undefined), null);
  assert.equal(normalizeRoomCode(null), null);
});

check("the sanitiser that names the file cannot collapse two codes into one", () => {
  const sanitize = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  for (let i = 0; i < 50; i += 1) {
    const code = newRoomCode();
    assert.equal(sanitize(code), code, `${code} is not its own filename`);
  }
});

check("a seat is numbered in a URL, never named", () => {
  // `maya` and `jordan` are sprite keys. Showing one to somebody the screen
  // calls Player 2 names a person who is not in this room.
  assert.equal(seatToken("maya"), "p1");
  assert.equal(seatToken("jordan"), "p2");
  assert.equal(seatToken("sam"), "p3");
  assert.equal(seatToken("priya"), "p4");

  for (const id of PARTICIPANT_IDS) {
    assert.equal(seatFromToken(seatToken(id)), id, `${id} does not round-trip`);
  }

  // The documented `?viewer=sam` form is part of this app's HTTP surface, so
  // a curl written against it has to keep working.
  assert.equal(seatFromToken("sam"), "sam");
  assert.equal(seatFromToken("P2"), "jordan");

  for (const junk of ["", "p0", "p5", "p", "player2", "../maya", undefined, null]) {
    assert.equal(seatFromToken(junk), null, `expected ${JSON.stringify(junk)} rejected`);
  }
});

check("a link carries the identity whenever there is a room to be in", () => {
  // Nothing to name in a solo run, so those URLs stay clean.
  assert.equal(withIdentity("/brief"), "/brief");
  assert.equal(withIdentity("/brief", {}), "/brief");
  assert.equal(withIdentity("/brief", { seat: null, room: null }), "/brief");

  // In a room it is always there, because demoing is several links open in
  // one browser and a seat that lives only in the jar is invisible.
  assert.equal(withIdentity("/brief", { seat: "maya" }), "/brief?seat=p1");
  assert.equal(
    withIdentity("/lobby", { room: "MJ4K7P", seat: "jordan" }),
    "/lobby?room=MJ4K7P&seat=p2",
  );
  assert.equal(withIdentity("/x?v=1", { seat: "sam" }), "/x?v=1&seat=p3");
});

/* -------------------------------------------------------------------------- */
/* Seeding a room                                                              */
/* -------------------------------------------------------------------------- */

const PHOTO_SEATS: SeatBrief[] = [
  {
    participantId: "maya",
    name: "Ana",
    want: "somewhere with real snow",
    budget: null,
    moneyTone: "cheap",
    draft: { source: "photo", handle: "@ana", confidence: "unsure" },
  },
  {
    participantId: "jordan",
    name: "Bo",
    want: "a hot tub, and food worth the trip",
    budget: null,
    moneyTone: "splurgy",
    draft: { source: "photo", handle: "@bo", confidence: "clear" },
  },
  {
    participantId: "sam",
    name: "Cleo",
    want: "lessons for beginners",
    budget: null,
    moneyTone: "mixed",
    draft: { source: "photo", handle: "cleo", confidence: "unsure" },
  },
];

check("three people in a chat still seat a table of four", () => {
  clearAllSessions();
  const session = seedRoom({
    sessionId: "CHECK1",
    topic: "Ski week",
    when: "Feb 2-7",
    seats: PHOTO_SEATS,
  });
  assert.ok(session, "the room was seeded");

  for (const id of PARTICIPANT_IDS) {
    assert.ok(session.participants[id], `${id} has a seat`);
  }

  // The fourth keeps its cast name, which is how every screen tells it apart.
  assert.equal(session.participants.priya?.displayName, undefined);
  assert.equal(session.participants.priya?.draft, undefined);
  assert.equal(session.participants.maya?.displayName, "Ana");
  clearAllSessions();
});

check("a seeded room is nobody's yet: no host, no run, no claims", () => {
  clearAllSessions();
  const session = seedRoom({
    sessionId: "CHECK2",
    topic: "Ski week",
    when: "Feb 2-7",
    seats: PHOTO_SEATS,
  });
  assert.ok(session);
  assert.equal(session.hostSeat, null, "the first person to join becomes the host");
  assert.equal(session.runStartedAt, null);
  for (const id of PARTICIPANT_IDS) {
    assert.equal(session.participants[id]?.claimedAt, null, `${id} is unclaimed`);
    assert.equal(session.participants[id]?.approved, false);
  }
  clearAllSessions();
});

check("a room read off a chat is not the hand-written script", () => {
  clearAllSessions();
  // Left set, the offline provider replays the canned grad-trip transcript over
  // four briefs about a different trip entirely.
  const session = seedRoom({
    sessionId: "CHECK3",
    topic: "Ski week",
    when: "Feb 2-7",
    seats: PHOTO_SEATS,
  });
  assert.equal(session?.scripted, false);
  clearAllSessions();
});

check("no ceiling survives the trip from a photograph to a seat", () => {
  clearAllSessions();
  const session = seedRoom({
    sessionId: "CHECK4",
    topic: "Ski week",
    when: "Feb 2-7",
    seats: PHOTO_SEATS,
  });
  assert.ok(session);
  for (const id of PARTICIPANT_IDS) {
    const state: ParticipantState | undefined = session.participants[id];
    assert.equal(state?.brief.budgetCeiling, null, `${id} arrived with no number`);
    assert.equal(state?.brief.budgetIsPrivate, false);
  }
  // And nothing anywhere in the stored room reads as a price.
  const serialized = JSON.stringify(session);
  assert.ok(!/\$\s*\d/.test(serialized), "no figure was written into the room");
  clearAllSessions();
});

check("a photo-seeded transcript never puts words in somebody's mouth", () => {
  const seat = PHOTO_SEATS[0];
  const drafted = transcriptFor(seat, "Ski week", { spoken: false });
  assert.ok(drafted.length > 0);
  assert.ok(
    drafted.every((line) => line.role === "agent"),
    "nobody said anything to an agent in a screenshot",
  );
  // `/api/brief` re-derives the brief from this transcript on every turn, so a
  // fabricated human line would come back as testimony they never gave.
  assert.ok(
    drafted.some((line) => /most you can spend/i.test(line.text)),
    "it ends on the one question only they can answer",
  );

  const typed = transcriptFor({ ...seat, budget: 600, draft: undefined }, "Ski week", {
    spoken: true,
  });
  assert.ok(
    typed.some((line) => line.role === "human"),
    "a judge typed theirs, so recording it as spoken is faithful",
  );
});

check("four seats with no budgets do not land on the same money slider", () => {
  // The failure this guards: `splurgyByBudget` returned the midpoint for every
  // seat without a ceiling, and the photo path has no ceilings at all — so all
  // four agents argued from the same position on the axis the room argues
  // hardest along.
  const spread = splurgyFor(PHOTO_SEATS);
  const values = PHOTO_SEATS.map((seat) => spread.get(seat.participantId));
  assert.equal(new Set(values).size > 1, true, `all four collapsed onto ${values[0]}`);

  const cheap = spread.get("maya") as number;
  const splurgy = spread.get("jordan") as number;
  assert.ok(cheap < splurgy, `cheap (${cheap}) should sit below splurgy (${splurgy})`);
});

check("a chat where nobody discussed money still spreads the four", () => {
  // The common case, and the one a real reading produces: a model reads one
  // person as splurgy and shrugs at the other three. `unstated` is the enum's
  // way of saying "never mentioned", not a position on the slider — treating
  // it as one pinned three seats to the midpoint and outranked the personality
  // guess sitting right underneath it.
  const mostlyQuiet: SeatBrief[] = PARTICIPANT_IDS.map((participantId, index) => ({
    participantId,
    name: `P${index}`,
    want: "something",
    budget: null,
    moneyTone: index === 0 ? ("splurgy" as const) : ("unstated" as const),
    personality: { stubborn: 50, splurgy: 20 + index * 15, blunt: 50, adventurous: 50 },
  }));

  const spread = splurgyFor(mostlyQuiet);
  const quiet = mostlyQuiet.slice(1).map((seat) => spread.get(seat.participantId));
  assert.equal(
    new Set(quiet).size,
    quiet.length,
    `the three who said nothing collapsed onto ${quiet[0]}`,
  );
  // Their own guessed slider is what answered, rather than a shared default.
  assert.equal(spread.get("jordan"), 35);
});

check("budgets still outrank tone when somebody typed one", () => {
  const typed: SeatBrief[] = [
    { participantId: "maya", name: "A", want: "x", budget: 100, moneyTone: "splurgy" },
    { participantId: "jordan", name: "B", want: "y", budget: 900, moneyTone: "cheap" },
  ];
  const spread = splurgyFor(typed);
  assert.ok(
    (spread.get("maya") as number) < (spread.get("jordan") as number),
    "the number a judge typed beats a word a model chose",
  );
});

/* -------------------------------------------------------------------------- */
/* Reading a chat into seats                                                   */
/* -------------------------------------------------------------------------- */

function person(overrides: Partial<ExtractedPerson> & { handle: string }): ExtractedPerson {
  return {
    displayName: overrides.handle,
    messageCount: 1,
    isHost: false,
    want: "something",
    wants: [],
    dealbreakers: [],
    dates: "",
    bio: "",
    personality: { stubborn: 50, splurgy: 50, blunt: 50, adventurous: 50 },
    moneyTone: "unstated",
    confidence: "unsure",
    evidence: "",
    duplicateOf: null,
    ...overrides,
  };
}

function extraction(people: ExtractedPerson[]): ChatExtraction {
  return {
    readable: true,
    isTripPlanning: true,
    topic: "Ski week",
    destinationCandidates: [],
    dates: "Feb 2-7",
    people,
    notes: [],
  };
}

check("the four who talked most get the chairs, and the rest are handed back", () => {
  const seated = seatsFrom(
    extraction([
      person({ handle: "quiet", messageCount: 1 }),
      person({ handle: "loud", messageCount: 30 }),
      person({ handle: "b", messageCount: 9 }),
      person({ handle: "c", messageCount: 8 }),
      person({ handle: "d", messageCount: 7 }),
      person({ handle: "e", messageCount: 2 }),
    ]),
  );
  assert.equal(seated.seats.length, 4);
  assert.equal(seated.seats[0]?.name, "loud");
  // Never a silent drop: the host can swap any of these in.
  assert.deepEqual(
    seated.dropped.map((d) => d.handle),
    ["e", "quiet"],
  );
  assert.ok(seated.notes.some((note) => /found 6 people/i.test(note)));
});

check("one person under two handles is one person", () => {
  const seated = seatsFrom(
    extraction([
      person({ handle: "@jules", messageCount: 4, wants: ["a pool"] }),
      person({ handle: "Julia", messageCount: 5, wants: ["good coffee"], duplicateOf: "@jules" }),
      person({ handle: "other", messageCount: 6 }),
    ]),
  );
  assert.equal(seated.seats.length, 2, "two handles collapsed into one seat");
  // Merged before ranking, because their counts decide who gets a chair.
  const jules = seated.seats.find((seat) => seat.draft?.handle === "@jules");
  assert.ok(jules, "the surviving handle kept its seat");
  assert.deepEqual(jules?.wants?.sort(), ["a pool", "good coffee"]);
  assert.ok(seated.notes.some((note) => /same person/i.test(note)));
});

check("a chat with nobody in it seats nobody, rather than inventing four", () => {
  const seated = seatsFrom(extraction([]));
  assert.equal(seated.seats.length, 0);
  assert.equal(seated.dropped.length, 0);
});

check("the canned offline reading is a usable room", () => {
  // With no API key this is what a host sees, so it has to survive the same
  // path a live reading does.
  const seated = seatsFrom(CHAT_PHOTO);
  assert.equal(seated.seats.length, PARTICIPANT_IDS.length);
  assert.ok(seated.seats.every((seat) => seat.budget === null));
  assert.ok(
    seated.seats.every((seat) => seat.draft?.confidence === "unsure"),
    "nothing was read, so nothing is certain",
  );
  assert.equal(seated.dropped.length, 0);
});

/* -------------------------------------------------------------------------- */
/* What the lobby is allowed to conclude                                       */
/* -------------------------------------------------------------------------- */

check("a drafted seat has something to argue from but has not spoken", () => {
  clearAllSessions();
  const session = seedRoom({
    sessionId: "CHECK5",
    topic: "Ski week",
    when: "Feb 2-7",
    seats: PHOTO_SEATS,
  });
  assert.ok(session);

  const drafted = session.participants.maya;
  assert.ok(drafted);
  // The flow guard lets them through to the sliders and the town: there really
  // is a want to argue from.
  assert.equal(hasBriefed(drafted.brief), true);

  // The lobby asks a narrower question, and must answer no — otherwise a room
  // shows four ticks the moment it is made and offers to start before anybody
  // has said a word to their own agent.
  const view = sessionViewFor(session, "jordan");
  const maya = view.others.find((other) => other.participantId === "maya");
  assert.equal(maya?.briefed, false, "a guess we made is not them having spoken");
  assert.equal(maya?.claimed, false);

  // The open fourth seat is an NPC: nothing to wait for.
  const priya = view.others.find((other) => other.participantId === "priya");
  assert.equal(priya?.briefed, true);
  clearAllSessions();
});

check("clearing the draft is what makes a seat count as briefed", () => {
  clearAllSessions();
  const session = seedRoom({
    sessionId: "CHECK6",
    topic: "Ski week",
    when: "Feb 2-7",
    seats: PHOTO_SEATS,
  });
  assert.ok(session);

  // What `/api/brief` does on the first human turn.
  const spoken = {
    ...session,
    participants: {
      ...session.participants,
      maya: { ...session.participants.maya!, draft: undefined },
    },
  };
  const view = sessionViewFor(spoken, "jordan");
  assert.equal(view.others.find((o) => o.participantId === "maya")?.briefed, true);
  clearAllSessions();
});

check("the view tells a browser who may start and whether it has begun", () => {
  clearAllSessions();
  const session = seedRoom({
    sessionId: "CHECK7",
    topic: "Ski week",
    when: "Feb 2-7",
    seats: PHOTO_SEATS,
  });
  assert.ok(session);

  const solo = sessionViewFor(session, "maya");
  assert.equal(solo.hostSeat, null);
  assert.equal(solo.runStartedAt, null);
  assert.equal(solo.you.isHost, false, "a room with no host locks nobody out");

  const hosted = { ...session, hostSeat: "maya" as const };
  assert.equal(sessionViewFor(hosted, "maya").you.isHost, true);
  assert.equal(sessionViewFor(hosted, "jordan").you.isHost, false);
  clearAllSessions();
});

check("a room view still never carries anybody else's number", () => {
  clearAllSessions();
  const session = seedRoom({
    sessionId: "CHECK8",
    topic: "Ski week",
    when: "Feb 2-7",
    seats: [
      { ...PHOTO_SEATS[0]!, budget: 600, draft: undefined },
      { ...PHOTO_SEATS[1]!, budget: 1800, draft: undefined },
      PHOTO_SEATS[2]!,
    ],
  });
  assert.ok(session);

  const view = sessionViewFor(session, "sam");
  const serialized = JSON.stringify(view.others);
  assert.ok(!serialized.includes("600"), "Ana's ceiling did not cross the wire");
  assert.ok(!serialized.includes("1800"), "Bo's ceiling did not cross the wire");
  clearAllSessions();
});

/* -------------------------------------------------------------------------- */

console.log(`room.check: ${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.error("room.check: FAIL");
  process.exit(1);
}
console.log("room.check: PASS");
