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
    session-writes.ts     the two edits that invalidate a finished run
    session-view.ts       the one HTTP narrowing: a session, as one person
    flow.ts               has this person briefed their agent yet
```

