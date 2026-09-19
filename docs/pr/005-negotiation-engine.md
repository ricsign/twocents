# PR #5 — feat: the negotiation engine, session state and the SSE API

## Summary

The round loop that turns four briefs into one plan, the in-memory session it
runs against, and the streaming endpoint the Town screen consumes.

## What's in it

- **`src/lib/seed.ts`** — the demo's starting state. Sam, Jordan and Priya
  arrive pre-briefed; Maya is left empty for the user to brief live on stage.
  Each brief carries four stated wants; `scoreFairness` adds the budget
  ceiling as a fifth implicit one, which is what makes the meter read "n of 5"
  exactly as the mockup does.
- **`src/lib/session.ts`** — a `globalThis`-stashed map, reload-safe under the
  dev server. No database: a three-minute demo that has to reset between
  judges is precisely the case where persistence is the wrong call.
- **`src/lib/negotiation/prompts.ts`** — prompt construction, isolated so the
  invariant is visible in one file: exactly one function here may see a
  `Brief`, and it is the one whose output never leaves its owner. The public
  prompt takes a `PublicMandate`, so the type system, not discipline, keeps
  the real budget out of it.
- **`src/lib/negotiation/engine.ts`** — `runNegotiation()`, an async generator
  emitting the `NegotiationEvent` stream. Agents speak in rotation, offers are
  passed between them as compact structured objects rather than replayed prose,
  and the run stops as soon as it converges.
- **`src/app/api/negotiate/route.ts`** — SSE, with the request's abort signal
  wired into the generator so a disconnect stops generation, and a `speed`
  multiplier that paces the beats for the stage.
- **`src/app/api/session/route.ts`** — read, reset (the judges' round), patch a
  brief or personality, record an approval.

## The convergence rule

Deterministic, not a model call. An offer is accepted when it sits inside every
participant's *public* price stance, violates nobody's dealbreaker, and passes
`scoreFairness(...).nobodyOverruled` — which is where the real private ceilings
finally get a vote without ever entering a prompt.

It is deterministic on purpose. The demo reruns with one slider moved and
attributes the different outcome to that slider; that claim only holds if
everything else is fixed. It also saves four model calls a round.

## The leak retry loop

Every generated line is scanned with `checkForLeaks` against its own speaker's
secrets before it can become a `speak` event — there is no code path to `speak`
that skips the scan, and offer free text goes through the same check. On a
leak: one retry with a correction that does not restate the protected value.
If it leaks again, the redacted line ships. Leaks caught are counted per run.

## Verification

End-to-end on the offline provider: 2 rounds, 8 turns, converges on Puerto Rico
at $540, `nobodyOverruled` true, fairness rows landing on Maya 4/5, Jordan 4/5,
Sam 3/5 (gave up the resort), Priya 5/5 without tuning.

Adversarial runs:

- a provider that leaks `$600` on every Maya turn → 3 leaks caught, **0 shipped**
- a provider that throws on every call → degrades to offline mid-stream and
  still reaches a plan
- a pre-aborted signal → zero events, zero model calls
