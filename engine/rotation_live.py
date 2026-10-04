"""Live rotation model: replay the frozen rules over the full history up to the last close and
turn the end state into today's portfolio, orders and the model's own live record.

Why replay instead of keeping a state file: the rank-buffer rule makes holdings path-dependent,
so the only way to be sure the live book matches the backtested rules is to run the same
simulation to today. It takes ~10 s. Everything after `go_live` is out-of-sample by construction.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
from pathlib import Path

import numpy as np
import pandas as pd

from . import rotation as R
from research import backtest_rotation as B

ROOT = Path(__file__).resolve().parent.parent
HIST_DIR = ROOT / "data" / "history"
SPEC_FILE = ROOT / "strategy_spec.json"
log = logging.getLogger(__name__)


def load_spec() -> dict:
    """strategy_spec.json holds the frozen overrides plus `go_live` (the first out-of-sample day)."""
    if SPEC_FILE.exists():
        raw = json.loads(SPEC_FILE.read_text())
        go_live = raw.pop("go_live", None)
        spec = R.make_spec(**{k: v for k, v in raw.items() if k in R.DEFAULT_SPEC})
        if go_live:
            spec["go_live"] = go_live
        return spec
    return R.make_spec()


def extend_history(hist: R.History, fresh: dict[str, pd.DataFrame], bench_fresh: dict[str, pd.DataFrame] | None = None) -> R.History:
    """Chain recent bars (from today's yfinance pull, auto_adjust=False) onto the stored history.

    Adjusted levels from two downloads on different days are not comparable (Yahoo back-adjusts),
    so we chain *returns* from the fresh bars onto the last stored adjusted close."""
    last = hist.dates[-1]
    new_dates = set()
    for t, df in fresh.items():
        d = df[df.index > last]
        if not d.empty:
            new_dates |= set(d.index)
    if bench_fresh:
        for t, df in bench_fresh.items():
            d = df[df.index > last]
            new_dates |= set(d.index)
    if not new_dates:
        return hist
    new_idx = pd.DatetimeIndex(sorted(new_dates))
    all_idx = hist.dates.append(new_idx)

    def ext(frame: pd.DataFrame, fill_from: str):
        out = frame.reindex(all_idx)
        return out

    adj, close, opn, vol = ext(hist.adj_close, "adj"), ext(hist.close, "close"), ext(hist.open_adj, "open"), ext(hist.volume, "vol")
    hi = ext(hist.high, "high") if hist.high is not None else None
    lo = ext(hist.low, "low") if hist.low is not None else None
    if hist.spells is not None:
        member = R.membership_mask(hist.spells, all_idx, list(adj.columns))  # picks up removals dated inside the gap
    else:
        member = hist.member.reindex(all_idx).ffill().fillna(False).astype(bool)
    for t, df in fresh.items():
        if t not in adj.columns:
            continue
        d = df[df.index > last]
        if d.empty:
            continue
        base = hist.adj_close[t].dropna()
        if base.empty:
            continue
        last_adj = float(base.iloc[-1])
        last_dt = base.index[-1]
        src = df[df.index >= last_dt]
        if src.empty or src.index[0] != last_dt:
            # no overlap with the stored series: bridge the gap on RAW closes (comparable across pulls), then chain
            src = df[df.index > last_dt]
            if src.empty:
                continue
            prev_close = float(hist.close[t].loc[last_dt]) if pd.notna(hist.close[t].loc[last_dt]) else np.nan
            gap = float(src["Close"].iloc[0]) / prev_close if prev_close and np.isfinite(prev_close) else 1.0
            if not (0.2 < gap < 5.0):  # a split inside the gap cannot be resolved without an overlap
                log.warning("%s: %.2fx move across an unbridged gap %s -> %s; treated as a split, return set to 0", t, gap, last_dt.date(), src.index[0].date())
                gap = 1.0
            else:
                log.warning("%s: no overlap with stored history; bridged %s -> %s on raw close (%.2f%%)", t, last_dt.date(), src.index[0].date(), (gap - 1) * 100)
            chain = last_adj * gap * (src["Adj Close"] / float(src["Adj Close"].iloc[0]))
        else:
            rets = src["Adj Close"].pct_change().iloc[1:]
            chain = last_adj * (1 + rets).cumprod()
        adj.loc[chain.index, t] = chain.values
        close.loc[d.index, t] = d["Close"].values
        # adjusted open = raw open x (adj / raw close) of the same day
        factor = adj.loc[d.index, t] / d["Close"]
        opn.loc[d.index, t] = (d["Open"] * factor).values
        vol.loc[d.index, t] = d["Volume"].values
        if hi is not None:
            hi.loc[d.index, t] = (d["High"] * factor).values
            lo.loc[d.index, t] = (d["Low"] * factor).values
    opn = R.clean_open(opn, adj)
    if hi is not None:
        ok = adj.notna()
        hi = hi.where(ok).combine(adj, np.fmax).combine(opn, np.fmax).where(ok)
        lo = lo.where(ok).combine(adj, np.fmin).combine(opn, np.fmin).where(ok)
    bench = dict(hist.bench)
    if bench_fresh:
        for t, df in bench_fresh.items():
            base = bench.get(t)
            d = df[df.index > (base.index[-1] if base is not None and len(base) else pd.Timestamp("1900-01-01"))]
            if d.empty:
                continue
            if base is None or base.empty:
                bench[t] = df["Adj Close"]
                continue
            src = df[df.index >= base.index[-1]]
            if len(src) and src.index[0] == base.index[-1]:
                rets = src["Adj Close"].pct_change().iloc[1:]
                chain = float(base.iloc[-1]) * (1 + rets).cumprod()
            else:
                # no overlap: bridge on the raw close ratio (benchmarks are rarely split-adjusted inside a week)
                bridge = float(d["Close"].iloc[0]) / float(df["Close"].reindex([base.index[-1]]).iloc[0]) if base.index[-1] in df.index else 1.0
                if not (0.5 < bridge < 2.0):
                    bridge = 1.0
                log.warning("%s: benchmark gap %s -> %s bridged at %.2f%%", t, base.index[-1].date(), d.index[0].date(), (bridge - 1) * 100)
                chain = float(base.iloc[-1]) * bridge * (d["Adj Close"] / float(d["Adj Close"].iloc[0]))
            bench[t] = pd.concat([base, chain])
    return R.History(adj_close=adj, close=close, open_adj=opn, volume=vol, member=member, bench=bench, spells=hist.spells, high=hi, low=lo)


def next_rebalance_date(dates: pd.DatetimeIndex, spec: dict, today: dt.date) -> tuple[bool, str]:
    """(is the last completed session a rebalance signal day?, date of the next signal day)
    The next signal day is the last *trading* session of the next period, per the exchange calendar."""
    from . import calendar_events as cal
    sig = R.rebalance_dates(dates, spec["rebalance"]["freq"])
    last = dates[-1]
    is_sig = last in sig
    freq = spec["rebalance"]["freq"]
    d = last.date()
    if freq == "M":
        end_next = (pd.Timestamp(d) + pd.offsets.MonthEnd(1 if is_sig else 0)).date()
    elif freq == "Q":
        end_next = (pd.Timestamp(d) + pd.offsets.QuarterEnd(1 if is_sig else 0, startingMonth=3)).date()
    else:
        end_next = (pd.Timestamp(d) + pd.offsets.Week(weekday=4)).date()
    nxt = end_next
    while not cal.is_trading_day(nxt):
        nxt -= dt.timedelta(days=1)
    return bool(is_sig), nxt.isoformat()


def build(hist: R.History, spec: dict, meta: dict, go_live: str | None = None, equity: float = 100_000.0) -> dict:
    """Run the rules to the last close and describe the resulting book and today's orders."""
    go_live = go_live or spec.get("go_live") or "2026-09-03"
    if spec["rebalance"].get("tranches", 1) != 1:
        raise ValueError("the live model runs a single tranche; set rebalance.tranches = 1 in strategy_spec.json")
    rf = B._rf_daily(hist)
    scores = R.compute_scores(hist, spec, rf_daily=rf)
    spy_px = hist.bench.get("SPY", hist.bench.get("^GSPC"))
    exposure = R.exposure_series(spy_px, spec).reindex(hist.dates).ffill().fillna(1.0)
    res = B.simulate(hist, spec, scores=scores, exposure=exposure, start="2000-01-03", sample=True)
    dates = hist.dates
    last = dates[-1]
    sig_dates = list(res.holdings.keys())
    last_sig = sig_dates[-1]
    holdings = res.holdings[last_sig]
    weights = res.weights_log.get(last_sig, {})
    # the book that is actually held now: the last executed target (if the last signal was yesterday's close,
    # the orders are for the next open and the current book is the previous target)
    is_sig_day = last_sig == last
    prev_sig = sig_dates[-2] if len(sig_dates) > 1 else last_sig
    current = res.holdings[prev_sig] if is_sig_day else holdings
    current_w = res.weights_log.get(prev_sig, {}) if is_sig_day else weights

    # ranks and scores today
    srow = scores.iloc[-1].dropna().sort_values(ascending=False)
    ranks = pd.Series(np.arange(1, len(srow) + 1), index=srow.index)
    n, buf = spec["portfolio"]["n"], spec["portfolio"]["buffer"]
    rules = R.trend_rules(spy_px.dropna(), spec).iloc[-1]
    ex_today = float(exposure.iloc[-1])
    adj = hist.adj_close

    def ret_since(t, d0):
        """Return from the fill (open of the session after the signal date) to the last close."""
        try:
            pos = dates.get_loc(d0)
            fill = float(hist.open_adj[t].iloc[pos + 1]) if pos + 1 < len(dates) else float(adj[t].iloc[pos])
            return float(adj[t].loc[last] / fill - 1)
        except Exception:
            return None

    # entry dates: walk back through the holdings log from the last signal where the name was held
    entry = {}
    for t in set(current) | set(holdings):
        d_entry = None
        start_idx = len(sig_dates) - 1 if t in holdings else len(sig_dates) - 2
        for d in reversed(sig_dates[:start_idx + 1]):
            if t in res.holdings[d]:
                d_entry = d
            else:
                break
        entry[t] = d_entry

    rows = []
    for t in sorted(set(current) | set(holdings), key=lambda x: ranks.get(x, 9999)):
        rk = int(ranks[t]) if t in ranks.index else None
        in_now, in_next = t in current, t in holdings
        if in_now and in_next:
            status = "hold" if (rk is not None and rk <= n) else "hold (buffer)"
        elif in_now and not in_next:
            status = "sell"
        else:
            status = "buy"
        rows.append({"ticker": t, "rank": rk, "score": round(float(srow.get(t, np.nan)), 3) if t in srow.index else None,
                     "weight": round(float(weights.get(t, 0.0)), 4), "weight_now": round(float(current_w.get(t, 0.0)), 4),
                     "status": status, "entry_date": str(entry[t].date()) if entry.get(t) is not None else None,
                     "ret_since_entry": ret_since(t, entry[t]) if entry.get(t) is not None else None,
                     "close": float(hist.close[t].iloc[-1]) if pd.notna(hist.close[t].iloc[-1]) else None,
                     "vol_1y": float(R.realised_vol(adj[[t]], spec["signal"]["vol_window"]).iloc[-1, 0]) if t in adj else None,
                     "member": bool(hist.member[t].iloc[-1])})
    # orders for the next open (only meaningful on a signal day)
    orders = []
    if is_sig_day:
        for r in rows:
            if r["status"] == "sell":
                reason = "left the index" if not r["member"] else ("no longer eligible" if r["rank"] is None else (f"rank {r['rank']} > buffer {buf}" if r["rank"] > buf else "replaced"))
                orders.append({"side": "SELL", "ticker": r["ticker"], "reason": reason, "weight_from": r["weight_now"], "weight_to": 0.0})
            elif r["status"] == "buy":
                orders.append({"side": "BUY", "ticker": r["ticker"], "reason": f"rank {r['rank']} of {len(ranks)}", "weight_from": 0.0, "weight_to": r["weight"]})
            else:
                diff = r["weight"] - r["weight_now"]
                if abs(diff) >= 0.01:
                    orders.append({"side": "TRIM" if diff < 0 else "ADD", "ticker": r["ticker"], "reason": "rebalance to target", "weight_from": r["weight_now"], "weight_to": r["weight"]})
        for o in orders:
            o["dollars"] = round((o["weight_to"] - o["weight_from"]) * equity)
    candidates = [{"ticker": t, "rank": int(ranks[t]), "score": round(float(srow[t]), 3), "in_book": t in current} for t in srow.index[:max(buf, 60)]]

    # the model's own live record (after go_live) and a recent window before it
    daily = res.daily
    spy_r = B.benchmark_series(hist, "SPY" if "SPY" in hist.bench else "^GSPC").reindex(daily.index).fillna(0)
    live = daily.loc[go_live:]
    live_spy = spy_r.loc[go_live:]
    live_curve = [{"date": str(d.date()), "model": round(float(x), 4), "spy": round(float(y), 4)} for (d, x), y in zip((1 + live).cumprod().items(), (1 + live_spy).cumprod().values)]
    recent = daily.loc[str((last - pd.DateOffset(years=1)).date()):]
    recent_spy = spy_r.reindex(recent.index).fillna(0)
    is_sig, nxt = next_rebalance_date(dates, spec, dt.date.today())
    return {
        "spec": spec, "as_of": str(last.date()), "go_live": go_live,
        "is_rebalance_day": bool(is_sig_day), "last_rebalance_signal": str(last_sig.date()), "next_rebalance_signal": nxt,
        "n_eligible": int(len(srow)), "n": n, "buffer": buf,
        "exposure": {"value": ex_today, "rules": {k: bool(v) for k, v in rules.items()},
                     "panic": bool(ex_today < R.exposure_series(spy_px, R.make_spec(**{**spec, "regime": {**spec["regime"], "panic_halve": False}})).iloc[-1]),
                     "history": [{"date": str(d.date()), "exposure": float(x)} for d, x in res.exposure.iloc[-36:].items()]},
        "book": rows, "orders": orders, "candidates": candidates,
        "equity_assumed": equity,
        "live": {"curve": live_curve, "days": int(len(live)), "model_return": float((1 + live).prod() - 1) if len(live) else 0.0, "spy_return": float((1 + live_spy).prod() - 1) if len(live_spy) else 0.0},
        "recent_12m": {"model": float((1 + recent).prod() - 1), "spy": float((1 + recent_spy).prod() - 1),
                        "curve": [{"date": str(d.date()), "model": round(float(x), 4), "spy": round(float(y), 4)} for (d, x), y in zip((1 + recent).cumprod().resample("W-FRI").last().items(), (1 + recent_spy).cumprod().resample("W-FRI").last().values)]},
        "turnover_12m": float(res.turnover.loc[str((last - pd.DateOffset(years=1)).date()):].sum()) if len(res.turnover) else 0.0,
    }
