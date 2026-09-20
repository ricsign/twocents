# PR #16 — fix: an agent never says the same sentence twice

## The bug

Each role's closing beat drew from three phrasings via `variants[index % 3]`.
The index advances about once per round, so at the five-round cap three agents
wrapped around and repeated their own first sentence verbatim.

On stage that is the clearest possible tell that the thing is scripted, which
is exactly the impression this project cannot afford.

## The fix

`closingLine(index, written, assents, tails)` keeps the three hand-written
rungs first, in the order they read best — warm yes, restatement, impatient —
then composes an assent with a tail clause on two independent cycles. That
takes each role from 3 distinct lines to 19, injective across the pool, and it
gets terser as it goes: *"Still yes. I've got nothing to add to that."* Which
is what someone who has said their piece actually sounds like.

Still pure and deterministic: index in, line out, no clock and no random
source.

## Verification

The seeded grad trip is untouched — it replays the scripted path and never
enters the scenario generator; both golden assertions still pass.

A new check runs both judge scenarios at 14 rounds, 56 turns, and asserts zero
verbatim repeats — roughly four times the headroom the shipped five-round cap
needs. No ceiling figure appears in any generated public line.

All four suites green: offline-scenario 6/6, session-view 35/35, fairness
15/15, redaction 38/38.
