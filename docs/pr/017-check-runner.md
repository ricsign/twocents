# PR #17 — chore: one command runs the four check suites

## The problem

The four `*.check.ts` suites each carried a paragraph of instructions for
running them by hand: compile with a throwaway `tsconfig`, symlink
`node_modules/@` so the path alias resolves, then `node` the emitted file. In
practice that meant nobody ran them, which is the wrong property for the only
tests this project has on the weekend it is being changed fastest.

## The change

`tsconfig.check.json` plus `scripts/check.sh` encode that recipe once, and
`npm run check` runs all four and exits non-zero if any fails. `npm run
typecheck` is added alongside it so the two commands that gate every change
are both one word.

Nothing about the suites themselves changed.

## Verification

`npm run check` — session-view 35/35, offline-scenario 6/6, fairness 15/15,
redaction 38/38. `npm run typecheck` clean.
