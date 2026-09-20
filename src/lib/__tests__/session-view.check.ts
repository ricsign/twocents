/**
 * Runnable checks for the HTTP narrowing.
 *
 * Not a vitest suite on purpose: this project ships no test runner, and adding
 * one to `package.json` for a handful of pure modules is a dependency the demo
 * would carry for nothing. Run it directly:
 *
 *   npx tsx src/lib/__tests__/session-view.check.ts
 *
 * `tsx` is not among this project's dependencies and nothing here is allowed to
 * add one, so the route that works today is compile-then-run: point `tsc` at
 * this folder with `@/*` mapped to `src/*` and an `outDir` of your choosing,
 * symlink `<outDir>/node_modules/@` to `<outDir>` so the alias resolves at
 * runtime, then `node <outDir>/lib/__tests__/session-view.check.js`.
 *
 * Both narrowings in `session-view.ts` are checked here, in one file, for the
 * same reason they live in one file: `sessionViewFor` narrows the session body
 * and `eventForViewer` narrows a frame of the negotiation stream, and a leak
 * plugged in one and left open in the other is not plugged.
 *
 * The assertions are deliberately made against `JSON.stringify` of the view
 * rather than against its fields. A field-by-field check proves the fields you
 * remembered to check; the serialized form is what actually goes down the wire,
 * so searching *it* for Sam's 1400 catches a leak through a field nobody thought
 * about — a note copied into a mandate, a transcript riding along inside a
 * report, a `privateReasonKept` on someone else's turn.
 *
 * The fixture's numbers are chosen so no ceiling can appear by coincidence:
 * `startedAt` is fixed, and no price, count or timestamp in it contains "600",
 * "800", "900" or "1400" as a substring. That is what lets the checks below use
 * a plain substring search, which is the harshest form of the question.
 */

import assert from "node:assert/strict";
import { PARTICIPANT_IDS, type ParticipantId } from "@/lib/characters";
import { SAMPLE_BRIEF, createSeedSession } from "@/lib/seed";
import { eventForViewer, sessionViewFor, sessionViewSchema } from "@/lib/session-view";
import { negotiationEventSchema } from "@/lib/types";
import type {
  AgentReport,
  DemoSession,
  FairnessReport,
  NegotiationEvent,
  NegotiationTurn,
  Offer,
  Plan,
} from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Fixture                                                                     */
/* -------------------------------------------------------------------------- */

/** The seed's ceilings, restated so a check fails loudly if the seed moves. */
const CEILINGS: Record<ParticipantId, number> = {
  maya: 600,
  jordan: 900,
  sam: 1400,
  priya: 800,
};

/** A string planted in each person's private transcript, to hunt for later. */
function marker(id: ParticipantId): string {
  return `TRANSCRIPT-MARKER-${id.toUpperCase()}`;
}

const OFFER: Offer = {
  id: "offer-pr",
  destination: "Puerto Rico",
  region: "San Juan + Culebra",
  dates: "Mar 14–19",
  nights: 5,
  perPerson: 540,
  highlights: ["A beach every day", "The catamaran day", "No passport hassle"],
  flightNote: "Nothing leaves before 11am",
  lodgingNote: "Two apartments in Condado",
  proposedBy: "maya",
};

const PLAN: Plan = {
  offer: OFFER,
  runnerUp: null,
  runnerUpLostBecause: "",
  groupTotal: 2160,
  keptWants: ["A beach every day", "The catamaran day"],
  agreedInMs: 87_000,
};

const FAIRNESS: FairnessReport = {
  rows: PARTICIPANT_IDS.map((participantId) => ({
    participantId,
    wantsKept: 4,
    wantsTotal: 5,
    gaveUp: participantId === "sam" ? "The resort" : null,
  })),
  nobodyOverruled: true,
};

/**
 * One report per person, each naming its own ceiling in `secretsKept` exactly
 * the way the engine writes it. That is what makes check 1 mean something: the
 * other three reports, if they crossed, would carry the numbers with them.
 */
function reportFor(participantId: ParticipantId): AgentReport {
  return {
    participantId,
    gotYou: `${marker(participantId)} kept the beach days`,
    tradedAway: "An extra night",
    why: `Held the line under $${CEILINGS[participantId]} without saying it`,
    secretsKept: [`$${CEILINGS[participantId]} budget`],
  };
}

/** A public turn per person, each carrying that person's private reason. */
function turnFor(participantId: ParticipantId, index: number): NegotiationTurn {
  return {
    id: `turn-${participantId}`,
    round: 1,
    speaker: participantId,
    kind: index === 0 ? "proposes" : "counters",
    text: "Cancun doesn't work for us, how about Puerto Rico?",
    privateReasonKept: `protecting a $${CEILINGS[participantId]} ceiling`,
  };
}

/**
 * A finished session: four briefs with markers in their transcripts, four
 * reports, a plan and a fairness report. `startedAt` is pinned so the timestamp
 * cannot accidentally spell a ceiling.
 */
function finishedSession(): DemoSession {
  const session = createSeedSession("check-session");
  // The seat in front of the screen starts blank, so it has no ceiling to hunt
  // for until somebody briefs it. `SAMPLE_BRIEF` is the brief the demo applies
  // in one tap, and it carries the $600 these checks are written around.
  session.participants.maya.brief = { ...SAMPLE_BRIEF };
  const reports = {} as Record<ParticipantId, AgentReport>;

  for (const id of PARTICIPANT_IDS) {
    const state = session.participants[id];
    assert.ok(state, `seed is missing ${id}`);
    assert.equal(
      state.brief.budgetCeiling,
      CEILINGS[id],
      `seed ceiling for ${id} moved; update CEILINGS`,
    );
    state.brief.rawTranscript = [
      ...state.brief.rawTranscript,
      { role: "human", text: marker(id) },
    ];
    reports[id] = reportFor(id);
  }

  return {
    ...session,
    startedAt: 1_700_000_000_000,
    turns: PARTICIPANT_IDS.map(turnFor),
    plan: PLAN,
    fairness: FAIRNESS,
    reports,
    usage: { inputTokens: 0, outputTokens: 0, calls: 0, estimatedCostUsd: 0, model: [] },
  };
}

const SESSION = finishedSession();

function wire(viewer: ParticipantId): string {
  return JSON.stringify(sessionViewFor(SESSION, viewer));
}

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

/** Every participant but this one. */
function others(viewer: ParticipantId): ParticipantId[] {
  return PARTICIPANT_IDS.filter((id) => id !== viewer);
}

/* -------------------------------------------------------------------------- */
/* The narrowing, per viewer                                                   */
/* -------------------------------------------------------------------------- */

// Run the same battery for two different people, so the function cannot be
// quietly hard-coded to the demo user.
for (const viewer of ["maya", "sam"] as const) {
  check(`${viewer}: the view parses as a SessionView`, () => {
    const parsed = sessionViewSchema.safeParse(sessionViewFor(SESSION, viewer));
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  });

  check(`${viewer}: no other participant's ceiling appears anywhere`, () => {
    const json = wire(viewer);
    for (const id of others(viewer)) {
      assert.equal(
        json.includes(String(CEILINGS[id])),
        false,
        `${id}'s ceiling ${CEILINGS[id]} leaked into ${viewer}'s view`,
      );
    }
  });

  check(`${viewer}: their own ceiling IS present`, () => {
    const view = sessionViewFor(SESSION, viewer);
    assert.equal(
      view.you.brief.budgetCeiling,
      CEILINGS[viewer],
      "the viewer's own number must survive — scoped, not absent",
    );
    assert.equal(wire(viewer).includes(String(CEILINGS[viewer])), true);
  });

  check(`${viewer}: no rawTranscript but their own`, () => {
    const json = wire(viewer);
    assert.equal(json.includes(marker(viewer)), true, "your own transcript must survive");
    for (const id of others(viewer)) {
      assert.equal(
        json.includes(marker(id)),
        false,
        `${id}'s private transcript leaked into ${viewer}'s view`,
      );
    }
  });

  check(`${viewer}: exactly one AgentReport, theirs`, () => {
    const view = sessionViewFor(SESSION, viewer);
    assert.equal(view.report?.participantId, viewer);
    // `gotYou` exists on `AgentReport` and nowhere else in the model, so its
    // occurrence count is the number of reports on the wire.
    const count = wire(viewer).split('"gotYou"').length - 1;
    assert.equal(count, 1, `expected exactly one report, found ${count}`);
  });

  check(`${viewer}: nobody else's private notes or dealbreakers cross`, () => {
    const json = wire(viewer);
    for (const id of others(viewer)) {
      const state = SESSION.participants[id];
      assert.ok(state);
      for (const line of [...state.brief.notes, ...state.brief.dealbreakers]) {
        if (!line.toLowerCase().startsWith("private:")) continue;
        const text = line.slice("private:".length).trim();
        assert.equal(json.includes(text), false, `${id}'s private line leaked: ${text}`);
      }
    }
  });

  check(`${viewer}: others carry a price stance, never a price`, () => {
    const view = sessionViewFor(SESSION, viewer);
    assert.equal(view.others.length, PARTICIPANT_IDS.length - 1);
    for (const other of view.others) {
      const mandate = other.mandate as Record<string, unknown>;
      assert.equal("budgetCeiling" in mandate, false);
      assert.equal("rawTranscript" in mandate, false);
      assert.ok(typeof other.mandate.priceStance === "string");
    }
  });

  check(`${viewer}: only their own turns keep privateReasonKept`, () => {
    const view = sessionViewFor(SESSION, viewer);
    for (const turn of view.turns) {
      if (turn.speaker === viewer) {
        assert.ok(turn.privateReasonKept, "your own reason should survive");
      } else {
        assert.equal(
          turn.privateReasonKept,
          undefined,
          `${turn.speaker}'s private reason leaked into ${viewer}'s view`,
        );
      }
    }
  });

  check(`${viewer}: the shared state is all there`, () => {
    const view = sessionViewFor(SESSION, viewer);
    assert.equal(view.viewerId, viewer);
    assert.equal(view.sessionId, "check-session");
    assert.equal(view.tripName, SESSION.tripName);
    assert.equal(view.startedAt, SESSION.startedAt);
    assert.equal(view.plan?.offer.destination, "Puerto Rico");
    assert.equal(view.fairness?.rows.length, PARTICIPANT_IDS.length);
    assert.equal(view.turns.length, PARTICIPANT_IDS.length);
    assert.deepEqual(view.usage, SESSION.usage);
  });
}

/* -------------------------------------------------------------------------- */
/* The two views differ                                                        */
/* -------------------------------------------------------------------------- */

check("maya's view and sam's view are not the same object", () => {
  assert.notEqual(wire("maya"), wire("sam"));
});

check("sam's view contains maya's public wants but not her number", () => {
  const view = sessionViewFor(SESSION, "sam");
  const maya = view.others.find((o) => o.participantId === "maya");
  assert.ok(maya, "maya should appear as one of the others");
  assert.equal(maya.name, "Will");
  assert.ok(maya.mandate.wants.includes("A beach every day"));
  assert.equal(wire("sam").includes("600"), false);
});

check("an unfinished session narrows without throwing", () => {
  const fresh = createSeedSession("fresh");
  // Priya, not the demo user: hers is the seat the seed still fills.
  const view = sessionViewFor(fresh, "priya");
  assert.equal(view.plan, null);
  assert.equal(view.fairness, null);
  assert.equal(view.report, null);
  assert.equal(view.you.brief.budgetCeiling, CEILINGS.priya);
  assert.equal(sessionViewSchema.safeParse(view).success, true);
});

/* -------------------------------------------------------------------------- */
/* The stream narrowing, per viewer                                            */
/* -------------------------------------------------------------------------- */

/** The two frame types the narrowing actually touches, named for the checks. */
type DoneEvent = Extract<NegotiationEvent, { type: "done" }>;
type SpeakEvent = Extract<NegotiationEvent, { type: "speak" }>;

/**
 * The terminal frame, exactly as the engine yields it: all four private
 * reports, each naming its own ceiling in `secretsKept`. This is the frame the
 * leak was in — one `curl -N` on `/api/negotiate` used to end with it.
 *
 * `elapsedMs` is pinned to a number that spells no ceiling, for the same reason
 * `startedAt` is.
 */
function doneEvent(): DoneEvent {
  const reports = {} as Record<ParticipantId, AgentReport>;
  for (const id of PARTICIPANT_IDS) reports[id] = reportFor(id);
  return {
    type: "done",
    fairness: FAIRNESS,
    reports,
    usage: SESSION.usage,
    elapsedMs: 87_000,
  };
}

/** A spoken line, carrying the speaker's real reason the way the engine sends it. */
function speakEvent(speaker: ParticipantId): SpeakEvent {
  return {
    type: "speak",
    speaker,
    kind: "counters",
    text: "Cancun doesn't work for us, how about Puerto Rico?",
    privateReasonKept: `protecting a $${CEILINGS[speaker]} ceiling`,
  };
}

/**
 * The frames with nothing private in them.
 *
 * Listed out rather than sampled because "the narrowing left it alone" is a
 * claim about every one of them, and a frame that starts passing through a
 * reshaping step is exactly the regression this file exists to catch.
 */
const PUBLIC_EVENTS: NegotiationEvent[] = [
  { type: "round", round: 1, of: 5 },
  { type: "thinking", speaker: "jordan" },
  { type: "offer", speaker: "maya", offer: OFFER },
  { type: "agreed", plan: PLAN, runnerUp: null },
];

function wireEvent(event: NegotiationEvent, viewer: ParticipantId): string {
  return JSON.stringify(eventForViewer(event, viewer));
}

for (const viewer of ["maya", "sam"] as const) {
  check(`${viewer}: a done frame carries exactly one report, theirs`, () => {
    const narrowed = eventForViewer(doneEvent(), viewer);
    assert.equal(narrowed.type, "done");
    if (narrowed.type !== "done") return;

    assert.equal(narrowed.reports[viewer]?.participantId, viewer);
    for (const id of others(viewer)) {
      assert.equal(narrowed.reports[id], undefined, `${id}'s report rode the stream`);
    }
    // Same trick as the session check: `gotYou` exists on `AgentReport` and
    // nowhere else, so counting it counts reports on the wire.
    const count = wireEvent(doneEvent(), viewer).split('"gotYou"').length - 1;
    assert.equal(count, 1, `expected exactly one report on the frame, found ${count}`);
  });

  check(`${viewer}: a done frame names no other participant's ceiling`, () => {
    const json = wireEvent(doneEvent(), viewer);
    for (const id of others(viewer)) {
      assert.equal(
        json.includes(String(CEILINGS[id])),
        false,
        `${id}'s ceiling ${CEILINGS[id]} leaked into ${viewer}'s done frame`,
      );
    }
    assert.equal(
      json.includes(String(CEILINGS[viewer])),
      true,
      "the viewer's own report must survive — scoped, not absent",
    );
    assert.equal(json.includes(marker(viewer)), true, "their own report is theirs to read");
  });

  check(`${viewer}: a speak frame from somebody else drops privateReasonKept`, () => {
    for (const id of others(viewer)) {
      const narrowed = eventForViewer(speakEvent(id), viewer);
      assert.equal(narrowed.type, "speak");
      if (narrowed.type !== "speak") continue;
      assert.equal(
        narrowed.privateReasonKept,
        undefined,
        `${id}'s private reason leaked into ${viewer}'s stream`,
      );
      // The spoken line itself is public and must still arrive, or the town
      // narrows into silence.
      assert.equal(narrowed.text, speakEvent(id).text);
      const json = wireEvent(speakEvent(id), viewer);
      assert.equal(json.includes("privateReasonKept"), false);
      assert.equal(json.includes(String(CEILINGS[id])), false);
    }
  });

  check(`${viewer}: their own speak frame keeps privateReasonKept`, () => {
    const narrowed = eventForViewer(speakEvent(viewer), viewer);
    assert.equal(narrowed.type, "speak");
    if (narrowed.type !== "speak") return;
    assert.equal(narrowed.privateReasonKept, `protecting a $${CEILINGS[viewer]} ceiling`);
    assert.equal(wireEvent(speakEvent(viewer), viewer).includes(String(CEILINGS[viewer])), true);
  });

  check(`${viewer}: public frames pass through unchanged`, () => {
    for (const event of PUBLIC_EVENTS) {
      assert.deepEqual(
        eventForViewer(event, viewer),
        event,
        `a ${event.type} frame was reshaped by the narrowing`,
      );
    }
  });

  check(`${viewer}: every narrowed frame still parses as a NegotiationEvent`, () => {
    const frames = [doneEvent(), ...PARTICIPANT_IDS.map(speakEvent), ...PUBLIC_EVENTS];
    for (const event of frames) {
      // Round-tripped through JSON first, because that is what the town screen
      // validates: the narrowed frame has to survive the wire, not just the
      // type checker.
      const roundTripped = JSON.parse(wireEvent(event, viewer)) as unknown;
      const parsed = negotiationEventSchema.safeParse(roundTripped);
      assert.equal(
        parsed.success,
        true,
        `a narrowed ${event.type} frame no longer parses: ${JSON.stringify(parsed.error?.issues)}`,
      );
    }
  });
}

check("a done frame for maya and one for sam are not the same frame", () => {
  assert.notEqual(wireEvent(doneEvent(), "maya"), wireEvent(doneEvent(), "sam"));
});

check("a done frame for a viewer with no report carries an empty report map", () => {
  const partial: DoneEvent = {
    type: "done",
    fairness: FAIRNESS,
    reports: { maya: reportFor("maya") },
    usage: SESSION.usage,
    elapsedMs: 87_000,
  };
  const narrowed = eventForViewer(partial, "priya");
  assert.equal(narrowed.type, "done");
  if (narrowed.type !== "done") return;
  assert.deepEqual(narrowed.reports, {});
  assert.equal(negotiationEventSchema.safeParse(narrowed).success, true);
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

  console.log(`session-view.check: ${passed}/${checks.length} passed`);
  for (const failure of failures) console.log(failure);
  console.log(failures.length === 0 ? "session-view.check: PASS" : "session-view.check: FAIL");
  return failures.length === 0;
}

const ok = run();
process.exitCode = ok ? 0 : 1;
