# PR #31 — fix: two ways a correct answer was being thrown away

## How they were found

Not by reading the code. The report was "the itinerary isn't doing the web
search to source actual places" plus a suspicion that a merge had gone wrong.
The merge was fine — `src/lib/itinerary/` and `src/app/api/itinerary/` were
byte-identical to `main` — and a direct build proved the search works:
`jetblue.com`, `airbnb.com`, `nps.gov`, El Morro, Castillo San Cristóbal, 21
items checked.

The answer was in `.next/dev/logs`, where `buildItinerary` reports every run:

```
[itinerary] built live in 41626ms
[itinerary] built live in 20621ms
[itinerary] built from the canned days in 45968ms: 44904ms model
[llm] itinerary fell back to offline: 400 `web_search` tool use with id
      srvtoolu_… was found without a corresponding `web_search_tool_result`
[llm] chat-photo fell back to offline: Tool output failed schema:
      too_big, maximum 160, path notes[1]
```

Two of three itineraries were real. The third was not, and the reason was
forty-five seconds of successful model work being discarded at the last step.

## The shared failure mode

Both bugs are the same shape, and it is the worst shape: the expensive work
succeeded, something downstream rejected it, and `ResilientProvider` answered
from the script. Nothing reached a screen as an error. The page said "BUILT
OFFLINE" in 7px type and the host had no reason to think anything had gone
wrong.

That is the cost of a fallback that cannot fail: it turns a bug into a quality
regression nobody reports.

## The itinerary killed its own web search

When a searching call answers in prose instead of calling `emit`, the sweep-up
replays the assistant message and forces the tool. It replayed that message
*verbatim* — `server_tool_use` blocks included. The API requires those to be
paired with their `web_search_tool_result`, and a response that stopped early,
on the token ceiling or mid-search, has a search with no result attached.

So the searching call succeeded, its findings existed, and the second call died
on bookkeeping for a turn that was already over.

`replayableContent` now keeps only the text blocks, which is all the sweep-up
ever needed: *here is what you found, now say it as data*. An answer with no
prose is no longer swept up at all — a second call built on an empty assistant
message cannot succeed, and paying for it to fail is worse than failing now.

## One long sentence threw away a whole reading

`chat-photo` was rejected over a 161-character note against a 160-character cap.
Four people correctly identified, discarded, and the host told we could not read
their screenshot — which was not true.

The string limits in `chatExtractionSchema` are two different things wearing one
hat. What they emit into the tool schema is `maxLength`, which is how the model
is told how long a field should be. What holds them is `tidy()` in `seats.ts`,
which truncates. Making the parse strict as well meant guidance behaved like a
gate.

The prose caps are generous now and the clamp stays downstream. The **array**
bounds are untouched: those are what protect the token ceiling, and an unbounded
array is how a call comes back truncated and therefore as nothing at all.

## Checks

`lib/llm/__tests__/sweep-up.check.ts`, the sixth suite. Neither bug is reachable
end to end from a unit check — one needs the API, the other needs a model that
overruns — so it holds the pure half of each: what may be replayed to the model,
and that a long note now parses while still reaching the screen truncated.
