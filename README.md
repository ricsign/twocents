# Daily Pick

One S&P 500 stock per trading day. Each pick comes with a fixed plan, a check through nine lenses, and the backtest
of the same rules beside it.

**Not investment advice.** The rules show no statistically proven edge over SPY (see *Evidence* below).

## Rules (`engine/pick.py`, `RULES`)
| Step | Rule |
|---|---|
| Universe | Point-in-time S&P 500 members with at least 1 year of history, price ≥ $5 and 20-day dollar volume ≥ $50M |
| Market gate | Trend ensemble on SPY (200-day, 10-month, 12-month return, 3/12-month cross). No new buys below 50% |
| Qualify | Full uptrend (price above a rising 50d and 200d, 4/4) and top-half 6–12-month risk-adjusted momentum |
| Select | The deepest 5-session dip among qualifiers, skipping names already held |
| Live checks | **Earnings** (Nasdaq ∩ Yahoo; fail ≤ 3 sessions away, warn inside the hold)<br>**News** (Yahoo, Google News, SEC 8-K; fail on red flags)<br>**Analysts** (fail at Underperform/Sell)<br>**Data** (Yahoo close vs Nasdaq/Stooq; fail > 2% apart)<br>A fail skips to the next name |
| Trade | Buy at the next open with a limit of close + 0.25 ATR (no fill above it). Size each pick at 1/21 of the account. Sell at the close of the 21st session. No stop |

## Evidence (2003 → 2026, `docs/research/06_daily_pick_trials.md`)
| | Pick | SPY | Random member |
|---|---|---|---|
| Avg per 21-session trade | +0.94% | +0.71% | +0.68% |
| Holdout 2015–26 | +0.46% | +0.60% | +0.34% |
| 21-slot portfolio CAGR · max DD | 7.5% · −29% | 11.4% · −55% | 12.1% · −56% |

The t-stat vs SPY is 1.46, after 14 logged trials. The pre-registered first version lost to a random pick and was
withdrawn; the trial log records why and what changed. What the rules deliver is discipline: a liquid uptrending leader
bought on a dip, event risk screened out live, fixed size, a fixed exit date, and about half SPY's drawdown.

## Run
```
python -m engine.daily               # → docs/data/pick.json, docs/index.html, docs/picks/<date>.json
python -m engine.daily --offline     # stored history only, live checks n/a
python -m research.backtest_pick     # → docs/data/backtest_pick.json (weekly, after the history update)
python -m research.signal_study      # trial 2 signal study (dev 2003–14 → holdout 2015–26)
python -m research.backfill_history --update
python -m pytest -q
```

## Layout
- `engine/pick.py`: price lenses, rules, plan, trade simulation (shared by the backtest and the live record)
- `engine/daily.py`: orchestrator, with the live lenses and the record graded from prices
- `engine/news.py`: headlines from 3 sources, de-duplication, finance lexicon, red flags, SEC 8-K items
- `engine/rotation.py`: point-in-time history loader, eligibility, market gate
- `site/app.html`: single-file UI (data is injected by `engine/site.py`); `site/BRIEF.md` is the UI spec
- `.github/workflows/daily.yml`: 12:15 UTC weekdays. `history.yml`: Saturdays (prices plus backtest)
