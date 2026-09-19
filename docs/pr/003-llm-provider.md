# PR #3 — feat: model layer with a fallback the demo can't fall off

## Summary

Adds `src/lib/llm/`: a provider contract, a live Anthropic implementation, a
canned offline implementation, and a wrapper that silently swaps to the canned
one when anything goes wrong. On stage this is the difference between a demo
and a black screen.

## What's in it

- **`provider.ts`** — `LLMProvider` with `text()` and `json()`, a `TaskTag`
  union naming every call site, and `TIER_FOR_TASK` mapping tags to models.
  Everything runs on Haiku except the final plan and the private reports,
  which run on Sonnet. That one table is the whole "small model for banter,
  large model for the plan" cost argument, so it lives in one place with
  real pricing next to it and a per-run cost estimate.
- **`anthropic.ts`** — the live provider. `json()` does not ask nicely for
  JSON; it forces a single tool call whose input schema is generated from the
  zod schema, so the model structurally cannot answer in prose, and the result
  is still validated with zod before it is returned. Every call races a 20s
  deadline and retries once on 429/5xx/timeout.
- **`offline.ts`** — deterministic canned answers per tag, matching the copy
  in `design/03-town.clean.html` and `design/04-plan.clean.html` beat for
  beat. It never throws: given an unfamiliar schema it seeds what it knows,
  and a small total `fabricate()` walker fills the rest with the minimum the
  schema accepts.
- **`index.ts`** — `getProvider()` picks live vs offline from
  `ANTHROPIC_API_KEY` / `TWOCENTS_FORCE_OFFLINE`, and wraps the live one in
  `ResilientProvider`, which falls through to the canned answer on any throw.

## Why forced tool use

Prompted JSON fails a few percent of the time, and a few percent across a
five-round negotiation is a coin flip on whether the demo completes. Tool use
moves the guarantee from the prompt into the API contract.

## Verification

`tsc --noEmit` clean. The offline provider was exercised on all six tags: the
briefing reply to a message containing `$600` was asserted not to contain
`600`, voice preview produced six distinguishable lines across slider
extremes, all five negotiation beats matched the mockup copy, and `final-plan`
parsed against `planSchema`. Garbage context on every tag produced no throw.
