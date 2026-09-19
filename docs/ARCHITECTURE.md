# Architecture

Next.js 16 (App Router) + React 19 + TypeScript + Tailwind v4. No database:
the whole demo lives in a server-side in-memory session store plus client
state, which is the right call for a 3-minute demo that must reset instantly.

```
src/
  app/
    page.tsx              title screen
    brief/                step 1
    personality/          step 2
    town/                 step 3
    plan/                 step 4
    api/
      brief/route.ts      streams the private briefing chat
      negotiate/route.ts  SSE stream of the negotiation
      session/route.ts    read/reset the demo session, narrowed to one viewer
  components/
    ui/                   design-system primitives (TopBar, PixelButton, Sprite, icons)
    brief/ personality/ town/ plan/
  lib/
    characters.ts         the four friends
    types.ts              domain model + zod schemas
    llm/
      provider.ts         Provider interface, model tiers, cost accounting
      anthropic.ts        live provider
      offline.ts          deterministic fallback, used with no API key
      index.ts            selects a provider
    negotiation/
      engine.ts           the round loop
      redaction.ts        the secret guard
      fairness.ts         scoring
    session.ts            in-memory store
    session-view.ts       the one HTTP narrowing: a session, as one person
```

## Two hard rules

1. **A private brief never reaches a public prompt verbatim.** The engine
   passes each agent a *public mandate* (what it may say) and keeps the
   *private brief* (the real number, the reason) in that agent's own context
   only. `lib/negotiation/redaction.ts` then scans every generated public line
   and rejects any that leaks a private figure, re-rolling the line. This is
   the product; it is enforced in code, not left to the prompt.

   The same rule holds at the wire. `lib/session-view.ts` is the only place a
   `DemoSession` is narrowed for a human: `GET /api/session?viewer=` and every
   POST response go through `sessionViewFor`, which hands you your own brief and
   your own report and gives you the other three as a `PublicMandate` — the same
   sanitized view their agents argued from. The engine still receives the whole
   session, and must: redaction, fairness and the private reports are all built
   on it holding the real briefs. Only the wire narrows.

2. **The app builds and runs with no network at all.** Fonts are self-hosted
   (`src/app/fonts.ts`), sprites are local, and the model layer falls back to
   canned answers with no API key. A venue with no wifi costs the demo its
   live model calls and nothing else.

3. **The demo never dies on stage.** If `ANTHROPIC_API_KEY` is missing, a call
   errors, or a call takes too long, the provider falls back to the scripted
   run, which produces the same event shapes at the same cadence. The UI
   cannot tell the difference.

## Model tiers

`claude-haiku-*` for per-turn banter (cheap, many calls), one
`claude-sonnet-*` call for the final plan and the four private reports. Token
counts are accumulated per run so the Plan screen can show a real cost figure.

## Event stream

The Town screen consumes SSE from `/api/negotiate`. Event types:

| Event | Payload |
|-------|---------|
| `round` | `{ round, of }` |
| `thinking` | `{ speaker }` |
| `speak` | `{ speaker, kind, text, privateReasonKept }` |
| `offer` | `{ speaker, offer }` |
| `agreed` | `{ plan, runnerUp }` |
| `done` | `{ fairness, reports, usage, elapsedMs }` |

`kind` is one of `proposes | pushes back | trades | counters | agrees`, which
is exactly the label the transcript prints next to the agent's name.
