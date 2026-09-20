# PR #19 — fix: what you tell your agent is what your agent argues

## The bug

Nothing typed on `/brief` survived the screen.

`POST /api/brief` did the expensive half of the work — a reply, then a second
call to re-derive the structured `Brief` from the whole conversation — and then
returned both and dropped the brief on the floor, under a `TODO(session)` left
over from when two agents were building the route and the store in parallel.
`brief/page.tsx` never read the store either: it rendered four hardcoded
constants out of `src/components/brief/seed.ts`. So the "YOUR AGENT KNOWS"
panel opened already naming a destination, a date range, a $600 ceiling and
four wants that the person in the seat had never said, the town negotiated
from the seed whatever they typed, and a reload lost the conversation.

A second bug sat behind it. With no API key the model layer falls back to
`OfflineProvider`, which either replays a hand-written Cancun transcript or
generates from the real briefs. `isSeedScenario` chose between them by
comparing `session.tripName` to `TRIP_NAME` — and the main flow never changes
the trip name. Fixing the first bug on its own would therefore have produced
the worse failure: a human briefs their agent, and four agents read the canned
script over the top of it.

## The change

The session carries a `scripted` flag. `createSeedSession` sets it, every write
that edits a brief or a personality clears it, `/api/judges` builds its room
with it already false, and `isSeedScenario` is now that one field. The trip
name is no longer load-bearing.

Editing a brief or a personality also takes the finished run down with it:
turns, plan, fairness, reports and all four approvals. A plan computed from a
brief the human has since rewritten is a lie about the room, and the plan
screen renders whatever the session is holding, so leaving one there means an
edited brief can walk straight into a plan that predates it. That invalidation
is one function, `lib/session-writes.ts`, called by both `updateBrief` and
`/api/brief`, because two copies of an invalidation rule is one copy too many.
`approve` and `reset` are untouched.

`/api/brief` now stores the turn. The agent's own reply is appended to the
transcript before it is written, so a reload comes back to the whole
conversation rather than to one that stops at the last thing the human said,
and `BriefMessage` grew an optional `keptPrivate` so the "Kept private: $600
budget" badge survives with the line that earned it.

The seeded seat in front of the screen is genuinely empty now: no destination,
no dates, no ceiling, no wants. The populated version of it is exported as
`SAMPLE_BRIEF` with a matching `SAMPLE_TRANSCRIPT` and reached through a new
**USE THE SAMPLE BRIEF** button, which is a demo shortcut rather than a
starting state. Until something has been said, **NEXT: PERSONALITY** is a
disabled `PixelButton` rather than a link — `.px-press:disabled` already dims
and blocks one, so nothing new was invented — with a line under it saying so.
The briefed roster is derived from the four stored briefs instead of being a
hardcoded list of three names, which is also what makes it right in a judges'
round where all four seats fill at once.

`src/components/brief/seed.ts` is gone. `ChatMessage` moved next to the
component that renders one.

## Verification

`npm run typecheck` and `npm run lint` clean. `npm run check` green: 35/35
session-view, 7/7 offline-scenario, 15/15 fairness, 38/38 redaction.

Two fixtures were updated rather than relaxed. The golden grad-trip transcript
is scored against real briefs, so an empty seat would have made its fairness
row read 0 of 0; the fixture applies `SAMPLE_BRIEF` first, which is the same
content the run was captured against under a new name, and the transcript is
still byte-identical. The session-view fixture does the same, for the same
reason: its whole method is hunting the wire for a ceiling, and a seat with no
ceiling proves nothing. The hand-built judges' session now sets
`scripted: false`, matching what the route stores.

One check was added: a seeded session with the flag cleared keeps its trip name
and stops replaying the script. That is the bug, stated as an assertion.

A run made before anybody briefs the empty seat reports that seat as 0 of 5
kept and still computes `nobodyOverruled: true`, which is the honest reading of
a person who asked for nothing. One tap on the sample brief, or one sentence
typed, fills it.
