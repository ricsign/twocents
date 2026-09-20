# PR #14 — fix: a judge should see their own party in the room

## The problem

`/judges` let someone type four names, then stored them only inside
`personality.bio`. Every visible label read the fixed cast from
`characters.ts`, so a judge typed "Dana, Raj, Ben, Kim", hit START, and
watched Richard and Angela argue about their dinner. The closing beat of the
demo is a judge seeing *their own party* in the room, and it didn't land.

## The fix

One optional field, `ParticipantState.displayName`, absent on the seed and set
only by `/api/judges`. One resolver:

```ts
displayNameFor(names: DisplayNames | undefined, id: ParticipantId): string
```

That function is the only place that decides what a person is called. Two
collectors feed it — `displayNamesOf(session)` server-side and
`displayNamesFromView(view)` after the wire — and neither makes a decision. No
`?? characterOf(id).name` survives anywhere else, which was the thing worth
avoiding: that pattern would have ended up in a dozen components and drifted.

Names flow through the session view (so the client gets names without getting
briefs), the offline scenario generator, the public prompts and each private
report — an agent now addresses "Dana", not "Richard". Sprites, colours and ids
are untouched; Richard's seat is still the coral one.

## Also: "1 nights"

The scenario generator gave a non-overnight option `nights: 1`; it now gives
`0`, and `PlanHeadline` has a `nightsClause()` returning `"5 nights"`,
`"1 night"` or nothing at all. A dinner has no nights.

## Verification

Seeded run unchanged: `/town` reads `MAYA · YOU JORDAN SAM PRIYA`, `/plan`
reads `Mar 14–19 · 5 nights` and the same four fairness rows.

Judges run (Dana / Raj / Ben / Kim, "Dinner tonight"): `/town` reads
`DANA · YOU RAJ BEN KIM`, the plan reads `Tonight, 7pm · $18 a person`, and
grepping the rendered HTML of both pages for `Richard`, `Angela`, `Will` and
`Tsai` returns **zero hits each**, including in `alt` attributes. No ceiling
figure appears in the visible text of either page.

`tsc`, `eslint src`, `next build` clean. All four check suites pass:
session-view 21/21, fairness 15/15, redaction 38/38, offline-scenario green.

## Noted, not fixed here

The SSE `done` frame still carries all four `AgentReport`s, so every
participant's `secretsKept` crosses the wire on `/api/negotiate`. Neither page
reads it — both use the narrowed session view — but the stream itself isn't
narrowed the way `sessionViewFor` is. Same class of bug as PR #11; next PR.
