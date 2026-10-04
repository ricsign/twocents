# UI brief — Daily Pick (v3)

**What it is:** a personal stock picker. The user's portfolio is empty. Each trading day, the app names one stock to buy
at the next open, with an exact plan (entry/limit, stop, target, exit date, size) — or says "Stand aside" when the market
gate is off. Every pick is checked through 9 independent lenses. 5 come from prices and are backtested; 4 are live checks:
earnings date, news/filings, analyst consensus, and a second-source price check.

**Reference style:** putfinder.com. It is dense and dark, with a single hero recommendation, a score ring, colored pass/warn/fail
pills, a ranked table, and almost no prose. Labels are 1–3 words. No paragraphs. Numbers and charts carry the meaning.

## Hard constraints
- One file: `site/app.html`. Inline CSS and JS only, no external scripts, and no fonts besides an optional Google Fonts `<link>`
  (Inter or similar, with a system fallback). All charts are hand-written SVG.
- Data: `window.PICK = /*__PICK_DATA__*/null;` (this exact token; `engine/site.py` replaces it). On load, also
  `fetch('data/pick.json', {cache:'no-store'})`. Use the result if its `meta.generated_at` is newer. If the embedded value is null
  and the fetch fails, show a clean error state.
- Must never crash on `null`/missing fields. Any value may be null; render "—". `pick` may be null, which shows the Stand-aside state.
  It still shows the regime, funnel and the candidates as a watchlist.
- Theme: dark by default, with a light theme toggle (remember it in localStorage inside try/catch). Use CSS variables on `:root`.
  `prefers-color-scheme` sets the initial value.
- Responsive: 1280px desktop down to 375px phone. There must be no horizontal page scroll; wide tables scroll inside their card.
- Accessible: color is never the only signal (pills carry ✓ / ! / ✕ glyphs), there are visible focus rings, contrast meets WCAG AA,
  and SVGs have `role="img"` with an aria-label.
- Fast: no layout jank. Keep it under ~120 KB of HTML/CSS/JS before data.

## Information architecture (tabs in a sticky top bar: Today · Shortlist · Record · Method)
Top bar: logo wordmark "Daily Pick". Next to it, the date chip "for Mon Oct 5" (meta.pick_for), the data timestamp, a regime
pill (Risk-on / Caution / Risk-off), and the theme toggle.

### Today
1. **Hero card**:
   - ticker (large), name, sector · industry, last close;
   - a **score ring** (0–100, coloured by conviction);
   - an "8/9 lenses" agreement meter (9 small segments);
   - a BUY badge with "at open Mon Oct 5".
2. **Plan strip** (the most important thing after the ticker). There are 6 tiles: Entry (limit ≤ x), Stop (−6.6%), Target (+13.2%),
   Exit by (date · 21 sessions), Size (5 sh · $1,323 at 1% risk of $10k), R:R 2.0. Add an editable account-size input that
   recomputes shares: shares = floor(account × 1% / risk_per_share), capped at 25% of the account.
3. **Price chart**: 126-session candlesticks plus SMA50 and SMA200, with volume bars underneath. Draw horizontal bands for entry, stop
   and target, projected to the right over the 21-session hold window (shaded zone, red below the stop, green toward the target).
   Show a crosshair tooltip on hover/touch (date, O/H/L/C, volume).
4. **Lens matrix**: 9 rows. Each row has: label, status pill, a mini bar of the lens score (0–1), value, and a muted detail. Group
   them as "Price · backtested" (5) and "Live checks" (4).
5. **Evidence row**, in a grid of 3–4 cards:
   - **Relative strength**: line chart, stock vs SPY rebased to 100 over 1y (`rs_line`).
   - **Base rate**: histogram of 21-session outcomes for past picks with a similar score (`base_rate.hist`). Mark 0, then show
     win %, average, median, stop-hit % and n.
   - **Analysts**: rating, a target-range bar (low–mean–high with the current price marker), and the upside.
   - **Earnings**: next date, session, days away, and a hold window bar showing whether the report falls inside the 21-session hold.
6. **News & filings**: headlines with a sentiment dot (green/grey/red), source, relative time, and a red-flag tag if one is present.
   Show the n_sources badge when a story was seen on more than one source. Below that, the 8-K filings with their item names.
7. **Market gate**: an exposure gauge (0–1), the 4 rule chips (on/off with values), a SPY 1y sparkline with its SMA200, VIX (and its
   percentile), and breadth >50d and >200d.
8. **Funnel**: horizontal funnel bars from S&P 500 → Pick, with counts.

### Shortlist
- A table of `candidates`: rank, ticker+name, score bar, a 9-dot lens strip (hover shows the lens value), 6m return, 1y
  volatility, RSI, earnings in N sessions, and a 63-day sparkline.
- Blocked rows are dimmed with a "Blocked: Earnings" tag. Rows are sortable by column. Clicking a row expands its lens values inline.
- Sector strength: horizontal bars of `market.sectors` (rs vs SPY over 3m), each with a sparkline.
- Earnings this week: chips.

### Record
- Live record summary tiles: picks, open, closed, win %, average vs SPY, excess.
- A table of `record.picks`: date, ticker, status pill (pending/open/closed/stand_aside), return, SPY, excess, days, and exit reason.
  Show an empty-state message if there are no picks.
- `record.recent_sim`: "Last 3 months · simulated (same rules)". Show it as a compact strip of colored bars per day (return).
  It must be clearly labelled as simulated.

### Method (backtest; `backtest` object; may be null)
- KPI tiles: trades n, win %, avg per trade vs SPY vs random, t-stat (HAC), and portfolio CAGR / max drawdown vs SPY.
- An equity curve (log scale) with these lines: pick (21-slot portfolio), top10, equal_weight, spy. Include a legend toggle.
- A per-trade return histogram comparing pick vs SPY (overlaid).
- A by-year bar chart of pick vs SPY (`by_year.port` vs `spy_year`).
- A by-score table. Show variants (no_stop, target_2r, ungated, top10, random) as a compact comparison table.
- The rules in one line, plus the caveats as a short list in small type. Add a link to the
  pre-registration (`research/05_daily_pick_prereg.md` lives in the repo; just show the text "Pre-registered 3 Oct 2026").
- A "Sources" list (meta.sources with ok/n) and warnings.

## Formatting
- Percentages: +12.3% / −4.1%. Use a real minus sign, show the sign for returns, and apply green/red.
- Prices: $1,234.56. Use tabular numerals for numeric columns.
- Show dates as "Mon Oct 5"; relative times look like "3h ago".
- Score colors: ≥85 strong (green/teal), 70–85 medium (amber), <70 (grey).

## Files
- Data shape: open `site/sample_pick.json` (a realistic sample). Every key used must come from it. (The sample is the contract.)
- Preview: `python -c "import json; from engine import site; site.build(json.load(open('site/sample_pick.json')), out=__import__('pathlib').Path('/tmp/preview.html'))"`
  then use Playwright (Chromium is preinstalled at /opt/pw-browsers; do not run `playwright install`). Take screenshots at
  1280×900 and 390×844, in both themes, and check them visually with the Read tool. Also test with `pick` set to null and with
  `backtest` set to null.
