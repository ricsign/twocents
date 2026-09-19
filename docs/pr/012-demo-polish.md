# PR #12 — feat: judges' round, run stats, a real reset and docs

## Summary

The last mile: the beat that ends the demo, the numbers two sponsor stories
need, a reset a judge's round can rely on, and documentation that isn't
create-next-app's.

## The judges' round (`/judges`)

Four seat cards — a sprite, a name, a one-line want and a budget under a lock
— plus a shared topic and date. Prefilled with a dinner scenario so a judge can
hit START, every field editable. `POST /api/judges` builds four briefs, keeps
each typed budget as that person's private ceiling, reseeds the session and
routes to `/town`.

It reseeds the default session rather than minting a new id, because `/plan`,
`/brief` and `/api/negotiate` all read `DEFAULT_SESSION_ID` — a separate id
would negotiate in the town and then find nothing on the plan screen.

`priceStanceFor` bands ceilings against per-person *trip* totals, so four
dinner budgets all collapsed to "must be cheap" and the agents stopped
disagreeing about money. The money axis is restored by ranking the four typed
budgets against each other and setting `splurgy` from the rank. The ceiling
itself is untouched — it is what the redactor guards.

## Run stats

A modest strip on the Plan screen, below the private report, never above it:

```
AGREED IN 0:02  against three weeks in the group chat
MODEL CALLS 25  20.2K in / 4.3K out
COST $0.0731    one model for every call: $0.1251 (42% more)
```

The comparison figure is the run's own token counts repriced at the large
model's rate card — `estimateCost("smart", …)` — not a number someone wrote
down. With no API key the strip reads **COST: NOT BILLED**, "scripted run,
nothing sent", rather than a `$0.0000` that would read as a claim.

## Reset

13ms. Clears turns, plan, fairness, reports, approvals and usage; leaves the
four briefs intact. `useNegotiation.reset` now aborts the live stream, posts
the reset, and only then opens a new one, so no in-flight frame can write into
the session it just replaced. Verified: run, reset, rerun gives 8 fresh turns
rather than 16, including after a 20-turn judges run.

## Docs

`README.md` rewritten. `.env.example` with every variable, `ANTHROPIC_API_KEY`
empty at the top and a note that empty is a supported mode. `docs/DEMO.md` is
the 3-minute run sheet with a pre-demo checklist.

## Known weakness, documented

Offline, the scripted provider replays the grad-trip lines whatever topic a
judge types, so the judges' round currently says "Cancun, $1,180 a person" for
a dinner. `docs/DEMO.md` says so and points the beat at the private report
instead when running without a key. Tracked for the next PR.
