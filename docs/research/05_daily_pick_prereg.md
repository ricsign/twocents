# Daily pick — pre-registration (filed 3 Oct 2026, before the first backtest of these rules)

## Rules (engine/pick.py)
- Universe: point-in-time S&P 500 members, ≥1y history, price ≥ $5, 20-day dollar volume ≥ $50M.
- Hard filters: trend ≥ 3/4; 1y volatility ≤ 95th pct of pool; extension ≤ 4 ATR above 21d EMA; RSI(14) ≤ 85.
- Score = 100 × quality × fit; quality = 0.6·momentum pct + 0.2·trend/4 + 0.2·3m relative-strength pct; fit = 0.5 + 0.5·(0.5·risk + 0.5·timing).
- Market gate: trend-ensemble exposure < 0.5 → no pick.
- Pick = highest score. Entry next open. Stop = entry − 2·ATR(14). Exit at the close of the 21st session. Costs 10 bps per side.
- Live-only gates (not backtestable): earnings ≤ 3 sessions away (fail), news red flags (fail), consensus Underperform/Sell (fail), Yahoo–Nasdaq close disagreement > 2% (fail).

## Sample
2003-01-02 → data end, one pick per trading day (overlapping 21-session trades), reported as (a) per-trade distribution and (b) a 21-slot staggered portfolio (1/21 of capital per day's pick).

## Comparisons (reported whatever they show)
SPY over the same open→close windows; a random eligible member (mean of all eligible names that day, same 21-session window, no stop); the top-10 average; the pick without the stop; the pick with the 2R target.

## Decision rule
The rules above are shipped as-is regardless of result; the app shows the backtest beside every pick, including if the pick lags SPY. Any later change is a new logged trial in trial_log.md.
