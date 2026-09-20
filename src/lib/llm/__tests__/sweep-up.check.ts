/**
 * Runnable checks for the two places a good answer was being thrown away.
 *
 * Both failed the same way, which is the worst way: the expensive, correct work
 * had already happened, something downstream rejected it, and the resilient
 * provider answered from the script. No error reached a screen. An itinerary
 * built from five live searches came back as canned days, and a chat correctly
 * read into four people came back as "we could not read that".
 *
 * Neither is reachable from a unit check end to end — one needs the API, the
 * other needs a model that overruns — so what is held here is the pure part of
 * each: what may be replayed to the model, and what the extraction schema will
 * still accept.
 *
 * Run with `npm run check`.
 */

import assert from "node:assert/strict";
import { replayableContent } from "@/lib/llm/anthropic";
import { chatExtractionSchema } from "@/lib/ingest/schema";
import { seatsFrom } from "@/lib/ingest/seats";

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
/* What may be handed back to the model                                        */
/* -------------------------------------------------------------------------- */

/** The shape a searching answer comes back in, narrowed to what matters here. */
type Block = Parameters<typeof replayableContent>[0][number];

const text = (value: string) =>
  ({ type: "text", text: value, citations: null }) as unknown as Block;

const search = (id: string) =>
  ({ type: "server_tool_use", id, name: "web_search", input: {} }) as unknown as Block;

const searchResult = (id: string) =>
  ({ type: "web_search_tool_result", tool_use_id: id, content: [] }) as unknown as Block;

check("a search with no result cannot be replayed into the next call", () => {
  // The exact 400 this exists to prevent:
  //   `web_search` tool use with id ... was found without a corresponding
  //   `web_search_tool_result` block
  // It happens when the searching answer stopped early — on the token ceiling,
  // or mid-search — so the pair is broken through no fault of the caller.
  const truncated = [text("Found five places."), search("srvtoolu_1")];

  const replayed = replayableContent(truncated);
  assert.deepEqual(
    replayed.map((block) => block.type),
    ["text"],
    "only prose is replayed",
  );
  assert.equal(replayed[0]?.text, "Found five places.");
});

check("a complete search is replayed as prose too, not as bookkeeping", () => {
  // Even when the pair *is* complete there is nothing to gain by sending the
  // search records back: the turn is over, and the sweep-up only needs what
  // the model wrote.
  const complete = [
    search("srvtoolu_1"),
    searchResult("srvtoolu_1"),
    text("El Morro opens at 9."),
  ];
  const replayed = replayableContent(complete);
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0]?.text, "El Morro opens at 9.");
});

check("an answer with no prose at all has nothing to sweep up", () => {
  // The caller checks for this: a second call built on an empty assistant
  // message is a request that cannot succeed, and paying for it to fail is
  // worse than failing now.
  assert.deepEqual(replayableContent([search("srvtoolu_1")]), []);
  assert.deepEqual(replayableContent([]), []);
});

/* -------------------------------------------------------------------------- */
/* What the extraction will still accept                                       */
/* -------------------------------------------------------------------------- */

const LONG_NOTE =
  "Two of these handles look like the same person, and the chat never settles " +
  "on a destination — it goes back and forth between somewhere with snow and " +
  "somewhere warm for about forty messages without anybody deciding anything.";

function reading(notes: string[]) {
  return {
    readable: true,
    isTripPlanning: true,
    topic: "Ski week",
    destinationCandidates: [],
    dates: "Feb 2-7",
    notes,
    people: [
      {
        handle: "Priya",
        displayName: "Priya",
        messageCount: 4,
        isHost: true,
        want: "somewhere with actual snow this time, not another mud field",
        wants: ["real snow"],
        dealbreakers: [],
        dates: "Feb 2-7",
        bio: "Reads the room, then holds the line.",
        personality: { stubborn: 50, splurgy: 40, blunt: 50, adventurous: 50 },
        moneyTone: "unstated" as const,
        confidence: "clear" as const,
        evidence: "pls somewhere with actual snow this time",
        duplicateOf: null,
      },
    ],
  };
}

check("one sentence running long does not throw away the whole reading", () => {
  // What actually happened: a 161-character note against a 160-character cap,
  // and four people correctly identified were discarded — the host was told we
  // could not read their screenshot, which was not true.
  assert.ok(LONG_NOTE.length > 160, "the note is longer than the old limit");

  const parsed = chatExtractionSchema.safeParse(reading([LONG_NOTE]));
  assert.ok(parsed.success, `a long note was rejected: ${parsed.error?.message ?? ""}`);
});

check("the display limit still holds, downstream where it can truncate", () => {
  const parsed = chatExtractionSchema.parse(reading([LONG_NOTE]));
  const seated = seatsFrom(parsed);
  for (const note of seated.notes) {
    assert.ok(note.length <= 160, `a note reached the screen at ${note.length} characters`);
  }
  // And the reading survived rather than being thrown away.
  assert.equal(seated.seats.length, 1);
  assert.equal(seated.seats[0]?.name, "Priya");
});

check("the array bounds are still gates, because those protect the ceiling", () => {
  // Generous on prose, strict on counts: an unbounded array is how a call comes
  // back truncated and therefore as nothing at all.
  const tooMany = { ...reading([]), people: Array.from({ length: 9 }, () => reading([]).people[0]!) };
  assert.equal(chatExtractionSchema.safeParse(tooMany).success, false);
});

/* -------------------------------------------------------------------------- */

console.log(`sweep-up.check: ${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.error("sweep-up.check: FAIL");
  process.exit(1);
}
console.log("sweep-up.check: PASS");
