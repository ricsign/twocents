# PR #27 — fix: the plan screen stops claiming what the data does not say

## The bug

One live run, briefed at a $600 ceiling in the seat at the keyboard. The room
agreed on Cancun at $1,200 a person, and the plan screen printed:

> $4,800 for the group, **inside everyone's real budget.**

directly above its own fairness meter:

> Richard 3 of 5 · gave up staying under budget
> Angela 2 of 5 · gave up staying under budget
> Will 5 of 5 wants kept
> Tsai 4 of 5 · gave up staying under budget

Three bugs stacked to produce that, and a fourth was visible in the same
frame.

## 1. The headline asserted the claim unconditionally

`PlanHeadline` printed `inside everyone's real budget` as fixed prose. It is
the one sentence the whole product is selling, and it was the one sentence on
the screen nothing computed.

It is now read off the report the bars beneath it are drawn from.
`scoreFairness` appends a budget row per brief and ranks a broken ceiling
above every other loss, so a row whose `gaveUp` clause is the budget one is a
person this plan priced out — that is already how the meter decides what to
print. The clause moved into `GAVE_UP_BUDGET`, exported from `fairness.ts`, so
the headline and the bars read the same string and cannot drift apart.

Three branches, no scoring maths touched:

- **no row over its ceiling** — `$2,160 for the group, inside everyone's real
  budget.` Unchanged from what the demo has always said, now earned.
- **somebody over** — `$4,800 for the group. Three of them are over the number
  they gave their agent in private.` (`One of them is` in the singular.) It
  says how many and stops: not who, because the meter directly below names
  them once already, and never how much, because the ceiling is the one figure
  a screen all four of them read at once may not carry.
- **no rows at all** — `$4,800 for the group.` An empty report means nobody was
  scored, not that nobody went over, and the meter under it is empty in the
  same breath. Print the total, claim nothing.

The second branch is written to be read aloud. It is not an error state: it is
a real outcome of a real negotiation, and the honest version of it was already
on the screen six inches lower.

## 2. The assent fallback ignored what people can pay

    if (converged === null && roomAssented(turns, order.length)) {
      converged = [...offers].reverse().find((o) => o.feasibility?.bookable !== false) ?? null;
    }

`findConvergedOffer` — the primary rule — checks the room's tightest stance
ceiling, the dealbreakers and `nobodyOverruled`. This fallback checked none of
them: the most recent bookable offer, at any price. That is how $1,200 settled
a room holding two "must be cheap" seats.

The ceiling arithmetic is now one function, `lowestStanceCeiling`, used by the
primary rule, by the fallback and by the offline hints, which had a third copy
of the same reduce. `isBookable` is the other half, also shared.

The fallback became `assentedOffer`, which answers a different question from
`findConvergedOffer` — that one asks "may they agree to this?", this one asks
"they have agreed, to what?" — under the same affordability rule:

- the **latest** offer the room's tightest stance can carry, keeping the
  existing "converge on where the room just got to" bias;
- when nothing on the table clears it, the **cheapest bookable** one. The table
  did say yes to something, and ending a demo with no plan is worse than
  ending it with an expensive one. Ties go to whichever was proposed first, so
  two runs of one session settle identically.

The property that this fires only when the whole rotation said "agrees" is
untouched, and so is the pacing.

## 3. The agents agreed to things their own person cannot afford

Rule 6 of the public system prompt said agreement is the point. Nothing said
an agent may not agree to something over its person's limit, and the player's
agent duly said "that's over what works for us" and then agreed anyway two
rounds later. New rule 7, in the existing numbered style:

> 7. Never agree to an option that costs more than your person can do — their
> stance on money, above, is the whole of what you know about that limit and
> the whole of what you need. Say plainly that it is over, and then either put
> something cheaper up or hold where you are. Saying it is over and agreeing
> to it two lines later is the one move you never make.

`buildPublicSystemPrompt` takes a `PublicMandate` and no `Brief`, so the only
limit it can name is the stance it already prints under WHAT YOU ARE HERE FOR.
The rule points at that and nothing else: no figure enters a prompt whose
output is public, and rule 1 — never state a figure or anything close to one —
is intact above it. The redaction suite is unchanged and still green;
`checkForLeaks` scans every generated line either way.

The two rules after it renumbered to 8 and 9.

## 4. "NOT BILLED" was printed before the run had finished

`RunStats` derived one boolean — `tokens === 0` — and read it as "offline". The
plan screen renders the moment the room settles, which is five model calls
before `done` writes the usage tally, so for those seconds the panel told a
judge there was no API key while a live run was spending money three feet
away.

An empty tally has two opposite meanings and `usage.calls` separates them: a
finished run has made at least one call whatever it cost. `costStateOf` now
returns one of three:

| state | value | note |
| --- | --- | --- |
| `running` (`calls === 0`) | `STILL RUNNING` | the agents are still working — the bill lands with the last report |
| `offline` (`calls > 0`, no tokens) | `NOT BILLED` | offline fallback — no key, no tokens, no charge |
| `billed` | the run's own cost | one model for every call: <that cost>, and how much more it is |

`running` is exactly the window the report card beside it fills with STILL
WRITING, and it ends on the same frame. The paragraph beside the cell gained
its own third branch, and the temporarily hidden MODEL CALLS cell was updated
so it still compiles when somebody uncomments it.

## Verification

`npm run typecheck`, `npm run lint` and `npm run check` all clean. The suites
run 35/35 session-view, 14/14 offline-scenario, 17/17 fairness, 38/38
redaction.

One check was added to `lib/llm/__tests__/offline-scenario.check.ts` and
confirmed to fail against the old engine before being kept:

- **a table that assents over every ceiling settles on the cheapest.** Four
  seats that all read as "must be cheap", and a room scripted through a new
  `ScriptedRoomProvider` — the canned generator is built to land on something
  everybody can afford, which is the one run this check must not have, so
  `negotiation-turn` is answered from a script and everything else still comes
  from `OfflineProvider`. Two options go up, $950 and then $1,200, both over
  the stance ceiling and both bookable; the rest of the table assents and
  keeps assenting. The expensive one is proposed second on purpose: "most
  recent bookable" and "cheapest bookable" are the same answer in most rooms,
  and that ordering is what tells the two rules apart. The check asserts the
  premise (every seat under the cheap ceiling, both offers over it, neither
  ruled unbookable), that the room settles on the $950 option, and then the
  two facts `PlanHeadline` reads: `nobodyOverruled` is false and all four rows
  name the budget as what they gave up. Against the old fallback it fails with
  "the assent fallback took offer-cliff at $1200pp".

`STANCE_CEILING` is exported for it, so the check can say "these options are
all over what these four can be asked to pay" without writing 850 down a
second time and letting the two copies drift.

The golden seeded transcript is byte-identical and its fairness row is
unchanged, so the demo's own beat still prints "inside everyone's real budget"
— now because the meter says so.

`npm run build` and `npm run dev` were not run: this branch was worked from a
Linux shell against a macOS checkout, with the dev server on that machine
serving the tree throughout.

## Known, not fixed

**`assentedOffer` does not re-check dealbreakers or fairness.** It is the
"they have already agreed" path, and blocking there would leave a room that
said yes with no plan at all. The fairness meter reports what it cost, and
after change 1 the headline no longer talks over it.

**The over-budget headline counts, it does not name.** A judge reading the
meter can see who; the sentence above deliberately will not say it, and says
nothing at all about how far over anybody went.

**The cost panel's `running` state ends when `done` lands, not when the last
token is spent.** The tally only crosses the wire on that frame, so a run that
dies before it leaves the panel reading STILL RUNNING. That is truer than the
old "NOT BILLED", and closing it properly needs the route to stream usage,
which is a larger change than this branch.
