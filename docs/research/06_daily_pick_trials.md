# Daily pick — trial log and verdict (3 Oct 2026)

Sample: point-in-time S&P 500, 2003-01-02 → 2026-10-02, one pick per day, entry at the next open, 21-session hold,
10 bps per side, no new buys when the trend gate is below 50%. Per-trade numbers are averages of overlapping 21-session
trades; t-stats are Newey–West (lag 21). "Random" = the equal-weighted eligible pool over the same window.

## Trial 1 — pre-registered composite (doc 05): rejected
| # | Variant | Avg / trade | SPY | Random | t vs SPY | t vs random | CAGR (21-slot) | Max DD |
|---|---|---|---|---|---|---|---|---|
| 1 | Composite · 2×ATR stop (pre-registered) | +0.09% | +0.70% | +0.67% | −3.22 | −2.77 | 0.3% | −29% |
| 2 | Composite · no stop | +0.45% | +0.70% | +0.67% | −1.16 | −0.98 | 3.4% | −54% |
| 3 | Composite · 2×ATR · one position per name | +0.43% | +0.70% | +0.67% | −1.90 | −1.42 | 4.1% | −13% |
| 4 | Composite · no stop · one per name | +0.71% | +0.70% | +0.67% | +0.07 | +0.28 | 6.7% | −35% |

Two design errors explain most of the shortfall.

The first is the stop. A 2×ATR stop sits inside 21-session noise. By the reflection principle, about 55% of
trades touch it, and 53% actually did. That turns ordinary wiggles into realised losses.

The second is repeat picks. The same name was often picked several days in a row, which concentrated the book.
The decision rule in doc 05 said "ship as-is", but trial 1 loses to a random member at t = −2.8. So it was
withdrawn, and every change below is logged.

## Trial 2 — signal study (selection fixed before running)
These are seven textbook signals with no tuned parameters. They were ranked on 2003–2014. The winner was chosen by the
best top-10 t-stat versus random, and the 2015–2026 holdout was then reported as-is.

| Signal | Dev top-1 excess vs random | t | Holdout top-1 excess | t |
|---|---|---|---|---|
| composite (trial 1) | −0.26% | −0.85 | −0.35% | −1.02 |
| ram (risk-adj. momentum) | −0.13% | −0.27 | +0.63% | +0.95 |
| resid_mom (Blitz et al.) | −0.52% | −1.10 | +0.82% | +1.52 |
| high52 (George–Hwang) | −0.15% | −0.57 | −0.19% | −0.85 |
| **pullback** (deepest 5-day dip, top-half momentum, 4/4 trend) | **+0.43%** | **+1.62** | −0.24% | −0.74 |
| low_vol | −0.13% | −0.42 | −0.89% | −2.50 |
| reversal (1-month) | −0.05% | −0.05 | +0.96% | +1.29 |

Pullback was chosen on the development period, as the rule required, and it did not hold up in the holdout. The
stop decision was also made on the development period only. With no stop the average was +1.19% per trade; with a
2×ATR stop it was +0.58%. So the stop was dropped.

## Trial 3 — execution realism (#14, shipped whatever the result)
The plan tells the user to buy with a limit at close + 0.25 ATR. The backtest now enforces that limit. On 1,229 signal days (about 21%)
the open gapped above the limit, so there was no fill and that slot stayed in cash. This rule was
added for realism, not for performance, and it ships either way.

## Shipped rules (engine/pick.py `RULES`)
- **Signal:** the deepest 5-session dip among names with top-half momentum and a full 4/4 uptrend.
- **Execution:** buy at the next open with a limit of close + 0.25 ATR, then sell at the close of the 21st session. There is no stop, and a name already held is never picked again.
- **Sizing:** each pick gets 1/21 of the account.
- **Live gates** (earnings, news, analysts, data check) can only veto a pick; they never reorder candidates.

| | Pick | SPY | Random |
|---|---|---|---|
| Avg / trade, 2003–26 (n 3,987) | +0.94% | +0.71% | +0.68% |
| Development 2003–14 | +1.44% | +0.81% | +1.02% |
| Holdout 2015–26 | +0.46% | +0.60% | +0.34% |
| t vs SPY / random | 1.46 / 1.62 | | |
| 21-slot portfolio CAGR · max DD · Sharpe | 7.5% · −29% · 0.59 | 11.4% · −55% · 0.68 | 12.1% · −56% · 0.66 |

## Placebo check
The same backtest with a random score among eligible names averages +0.67% per trade. A random member over the same windows also averages +0.67% (t = −0.06). So the machinery adds no bias of its own: no look-ahead, and entry and exit costs are counted.

## Verdict
None of the 14 configurations tried shows a statistically reliable edge over SPY or over a random S&P 500 member.
The best result (t ≈ 1.5) is what 14 tries at zero true edge would produce. This agrees with the earlier rotation-model study:
in large caps, price-only signals have not beaten the index since about 2009.

What the shipped rules do deliver is a disciplined process: a liquid uptrending leader bought on a dip, with event
risk screened out live, fixed sizing, a fixed exit date, and about half SPY's drawdown, because of the gate. The app
states this on the Method tab. Any future change is trial 3+ and gets logged here.
