# PR #2 — feat: domain model for briefs, secrets and the negotiation

## Summary

Adds `src/lib/types.ts`, the vocabulary the whole app speaks. Every concept is
a zod schema with its TypeScript type inferred from it, so the same definition
that types the code also validates JSON coming back from the model.

## What's in it

- **`Personality`** — four 0-100 sliders (stubborn, splurgy, blunt,
  adventurous) plus a bio, with `PERSONALITY_PRESETS` for Diplomat, Bulldog
  and Penny Pincher. `describePersonality()` turns the sliders into the
  prompt instruction *and* the on-screen voice preview, so what the user is
  shown is literally what the agent is told. All thresholds live in one
  `PERSONALITY_THRESHOLDS` table.
- **`Brief`** — what one person told their agent in private, including
  `budgetCeiling`, the number the product exists to protect.
- **`Secret`** — the block list. `secretsFromBrief()` expands a ceiling into
  every literal form that must never be spoken (`$600`, `600`,
  `600 dollars`, `six hundred`). Privacy is marked deterministically with a
  `private:` prefix rather than inferred by a model.
- **`PublicMandate`** — the sanitized view an agent may argue from.
  `mandateFromBrief()` replaces the ceiling with a qualitative
  `priceStance`, shaded by the frugal/splurgy slider so two people with the
  same budget don't argue alike, and strips private dealbreakers.
- **`Offer`, `NegotiationTurn`, `Plan`, `FairnessReport`, `AgentReport`** —
  the negotiation and its outputs. `TurnKind` keeps the five strings the UI
  prints verbatim: `proposes | pushes back | trades | counters | agrees`.
- **`NegotiationEvent`** — a discriminated union matching the SSE contract in
  `docs/ARCHITECTURE.md` field for field.
- **`Usage`** + `sumUsage()` + `NEGOTIATION_ROUND_CAP` — token accounting,
  for the cost figure on the Plan screen.
- **`DemoSession`** — the whole run, in one object.

## Design note

The separation between `Brief` (private, holds the number) and
`PublicMandate` (sanitized, holds a stance) is the architectural expression of
the product promise. An agent's public prompt is built from the mandate; the
brief never enters it. The `Secret[]` block list is the second line of
defence, checked against generated output.

## Verification

`npx tsc --noEmit` clean. Pure helpers spot-checked:
`priceStanceFor(600, pennyPincher)` → `"must be cheap"`, `mandateFromBrief`
drops private dealbreakers and the ceiling, `sumUsage` folds and dedupes.
