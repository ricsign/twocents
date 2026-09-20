# PR #29 — feat: seed a room from a group chat, and let four people join it

## The gap

Every screen read one session, `"demo"`, and one person, `YOU`. Both were
module constants, which is why the four screens could simply import them — and
why there was no way for a second browser to be anybody else.

Two places said so in their own comments. `withSimulatedApprovals` approved
three of the four when the plan landed, noting that *"a build with four humans
on four devices would collect the other three the same way"*. `planViewFrom`
hardcoded those same three to `true`, noting that *"with four devices their
taps would arrive from theirs"*. This is that build.

## The shape

Five steps, of which three already existed.

1. **`/start`** — screenshots of the group chat, read into a draft roster.
2. **`/join/[code]` → `/lobby`** — each person claims a seat and briefs their
   own agent.
3. **The town** — unchanged, except that one browser runs it.
4. **The plan** — unchanged, except that the approvals are real.
5. **The itinerary** — unchanged.

## The photo cannot know your budget

`lib/ingest/schema.ts` is handed to the `emit` tool, so it is the contract the
model answers against rather than a hope expressed in a prompt. It has **no
field anywhere that can hold a number of dollars** — not a nullable one, not an
optional one. Money comes back as `moneyTone`, an enum of four words.

This is the difference between a feature and a broken promise. A group chat may
well contain "I can only do $600"; writing that into somebody's seat would mean
a host's photograph decided another person's private ceiling, which is the one
thing the README says never happens. The prompt says so too, but the prompt is
advice and the schema is the guarantee — the same discipline
`buildPublicSystemPrompt` uses, where the public prompt cannot reach a budget
because the argument it is handed does not have one.

So a photo-seeded seat carries `draft`, and the briefing screen opens on *"from
what I read, you wanted X — did I get that right?"* followed by the question the
product exists to ask. The first thing that person types is their own ceiling,
to their own agent. `/api/brief` clears `draft` on that turn and only there.

## No cookie means exactly the old behaviour

`lib/room/identity.ts` is the only module that knows about cookies, and its
fallback is defined as the constants it replaced: session `"demo"`, seat `YOU`.
A browser that never joined anything cannot tell rooms were added, which is what
keeps `docs/DEMO.md` running unchanged.

Cookies rather than `?room=`, because with query parameters "no room" becomes
"this link forgot the parameter" — and a forgotten parameter drops somebody into
the demo session silently, showing them a working app with the wrong four people
in it. That is worse than an error, because nothing about it looks wrong.

Two traps `normalizeRoomCode` exists for, both silent:

- **macOS is case-insensitive.** `MJ4K7P.json` and `mj4k7p.json` are one file
  while `Map.get` treats them as two rooms. Memory would believe in two rooms,
  disk in one, and a restart would hand back whichever was written last.
- **`"demo"` uppercases to `"DEMO"`**, a different map key and — on that same
  filesystem — the same file as the real default session.

## One run per room

`/api/negotiate` starts a negotiation rather than subscribing to one. Four town
screens would be four arguments over one session, four pacing loops, and four
writes racing to be the transcript that sticks.

Two guards, in the right order. The town screen only opens the stream on the
host's browser, so the other three do not ask; and PR #28's lease refuses them
on the server, which is the one that actually holds — a client gate is a
courtesy. Spectators poll the session and fill the same transcript a beat
behind, losing the speech bubbles and nothing else.

`PlanScreen` had the same problem more quietly: it runs the negotiation
headlessly at 8x whenever `/plan` opens without a plan, so four people landing
there early would have started four more runs on top of the town's. Gated to
the host.

## Real approvals

`withUnattendedApprovals` replaces `withSimulatedApprovals`. A seat is approved
automatically when it is **not the viewer** and **nobody has claimed it**.

- **Solo:** nobody ever claims, so the other three auto-approve and yours does
  not. Byte-identical to before, and the 1:30 "tap APPROVE" beat survives.
- **A room:** all four claimed, so the gate waits for four real taps. A chair
  nobody took — three friends and an empty seat — still approves itself,
  because there is nobody there to tap for it.

`planViewFrom` now reads `others[].approved`, which the session view has carried
all along as a public act.

## Two predicates, deliberately

`lib/flow.ts` owns `hasBriefed`: is there anything here for an agent to argue
from? A photo-seeded seat passes it, correctly — there is.

`session-view.ts` adds `hasSpoken`, which is what the lobby asks: has this
person said anything, as opposed to having been read? A room that counted
drafts as briefed would show four ticks the moment it was created and offer to
start before anybody had told their agent the one thing the chat never held.

## Also

- `/api/brief` had **no viewer check at all** — `participantId` came straight
  from the body, so any caller could brief anyone. It matters most there,
  because a brief is where the ceiling is written.
- RESET replaces the whole session, briefs included. Host-only once a room has
  a host; unchanged in a solo run, where it is a scripted demo beat.
- The judges' round clears the room cookies. It seeds the *default* session and
  then pushes to the town, so a phone still carrying a room code would have
  watched a different session — a bug that only appears when somebody
  demonstrates both features in one sitting, which is exactly when it is seen.
- `splurgyFor` gained a tone fallback. Every photo-seeded seat arrives with
  `budget: null`, and the old ranking put all four on the midpoint together —
  four agents on the same money slider, which is the axis the room argues
  hardest along.
- `CompletionRequest` grew one optional `images` field. Zero of the eight
  existing call sites changed; the offline provider ignores it.
- A refusal is now named in `anthropic.ts`. Without it a declined call is
  indistinguishable from a model that would not answer — and here the resilient
  provider would have quietly presented the canned roster as "what we read in
  your photo". `/api/ingest` detects it by zero tokens spent and says it could
  not read the picture, which is the truth.

## Checks

`npm run check` — all four suites, including the byte-identical seeded
transcript, which is the guard that the solo path did not move. `npm run
typecheck`, `npm run lint` and `npm run build` are clean.

Exercised end to end offline: mint a room, claim a seat, be refused the same
seat with a 409 and then take it with `force`, be refused a cross-brief and a
non-host reset with a 403, and open a lowercase join link onto the same room.
