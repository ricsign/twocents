# Architecture

Next.js 16 (App Router) + React 19 + TypeScript + Tailwind v4. No database:
the whole demo lives in a server-side in-memory session store plus client
state, which is the right call for a 3-minute demo that must reset instantly.

```
src/
  app/
    page.tsx              title screen
    start/                step 0: the group chat, read and corrected
    join/[code]/          "who are you?" — the only dynamic segment
    lobby/                who has joined, who has briefed, the link to send
    brief/                step 1
    personality/          step 2
    town/                 step 3
    plan/                 step 4
    api/
      brief/route.ts      streams the private briefing chat
      negotiate/route.ts  SSE stream of the negotiation
      session/route.ts    read/reset the demo session, narrowed to one viewer
      ingest/route.ts     screenshots in, a draft out — writes nothing
      room/route.ts       a draft in, a room out
      room/claim/route.ts "that's me" — the only cookie writer besides judges
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


## How four agents end up arguing from one brief

There is no message passing between agents, and no shared conversation they all
append to. The shared thing is the **session object**, server-side, and every
agent is built from it on the turn it speaks.

**Writing.** `/api/brief` takes one turn of a private chat, makes two `fast`
calls — one to answer, one to re-derive the structured `Brief` from the whole
transcript — and stores the result on `session.participants[id].brief` through
`applyBrief`. That write also throws away any finished run: turns, plan,
fairness, reports and all four approvals. A plan computed before an edit is a
lie about the room, so it is not left lying around (`lib/session-writes.ts`).

**Reading.** `/api/negotiate` hands `runNegotiation` the *whole* session — all
four briefs, real ceilings included — because redaction, fairness scoring and
the private reports are all built on it holding the truth. What each agent
*sees* is narrowed at the moment its prompt is built:

```
brief  --mandateFromBrief-->  PublicMandate  --buildPublicSystemPrompt-->  system prompt
         (ceiling becomes a                    (mine, plus the other three's,
          stance; `private:` lines             so everyone argues from the same
          are dropped)                          public picture)
```

So an agent knows its own mandate, the other three's mandates, its personality,
and the last six turns of the table. That is the whole of its context.

**Three things it never sees, enforced three different ways:**

| What | How it is kept out |
|---|---|
| The real ceiling | *Type-level.* `buildPublicSystemPrompt` takes a `PublicMandate`, which has no budget field. It cannot reach one. |
| A leaked figure in a generated line | *Runtime.* `redaction.ts` scans every public line against that speaker's own secrets and re-rolls a leak. There is no path to the wire that skips it. |
| Anyone else's brief or report | *At the boundary.* `sessionViewFor` and `eventForViewer` narrow every response and every SSE frame. |

`buildPrivateReportPrompt` is the one function that reads a whole `Brief`, and
only to write that person's own report back to them.

**Worth knowing:** the negotiation argues from the *structured* brief, not from
the transcript. Nuance that `brief-extract` does not land in a field does not
reach the table. Widening what an agent knows means widening `PublicMandate`,
deliberately, rather than passing the chat along.

## One browser, several people

Identity is a pair — which room, which seat — and it is resolved per request
rather than stored per tab. Three carriers, highest first:

1. **The request.** `?room=&seat=` on a page, `sessionId`/`viewer` on an API
   call. This is what makes several people work in one browser.
2. **Cookies** (`twocents_room`, `twocents_seat`). Per browser, so one jar and
   therefore one identity — right for four phones, useless for four tabs.
3. **The default:** the `demo` session as `YOU`, which is a solo run and is
   exactly what the app did before rooms existed.

The consequence to design around: **the server keeps no per-tab state.** A tab
is only ever a URL plus whatever it sends, so N tabs are N independent clients
against one shared room. Two rules follow, and both are easy to break:

- Every link between screens threads the identity (`withIdentity`), or a tab
  silently falls back to the jar on the next click.
- Every per-viewer fetch names the seat it is acting as — the briefing turn,
  the plan read, the negotiation stream, the spectator and lobby polls. A read
  that forgets carries the *other* tab's private report.

The room itself exists once: one entry in the in-process `Map`, mirrored to
`.twocents/<CODE>.json`. Concurrent writes are safe by construction rather than
by locking — one process, one thread, and a read-modify-write with no `await`
between the read and the write.

Seats are `p1`-`p4` in a URL, never `maya` or `jordan`. Those are sprite keys,
and showing one to somebody the screen calls Player 2 names a person who is not
in the room.
