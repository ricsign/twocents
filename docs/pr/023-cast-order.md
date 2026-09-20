# PR #23 — fix(names): the cast is Richard, Angela, Will and Tsai

## The change

The four seats, in order, are **Richard**, **Angela**, **Will** and **Tsai**.
PR #18 had the first and third the other way round.

Ids, colours and sprite files are untouched, as they were then: `maya`,
`jordan`, `sam` and `priya` are internal keys that never reach a screen, and
`/sprites/maya.png` is a filename, not a person.

## Everywhere, not just the four fields

`CHARACTERS[*].name` drives every label that resolves through
`displayNameFor`, which is almost all of them. The rest were prose: the seeded
private reports in `offline.ts`, the comments across `seed.ts`,
`session-view.ts`, `prompts.ts` and the negotiate and session routes, the
fixtures and assertions in all four check suites, `docs/DEMO.md`,
`docs/DESIGN.md`, and the earlier PR write-ups that named the old cast. Those
now read with the new names too, so nothing in the repo introduces somebody
who is not in the room.

Two occurrences of "Will" were left alone because they are the verb: Angela's
note about driving to the airport, and the penny-pincher preset's bio.

## Verification

`npm run typecheck` and `npm run lint` clean; all four suites green, including
the golden transcript, whose fairness line names two of the four.
