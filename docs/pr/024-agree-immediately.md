# PR #24 — fix: the plan appears when the room agrees, not when the write-up lands

## The bug

> "once everyone agrees, the plan actually lags and wouldn't show up until
> later. I hope this can show up as soon as the agents agree"

`runNegotiation` ended on two lines:

    yield { type: "agreed", plan, runnerUp: plan.runnerUp };
    yield { type: "done", fairness, reports, usage, elapsedMs };

Both at the very bottom of the generator. Between the round loop deciding the
room had settled and that `agreed` frame sat the whole finalisation block: one
`final-plan` call and then, one at a time in a `for` loop, four `agent-report`
calls — five round trips on the large model, sequential, with nothing on screen
to explain them. The last agent said its line, the town went quiet, and SEE THE
PLAN did not exist yet.

Nothing in those five calls decides anything. The offer the room agreed on was
picked by `findConvergedOffer`, which is arithmetic; the fairness meter is
`scoreFairness`, which is arithmetic; the plan card's price, destination,
flight note and highlights are fields on that offer. What the five calls
produce is prose: the runner-up and the sentence saying why it lost, and each
person's private note. The screen was waiting on the prose to show the
decision.

`/plan` could not soften it either. `planViewFrom` returns null unless the
session holds **both** a plan and a fairness report, and the route wrote the
plan on `agreed` and the fairness on `done` — so even the frame that did exist
was not enough to render on.

## The change

**The agreement is announced the instant the round loop makes it.** Both places
that set `converged` — `findConvergedOffer` and the `roomAssented` fallback —
are now followed by the `agreed` frame, inside the loop, before any
finalisation call. It is built from what is already in hand: `candidatePlan`
turns the converged offer into a `Plan` with no model call, and `scoreFairness`
scores it locally. `agreedInMs` is measured there, which is also where it
belongs — the field is how long the room took to agree, not how long the
write-up took afterwards, and pinning it there stops the number climbing under
a plan screen that is already printing it.

**The `agreed` frame carries the fairness report.** One field on the frame is
what turns "the plan exists" into "the plan screen renders", because
`planViewFrom` needs both halves. It is public: a fairness row is a participant
id, two counts and the one want that person gave up, it names no ceiling, and
`sessionViewFor` already hands the identical object to all four viewers because
the meter is the shared screen's headline claim. `eventForViewer` therefore
leaves the frame alone, which the session-view suite asserts frame by frame
rather than taking on trust.

**`done` carries the written-up plan**, so the client and the session both
upgrade from the provisional version — same trip, now with the runner-up, the
sentence about why it lost and the model's kept-wants list. `plan` and
`runnerUp` are optional on that frame because a run that produced no offers at
all still ends in it.

**The write-up cannot change what was agreed.** When `converged` is non-null
the final plan's `offer` is forced to exactly that offer. The room settled on
one thing, that thing is already on a screen somebody is reading, and this call
is prose about it rather than a second opportunity to pick. The runner-up, the
reason it lost and the kept wants stay the model's to write.

**The four private reports run concurrently.** They are independent — each
reads one brief, one fairness row and the finished plan, and none reads
another's answer — and awaiting them one at a time made the person waiting on
the fourth wait on three answers they never see. Each call keeps its own
failure handling, so one failed report costs its own card and the run still
reaches `done`; the record is assembled afterwards in roster order, so the
output does not depend on which call returned first. `provider` degrading to
the offline script survives the overlap: the retry re-reads it on entry, so a
caller that sets it and a caller already in flight both end up offline, and
setting it twice is setting it once. Usage accounting moved behind one
`addUsage` helper — the assignment was a single synchronous statement and lost
nothing either way, but "the read and the write are not separated by an await"
was a property of each call site rather than of the accumulator, and it feeds
the cost figure the plan screen prints.

**The route writes both halves on `agreed`** — plan and fairness — and the
written-up plan on `done` beside the reports and the usage. `BEAT_WEIGHT.agreed`
went from 0.5 to 0. The delay is applied *after* a frame is sent, so that half
beat paced nothing a person watched: it held the generator at the yield, which
is where it starts writing the plan up. The spoken lines are untouched — the
last one still holds its full beat, which is why the frame lands a beat after
the room stops talking rather than on top of it.

**`/plan` renders on the provisional plan and fills the report in.** The cold
path used to drain the whole stream and then read the session; it now drains
and reads at the same time, so the screen paints when the room settles instead
of when the write-up lands. The same loop keeps reading until the report
arrives — one poll, not two, because it is one wait seen twice. Where the
right-hand column used to render nothing without a report it now renders the
card saying so: the dark panel, the "Only you can see this" line, and **STILL
WRITING** — "your agent is writing up what it got you and what it traded away."
An empty column beside a finished plan reads as "you got nothing", and this is
the one panel on that screen that is yours.

## What the wait actually is now

Between the last spoken line and a rendered plan: **zero model calls.** The
frame is built from the offer the room already has and arithmetic over the
briefs. The five calls that used to be in front of it are now behind it — and
they are five calls in two waits rather than five, because the four reports
overlap.

## Verification

`npm run typecheck`, `npm run lint` and `npm run check` all clean. The suites
run 35/35 session-view, 12/12 offline-scenario, 17/17 fairness, 38/38
redaction.

Two checks were added to `lib/llm/__tests__/offline-scenario.check.ts`, both
confirmed to fail against the behaviour they are about before being kept:

- **the agreement is announced before any of it is written up.** Runs the
  seeded session through a provider that tallies calls by tag, and reads the
  tally at the moment the `agreed` frame is drained: no `final-plan` call and
  no `agent-report` call has been made, the frame carries a fairness row per
  person, and the run's total is exactly five calls higher by `done`. It also
  asserts the offer id on `done`'s plan equals the one on `agreed`, which is
  the "the write-up must not swap the trip" rule. Moving the yield back to the
  bottom of the generator fails it with "the plan was written up before the
  agreement was announced".
- **the four private reports are written concurrently.** The same provider
  records the most calls ever outstanding at once. Restoring the sequential
  `for` loop fails it with "reports ran 1 at a time, not 4".

The golden transcript is still green and its copy is untouched, but the
captured expectation was recaptured once, for frame order rather than wording.
`flatten` now records the plan from `done` as well as the one from `agreed`,
because they are two different frames saying two different things: the `plan|`
line is the offer the room settled on, with no runner-up and no prose, and the
new `final|` line is the written-up plan — `offer-puerto-rico`, runner-up
`offer-tulum`, "Tulum came in at $690 and every flight left at 6am", exactly as
it read before. Every spoken line, every offer and the fairness row are byte
for byte what they were.

Two existing checks moved with the new shape rather than being weakened. The
`agreed` fixture in `lib/__tests__/session-view.check.ts` gained the fairness
field and stays in the list of frames the narrowing must return untouched. The
unbriefed-seat check reads its prose fields off `done`'s plan instead of
`agreed`'s: an announcement frame legitimately has no runner-up and no sentence
about why it lost, and the assertion is that the *written* plan has no empty
slots in it.

`npm run build` and `npm run dev` were not run — this branch was worked from a
Linux shell against a macOS checkout, and the dev server on that machine was
serving the tree throughout.

## Known, not fixed

**The last spoken line still holds its beat.** `agreed` is pulled one
`speak`-weighted beat — about 1.1 seconds at 1x — after the room's last
sentence, because the route paces frames and that pacing is deliberate. Not
touched.

**A live `final-plan` call still gates the runner-up.** The plan screen shows
the trip, the price, the kept wants and the meter immediately; the "Runner-up:
Tulum at $690" line appears with `done`, because nothing local knows which
option came second or why it lost. Same for the private report, which is what
the STILL WRITING card is for.

**`POLL_MS` is one second.** The report can therefore land up to a second after
the run wrote it. Reusing the existing poll rather than opening a second
channel for one field was the trade; a stream the plan screen also listens to
would close the gap and is a larger change than this branch.
