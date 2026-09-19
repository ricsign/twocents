# PR #4 — feat: the secret guard and the fairness score

## Summary

Two pure modules that carry the product's two claims. `redaction.ts` enforces
"your agent will never say your number". `fairness.ts` backs up "nobody was
overruled" with something computed rather than asserted.

## `redaction.ts`

`checkForLeaks(text, secrets)` inspects a line before it is spoken in public.

For a secret of 600 it catches the literal forms (`$600`, `600 dollars`,
`600usd`, `six hundred`, `six-hundred`), thousands separators for larger
secrets (`1,180` and `1180` both match 1180), and — the rule that actually
matters — **proximity**: any bare number within `max(5, 2%)` of the secret.
An agent that says "I can do up to 605" has given the number away just as
completely as one that says 600.

Equally important is what it does *not* match: `1600`, `6000`, `600th`,
`2600` and `Mar 14-19` are left alone. Over-matching would reject every line
an agent generates, which fails worse and less visibly than a leak.

`leakInstruction()` produces the corrective prompt fed back to the model on a
retry, assembled from fixed clauses only — **it never restates the value it is
protecting**, because that instruction goes back into a model context.

## `fairness.ts`

`scoreFairness()` walks each person's stated wants and decides which the plan
honoured. Matching is normalized and token-based, but constraint wants get a
real comparison rather than substring matching: a want of "no flights before
8am" is parsed into an acceptable interval, and a plan's "nothing leaves
before 11am" is read as a region that sits inside it (kept) while "6am flight"
is read as a point outside it (violated). Clock times and plain quantities are
never compared to each other.

A budget ceiling is treated as an implicit want. `nobodyOverruled` requires
every person at 60% or better *and* no ceiling breached — 60% being "at most
one concession out of three or five; below that you were outvoted, not traded
with". `gaveUp` names the single most significant unmet want, never with a
figure in it.

## Tests

`src/lib/negotiation/__tests__/*.check.ts` are runnable assertion scripts
(no test runner added). **38/38** redaction and **15/15** fairness passing,
including the full no-match set, proximity catching `605` and `$597` while
leaving the agreed `$540` sayable, and an assertion that `leakInstruction`
itself survives `checkForLeaks` against the secret it protects.
