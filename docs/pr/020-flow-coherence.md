# PR #20 — fix: the four steps hold together, in both directions

## The bugs

Four of them, all the same shape: a screen that was right the first time
somebody walked through it and wrong on the second pass.

**The town clobbered the run it was supposed to be showing.** `TownScreen`
called `start()` in a mount effect with no condition on it. Browser-back from
`/plan` — the most natural thing a judge does after approving — opened a second
stream, and `/api/negotiate` writes as it goes, so the session's turns, plan,
fairness report and four private reports were replaced with a different
outcome. Forward again and the plan screen showed a plan the judge had never
watched, with approvals still ticked from the one they had.

**The only control that ran it again also threw the room away.** `RESET` POSTs
`action: "reset"`, which replaces the session with a fresh seed. Since the
briefing became real state that also discards whatever the person in the seat
typed and every slider they moved — which is right between judges and wrong
during the demo. The personality-flip beat in `docs/DEMO.md` used RESET to mean
"run it again" and therefore reseeded the flip away before running it.

**The personality screen read seeds, not state.** `initialPersonality` was
`SEED_PERSONALITIES[YOU]`. A reload silently reverted the sliders, and the
revert was not merely cosmetic: the screen saves the whole personality object
on a debounce, so the next nudge wrote the seed back over the real value. The
opening sample line was a hardcoded sentence about Cancun lifted out of
`design/02-personality.clean.html`, so the first thing a judge read was an
argument about a destination the person in the seat had never mentioned, and
one that did not answer to the sliders underneath it.

**`/personality` and `/town` were reachable with nothing briefed**, which is
four sliders shaping an agent that has been told nothing, and a room where one
of the four arrived with no position to argue.

And underneath all four, the complaint that named this branch: the opening
flow did not explain itself. Four sprites and a PRESS START, with no answer to
which one you are, why the other three are already done, or what the four pips
in the top bar are counting. `/plan` had no way back at all.

## The change

**The town takes the finished run as initial state.** `town/page.tsx` narrows
through `sessionViewFor` and hands `TownScreen` a `FinishedRun` — the stored
turns and the plan — or null. `useNegotiation` grew a `replay()` that turns
that into the state a live stream would have arrived at: turns, the offers
hanging off them, the last round number, the plan, `status: "done"`, and
`elapsedMs` from `plan.agreedInMs` so the HUD reads the number the plan screen
prints. No bubbles, because the conversation is over and a bubble that never
fades claims somebody is mid-sentence.

The narrowing is load-bearing rather than tidy. The town is the screen where
every line in the room is on display, and `view.turns` keeps this viewer's own
`privateReasonKept` and strips the other three — which is the rule
`/api/negotiate` applies frame by frame, now applied once to the same data
arriving by a different road.

The auto-start is conditional on there being no plan. Because
`lib/session-writes.ts` already clears the plan on any brief or personality
edit, every path that used to auto-run still auto-runs: after briefing, and
after the flip. What stopped is a remount overwriting a finished run.

**RUN AGAIN and RESET DEMO are two buttons now.** `useNegotiation.rerun()` is
`begin()` without the reset POST: same briefs, same sliders, argued out again.
`reset()` is unchanged and keeps the total semantics, and both labels say which
one a judge is about to get. `/api/negotiate` replaces the session's turns
rather than appending to them, so a re-run leaves nothing of the previous one
behind.

**The personality screen reads the session.** Sliders come from
`view.you.personality`. The opening line comes from `sampleLine`, the same pure
function every drag already calls — it is synchronous, so the server render and
the first client render agree and nothing has to be filled in later. The nine
hand-written stances grew two slots, `{it}` and `{mine}`, filled from a
`SampleTopic` that `sampleTopicFor` derives from the view: the destination want
of whichever *other* agent holds the loosest `priceStance`, and this person's
own want. Both always open a clause, so a want that arrives capitalised reads
right without the line guessing whether it is a proper noun, and both are
trimmed at the first comma or dash so "Cancun — the hotel zone, right on the
strip" does not end up inside a sentence read aloud on stage.

Everything that feeds it is already public: `PublicMandate` is the sanitized
view the other agents argue from and carries a stance, never a ceiling. The
seeded room with the sample brief applied therefore resolves to exactly the old
copy — `contested: "Cancun"` — but it is derived now, and a judges' round about
dinner argues about dinner.

`/api/voice` is untouched, and so is the offline provider's bank of voice
lines. The screen still upgrades the line 350ms after a drag settles; it does
not fire that call on arrival, because there is nothing to wait for and firing
it would replace a line derived from this room with a canned one written for
the grad trip.

**`hasBriefed` is one predicate in `lib/flow.ts`.** `/personality` and `/town`
redirect to `/brief` when it is false, and `/brief` uses it for the roster it
was already computing inline. Three screens disagreeing about what "briefed"
means is how a judge ends up on a page that should not have let them in.

**The title screen explains itself in one screen.** The name tag under the
first sprite reads `WILL · YOU`, a line says the other three have already
briefed their agents, and four numbered cards name the steps the top bar
counts. Still a title screen: a tag, four cards, one button.

**The flow is traversable backwards.** `TopBar`'s green pips became links —
they were already the set of steps that are complete and safe to revisit, and
they get a 20px hit target from padding handed straight back with a negative
margin. The ones ahead stay decorative, because a link that lands on a redirect
is worse than no link. `/plan` also got BACK TO THE TOWN and JUDGES' ROUND
under the approval row, since that is the screen a judge is looking at when you
offer them a turn.

`docs/DEMO.md` follows: the warm-up now goes through the sample brief (the
guard bounces an empty seat), the flip beat no longer presses RESET, and the
run sheet says the cast's real names. Those names have said Maya, Sam and Priya
since PR #18 renamed them to Will, Richard and Tsai, which is a doc that
predates this branch and would have made the new beats read as two different
demos.

## Verification

`npm run typecheck` and `npm run lint` clean. `npm run check` green: 35/35
session-view, 7/7 offline-scenario, 15/15 fairness, 38/38 redaction.

No suite changed. Nothing here touches redaction, fairness, the engine or the
providers, and the golden grad-trip transcript is asserted against the engine
rather than against a screen.

The sample line was checked against the seeded room with `SAMPLE_BRIEF`
applied: the topic resolves to `{ contested: "Cancun", mine: "Somewhere warm
with a beach" }`, and the seeded sliders produce "Cancun is a stretch for us.
Somewhere warm with a beach. Could we look at that first?" — the old copy,
arrived at from the room instead of from a constant.

## Known, not fixed

The title screen reads the cast from `lib/characters.ts` rather than from the
session, so a judges' round that renames all four leaves `/` still saying Will.
Making it dynamic would cost the one static page in the app its static render,
for a screen nobody returns to mid-round.
