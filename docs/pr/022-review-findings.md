# PR #22 — fix: the empty seat, and everything downstream of it

## The bugs

PR #19 made the briefing real state and, with it, made the seat in front of the
screen genuinely empty: no destination, no dates, no nights, no ceiling, no
wants, until a human types something or taps **USE THE SAMPLE BRIEF**. That was
the right call and this branch is the bill for it. Nine of the twelve findings
below are the same sentence written in nine places — code that was correct
against a populated brief and is wrong against an empty one — and the other
three are races that only showed up once the flow could be walked backwards.

**A missing ceiling sorted as the richest seat.** `byCeilingDesc` in
`lib/llm/scenario.ts` mapped a null ceiling to `POSITIVE_INFINITY` and sorted
descending, so the person who had named no number became the `opener`, "the
one with the most room": they proposed the expensive option and then had their
headline want taken off them as the price of the plan. A human who typed one
sentence with no figure in it was cast as the big spender. The codebase
disagreed with itself about this — `priceStanceFor(null, …)` in `lib/types.ts`
already reads an unstated ceiling as the tight end of the scale.

**Blanks were interpolated raw.** `opener.wants[0] ?? opener.want` is `""`
falling through to `""`, so the opener's private report opened its second
sentence with a full stop, and `offer.dates` put an empty clause in the middle
of the plan summary. There is precedent for the fix two directories away:
`NO_CONTESTED` and `NO_MINE` in `components/personality/sampleLine.ts`.

**The trip's dates were read off seat zero.** `buildOfflineHints` took `when`
and `nights` from `people[0]`, which is always `maya` — the person at the
keyboard — so three seeded briefs saying "Mar 14–19" produced offer cards with
no dates on them.

**A pending save died on unmount.** `useDebouncedEffect`'s cleanup cleared the
timer *and* aborted, so moving a slider and leaving the screen inside 500ms
dropped the personality write. That write is what clears the finished plan, and
a cleared plan is what makes the town run itself on arrival — so the town
repainted the previous run and the personality flip, the one interactive beat
that proves the agents are not scripted, visibly did nothing.

**RESET DEMO stranded the presenter.** It reseeded the session — whose fourth
brief is now empty — and then opened a fresh stream on that room, while
`/town` and `/personality` were bouncing an empty seat back to `/brief`. The
button was arguing out a room the screen it lived on was being evicted from.

**`keptPrivate` was stripped on every re-post.** `/brief` posted
`next.map(({ role, text }) => ({ role, text }))`, and the route stores what it
is sent as the whole transcript. From turn two onward only the newest agent
line kept its badge, and a reload lost "Kept private: $600 budget" — which is
the one line PR #19 exists to preserve.

**Two negotiations could run at once.** `/plan` runs the negotiation itself
when opened cold; `/town` starts one whenever the session has no plan. Tapping
the step-3 pip while the plan screen was still draining opened both, each
writing to the session independently, and the store could end up holding run
B's `plan` beside run A's `fairness` and `reports`.

Plus four smaller ones: `row.wantsTotal || SLOTS` rendering a seat that asked
for nothing as "0 of 5 wants kept" next to a correctly green "Nobody
overruled"; the speed buttons highlighting and doing nothing on a run that was
painted rather than streamed; `"- Will: wants ; on money they are …"` reaching
a live negotiation prompt; and the briefed roster printing a tick beside every
name but your own whatever the data said.

## The change

**Scenario generation stops treating silence as wealth.** An unknown ceiling
sorts to the bottom, which makes that seat the `holdout` — the one who pushes
back without ever saying why — and agrees with the public stance the other
three argue against. Two fallbacks, `NO_WANT` and `NO_WHEN`, stand in for a
brief that stated nothing, and one helper, `wantOf`, is what every report now
calls instead of falling through one blank to the next. `scenario.when` is
resolved once in `buildScenario` rather than at each of the six places it is
printed. The beats were left alone: they already route their wants through
`echoWant`, which returns null on an empty string, and the hand-written
fallback each one falls back to ("the one thing I came in for") reads better in
its own sentence than a shared constant would.

**The engine takes the first stated dates and the first stated nights** across
all four briefs, in roster order, rather than whatever seat zero holds. It does
not try to reconcile four briefs that disagree, because they are briefs for one
shared trip and that is not this module's call to make.

**`useDebouncedEffect` distinguishes superseded from unmounted.** The abort is
raised at the top of the *next* run rather than in the cleanup. A key change
therefore still cancels the answer to an abandoned slider position, and an
unmount — which is not a superseded value, it is the last chance the call has
— flushes the pending call instead of dropping it. The behaviour is a
documented option, `flushOnUnmount`, defaulting to true: the voice preview
passes false, because once the screen is gone there is nothing for that answer
to repaint and firing it spends a model call for nothing.

That fixes the write. It does not on its own fix the beat, and this is the one
place the branch goes past the line it was pointed at. `/town` renders the
session on the server and the client fetches that render *before*
`/personality` unmounts, so a save flushed on the way out still lands after the
town has been told the session holds a finished plan. **SEND MY AGENT TO THE
TOWN is therefore a button rather than a link**: it awaits the save, drops the
router's cached payload and then navigates. Bounded at 1200ms, because a hung
request is not a reason to strand somebody on stage. `keepalive: true` is on
the save for the paths that are still links — the top bar's pips, browser-back
— where the write has to outlive the navigation it cannot block.

**RESET DEMO goes to `/brief` and starts nothing.** A fresh seed is a room
whose fourth agent has been told nothing, and `/brief` is the only screen that
can honestly render one; it is also the beat the demo restarts from. The three
reset-and-navigate paths now do the same three things in the same order —
clear the session, `router.refresh()`, push — and differ only in destination,
because they are pointed at different entrances: the town's at step 1, the plan
screen's **RESET FOR THE NEXT JUDGE** at `/judges`, where four empty seats and
a START button are exactly what a cleared session is for. The judges' own START
gained the `refresh()` it was missing, so a second round is not painted from
the first one's cached RSC payload.

**`/api/negotiate` holds one run per session.** The second caller gets 409
rather than a tee of the first stream: teeing means one run answering to two
paces, two speeds and two aborts, for a benefit neither caller needs — the run
in flight is already writing the outcome both of them want. So both clients
treat the refusal as "somebody else is getting this for us". `PlanScreen` polls
the session until the plan lands; `useNegotiation` does the same and then
paints the result exactly as it paints a run the session was already holding.
It is a lease rather than a flag: `releaseRun` runs in a `finally` covering a
clean end, a thrown encoder, an abort and a hung-up client, and an entry older
than 180 seconds is treated as abandoned and taken over, because a session that
can never negotiate again is a worse failure on stage than two runs racing once.

**The briefing posts whole messages** minus the client-only `id`.
`briefMessageSchema` has carried `keptPrivate` since PR #19 added it, so
nothing on the wire or in the store had to change.

**The fairness meter says "nothing asked for"** for a seat with no stated
wants, rather than "0 of 5" beside an empty bar. The scoring maths is
untouched: the row is already right, only its caption was lying about it.

**The speed group dims with the pause button** on a finished or not-yet-started
run, since both act on a stream a replayed run does not have. **The public
system prompt and the plan prompt** get `statedWant`, and the private report
prompt gets an explicit `(they did not say)` where a human filled nothing in —
a bare `- Wanted:` is an invitation for the model to fill the gap itself.
**The roster's tick follows `briefed`** for every seat including your own.

## Verification

`npm run typecheck`, `npm run lint` and `npm run check` all clean. The suites
run 35/35 session-view, 10/10 offline-scenario, 15/15 fairness, 38/38
redaction.

No assertion was weakened and no fixture was changed. The seeded grad trip is
still byte-identical to the captured run, which is the check that would have
caught any of this leaking into the demo's own transcript: the scripted path
never reaches the generator.

Three checks were added to `lib/llm/__tests__/offline-scenario.check.ts`, and
each was confirmed to fail against the code it is about before being kept:

- **an unknown ceiling does not make that seat the opener.** Calls
  `buildScenario` on a room where one of four named no number and asserts that
  seat is the holdout and the highest stated ceiling opens. Restoring
  `POSITIVE_INFINITY` fails it.
- **a plan and a report built from blank fields have no empty slots.** A room
  with no dates and two seats that said nothing at all, scanned across the
  whole generated plan, all four private reports and all four roles at every
  beat, for the shapes a blank leaves behind: punctuation with nothing in front
  of it, a doubled comma, a run of whitespace. Reverting either `wantOf` or the
  resolved `when` fails it.
- **a room with an unbriefed seat still reads as sentences.** The same scan
  end to end, over the actual seeded session with the actual empty seat, so the
  state the demo starts in is covered by a run rather than by hand-built hints.

The 409 path is not covered by a suite. The check runner drives the engine
directly and never goes through a route, so adding it would have meant standing
up a server for one assertion; the guard is small enough to read and the two
clients' handling of it is the part that matters.

## Known, not fixed

The top bar's step pips are ordinary links. Pressing the step-3 pip within half
a second of moving a slider can still paint the town from a session that has
not been told about the move — the write lands (that is the hook fix) but the
render is fetched first. Making every link in the app wait on an in-flight save
is a much larger change than this branch, and the screen's own button is now
the safe path. `docs/DEMO.md` says so.

`docs/DEMO.md` follows the two behaviour changes a presenter can see: RESET
DEMO now lands on `/brief` and starts nothing, and the speed control is stream
state that opens at 1x every time the town screen does, so 2x is tapped during
the run rather than set beforehand.
