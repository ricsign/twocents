# PR #18 — feat(names): the cast is Will, Angela, Richard and Tsai

## The change

The four default display names change: `maya` → **Will**, `jordan` →
**Angela**, `sam` → **Richard**, `priya` → **Tsai**.

Ids, colours and sprite files are untouched, because nothing outside
`CHARACTERS[*].name` is keyed on a name. Almost every label in the app already
goes through `displayNameFor` / `agentName`, so the four `name` fields drive
the whole UI: the briefing header, transcript rows, name tags, fairness bars,
the approval roster and every sanitized prompt.

## The one place that did not go through the resolver

`offline.ts`'s seeded `REPORTS` spliced literal names into prose — *"Sam
wanted the resort"*, *"backing Maya's number"*. Those four strings are what a
judge reads at the payoff moment of the demo, and left alone they would have
printed "Richard's agent" in the name tag above a report body still talking
about Sam. They now carry the new names.

## Verification

`npm run typecheck` and `npm run lint` clean. `npm run check` green: the three
assertions that pinned the old defaults (`fairness` ×2, `session-view` ×1) were
updated with them, and the seeded grad-trip transcript is still byte-identical
to the captured run.
