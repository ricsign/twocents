# PR #13 — fix: the offline fallback now argues about the actual topic

## The problem

With no API key the app runs on a scripted provider — deliberate, because a
demo must survive dead venue wifi. But the scripted lines were hard-coded to
the seeded grad trip, so the judges' round, where someone types their own
scenario, had four agents saying "Cancun, Mar 14–19, $1,180 a person" about a
dinner for four. That is the beat the demo closes on, and it only worked with
a key.

## The fix

`src/lib/llm/scenario.ts` is a deterministic scenario generator. It reads the
topic for a kind (trip / meal / night out / a generic fallback), holds a
couple of premium and budget templates per kind, and picks between them by
matching against what people actually typed.

Prices come from the room's real ceilings: the agreed option lands at about
70% of the lowest ceiling and the premium sits deliberately above it, so the
negotiation cannot quietly converge on the expensive one. Both are pushed
clear of every participant's proximity window using `proximityToleranceFor`
from the redactor itself — so a generated price can never drift into range of
somebody's secret.

Beats are generated from the state of the table rather than a round number:
the highest ceiling opens expensive, the lowest ceiling pushes back
qualitatively and later counters with the affordable option, someone trades
for their stated want, the rest agree.

The offline provider never generates a leak in the first place. The engine
still scans — but a fallback that relied on being redacted would look worse
on stage than one that speaks cleanly.

## The seeded run is untouched

Captured byte-for-byte before the change and asserted identical after: all
eight lines, both offers, the plan, the runner-up and the fairness rows. The
golden is frozen into the check file. The seed marker tests `tripName` only,
deliberately not a fingerprint over the briefs — the demo rewrites Richard's
brief live at 0:15, and a brief-based check would stop matching exactly when
the demo is most exposed.

## What it produces for a dinner

Four seats at $25 / $35 / $45 / $95, topic "Dinner tonight":

> **Will proposes** — The steakhouse on the corner. $75 a head, the one place
> worth putting a jacket on for.
> **Tsai pushes back** — That one's a stretch for me, and I'd rather not be
> the reason we don't go.
> **Richard counters** — The little trattoria off the main street. Around $18 a
> head, and we keep real vegetarian food and a proper bar.
> **Angela agrees** — A proper bar is in. Book it.

Agreed $18, under the lowest ceiling. No line contains 25, 35, 45 or 95. The
engine's guard caught zero leaks because there were none to catch. A "night
out" topic produces a genuinely different argument, so it isn't two hard-coded
scenarios wearing a switch.

## Edge cases verified

No ceilings at all; four identical ceilings; $6–12 budgets where no price is
sayable at all (the agents go qualitative rather than get redacted); a want
containing the speaker's own ceiling figure; an unrecognised topic; a
$400–$9,000 spread. All converge in two rounds with zero leaks.

## Known, documented

`keptWants` carries the honest minimum to clear the fairness threshold rather
than a padded list — padding would buy a greener meter by lying. The plan
header prints "1 nights" for a dinner; fixed separately.
