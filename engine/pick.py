"""Daily pick — one stock per day, scored through independent lenses.

Price lenses (computed for every stock, every day — so they are backtested point-in-time):
    momentum   risk-adjusted 6m+12m momentum (the rotation signal), percentile in the eligible pool
    trend      close > 50d, close > 200d, 50d > 200d, 200d rising             (count of 4)
    strength   63-session return vs SPY, percentile in the pool
    risk       1-year volatility percentile (lottery-ticket filter)
    timing     extension above the 21-day EMA in ATRs + RSI(14)             (don't chase)
Live lenses (current snapshot only — gates, not backtested):
    earnings   next report date (Nasdaq calendar ∩ Yahoo)
    news       headline tone + red-flag terms (Yahoo, Google News, SEC 8-K items)
    analysts   consensus rating and mean target (Yahoo)
    data       last close: Yahoo vs Nasdaq

score = 100 × quality × fit × gates
    quality = 0.6·momentum + 0.2·trend + 0.2·strength          (what to own)
    fit     = 0.5 + 0.5·(0.5·risk + 0.5·timing)                (whether today is a sane entry)
    gates   = product of live-lens multipliers (1 = clean; a hard fail removes the stock)
Market gate: equity exposure from the four-rule trend ensemble. Below 0.5 → no pick ("stand aside").

Trade plan (fixed before any backtest was run; see docs/research/05_daily_pick_prereg.md):
    buy at the next open (limit: last close + 0.25 ATR), stop = entry − 2 ATR(14),
    reference target = entry + 2R, time exit after 21 sessions.   [trial 1]
Trial 2 (current, docs/research/trial_log.md): signal = deepest 5-session dip among top-half momentum names in a full
uptrend; no stop; one name at a time (skip names already held); 1/21 of the account per pick; sell at the 21st close.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from . import rotation as R

HORIZON = 21
STOP_ATR = 2.0
TARGET_R = 2.0
LIMIT_ATR = 0.25
MIN_DOLLAR_VOL = 50e6
RULES = {"stop_atr": None, "skip_held": True}   # trial 2 (trial 1 was stop_atr=2.0, skip_held=False). See docs/research/trial_log.md
POOL = 40                     # names scored in full each day (top momentum)
LENS_ORDER = ["momentum", "trend", "strength", "risk", "timing", "earnings", "news", "analysts", "data"]
LENS_LABEL = {"momentum": "Momentum", "trend": "Trend", "strength": "Rel. strength", "risk": "Volatility", "timing": "Pullback",
              "earnings": "Earnings", "news": "News", "analysts": "Analysts", "data": "Data check"}


# --------------------------------------------------------------------------- panels
def atr_panel(hist: R.History, n: int = 14) -> pd.DataFrame:
    c = hist.adj_close
    prev = c.shift(1)
    tr = pd.concat([(hist.high - hist.low), (hist.high - prev).abs(), (hist.low - prev).abs()]).groupby(level=0).max()
    tr = tr.reindex(c.index)
    return tr.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()


def rsi_panel(c: pd.DataFrame, n: int = 14) -> pd.DataFrame:
    d = c.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    rs = up / dn.replace(0, np.nan)
    return (100 - 100 / (1 + rs)).where(dn != 0, 100.0)


def _pct(x: pd.DataFrame, mask: pd.DataFrame) -> pd.DataFrame:
    return x.where(mask).rank(axis=1, pct=True)


def panels(hist: R.History, spec: dict | None = None) -> dict[str, pd.DataFrame]:
    """Every price lens as a dates × tickers panel (only past data at each row)."""
    spec = spec or R.make_spec()
    c = hist.adj_close
    rf = None
    elig = R.eligibility(hist, spec)
    dvol = (hist.close * hist.volume).rolling(20, min_periods=15).mean()
    elig = elig & (dvol >= MIN_DOLLAR_VOL)
    ram = R.compute_scores(hist, spec, rf_daily=rf).where(elig)
    sma50 = c.rolling(50, min_periods=40).mean()
    sma200 = c.rolling(200, min_periods=160).mean()
    rising = sma200 > sma200.shift(21)
    trend = ((c > sma50).astype(float) + (c > sma200).astype(float) + (sma50 > sma200).astype(float) + rising.astype(float)).where(elig)
    spy = hist.bench.get("SPY", hist.bench.get("^GSPC")).reindex(c.index).ffill()
    rel63 = (c / c.shift(63) - 1).sub(spy / spy.shift(63) - 1, axis=0)
    vol = np.log(c).diff().rolling(252, min_periods=200).std() * math.sqrt(252)
    atr = atr_panel(hist)
    ema21 = c.ewm(span=21, adjust=False, min_periods=15).mean()
    ext_atr = (c - ema21) / atr
    rsi = rsi_panel(c)
    mom_pct = _pct(ram, elig)
    str_pct = _pct(rel63, elig)
    vol_pct = _pct(vol, elig)
    risk = (1 - ((vol_pct - 0.5).clip(lower=0) * 2)).clip(0, 1)
    timing = (1 - ((ext_atr - 1.5).clip(lower=0) / 2.5)).clip(0, 1) * np.where(rsi > 80, 0.6, 1.0)
    quality = 0.6 * mom_pct + 0.2 * (trend / 4) + 0.2 * str_pct
    fit = 0.5 + 0.5 * (0.5 * risk + 0.5 * timing)
    # hard filters for the price-only pick: uptrend (≥3 of 4), not a lottery ticket, not wildly extended
    composite = (100 * quality * fit).where(elig & (trend >= 3) & (vol_pct <= 0.95) & (ext_atr <= 4.0) & (rsi <= 85) & atr.notna())  # trial 1
    # trial 2 signal ("leader on sale"): top-half momentum, full uptrend, ranked by the deepest 5-session dip
    ret5 = c / c.shift(5) - 1
    tradable = elig & (trend == 4) & (mom_pct >= 0.5) & atr.notna() & ret5.notna()
    score = (100 * (-ret5).where(tradable).rank(axis=1, pct=True)).where(tradable)
    return {"elig": elig, "ram": ram, "mom_pct": mom_pct, "trend": trend, "rel63": rel63, "str_pct": str_pct, "vol": vol,
            "vol_pct": vol_pct, "risk": risk, "atr": atr, "ext_atr": ext_atr, "rsi": rsi, "timing": timing, "sma50": sma50,
            "sma200": sma200, "quality": quality, "fit": fit, "tradable": tradable, "score": score, "dvol": dvol,
            "composite": composite, "ret5": ret5}


# --------------------------------------------------------------------------- price-lens statuses
def price_lenses(P: dict, i: int, t: str, pool_n: int, rank: int, sector_rank: str | None = None) -> list[dict]:
    """Five price checks. Momentum ≥ 50th pct and trend 4/4 are hard requirements of the signal; the others inform."""
    g = lambda k: P[k].iloc[i][t]
    out = []
    mp = g("mom_pct")
    out.append({"key": "momentum", "status": "pass" if mp >= 0.75 else "warn" if mp >= 0.5 else "fail", "score": _r(mp),
                "value": f"top {max(1, round((1 - mp) * 100))}%", "detail": f"6–12m, risk-adjusted · #{rank} of {pool_n}"})
    tr = int(g("trend"))
    out.append({"key": "trend", "status": "pass" if tr == 4 else "warn" if tr == 3 else "fail", "score": _r(tr / 4),
                "value": f"{tr}/4", "detail": "above 50d & 200d, both rising" if tr == 4 else "partial uptrend"})
    rel = g("rel63")
    sp = g("str_pct")
    out.append({"key": "strength", "status": "pass" if sp >= 0.6 else "warn" if sp >= 0.4 else "fail", "score": _r(sp),
                "value": f"{rel * 100:+.0f}% vs SPY".replace("-", "−"), "detail": "3 months" + (f" · sector #{sector_rank}" if sector_rank else "")})
    vp, v = g("vol_pct"), g("vol")
    out.append({"key": "risk", "status": "pass" if vp <= 0.8 else "warn" if vp <= 0.95 else "fail", "score": _r(g("risk")),
                "value": f"vol {v * 100:.0f}%", "detail": f"calmer than {100 - vp * 100:.0f}% of pool" if vp <= 0.5 else f"wilder than {vp * 100:.0f}% of pool"})
    r5, rsi = g("ret5"), g("rsi")
    st = "pass" if r5 < 0 else "warn"
    out.append({"key": "timing", "status": st, "score": _r(min(1.0, max(0.0, -r5 / 0.08))), "value": f"{r5 * 100:+.1f}% 5d".replace("-", "−"),
                "detail": f"dip #{rank_dip(P, i, t)} · RSI {rsi:.0f}"})
    return out


def rank_dip(P: dict, i: int, t: str) -> int:
    s = P["score"].iloc[i].dropna()
    return int((s > s.get(t, -1)).sum() + 1)


def _r(x, nd=3):
    try:
        if x is None or (isinstance(x, float) and math.isnan(x)):
            return None
        return round(float(x), nd)
    except Exception:
        return None


# --------------------------------------------------------------------------- live-lens gates
def gate_multiplier(lenses: list[dict]) -> tuple[float, str | None]:
    """Product of live-lens multipliers; returns (multiplier, first hard-fail label)."""
    mult, blocked = 1.0, None
    table = {"pass": 1.0, "warn": 0.93, "fail": 0.0, "na": 0.97}
    for L in lenses:
        if L["key"] not in ("earnings", "news", "analysts", "data"):
            continue
        m = table.get(L["status"], 1.0)
        mult *= m
        if m == 0 and blocked is None:
            blocked = LENS_LABEL[L["key"]]
    return mult, blocked


def plan(close: float, atr: float, last_date: pd.Timestamp, sessions_ahead: list, account: float = 10_000, base: dict | None = None) -> dict:
    """Equal-slot plan (exactly what the backtest does): each day's pick gets 1/21 of the account, bought at the next
    open, sold at the close of the 21st session. No stop (trial 2). The range is the 10th/50th/90th percentile of past
    picks' 21-session outcomes, as price levels."""
    entry = close
    slot = account / HORIZON
    shares = int(slot // entry) if entry > 0 else 0
    rng = {}
    if base:
        for k in ("p10", "median", "p90"):
            if base.get(k) is not None:
                rng[k] = _r(entry * (1 + base[k]), 2)
                rng[k + "_pct"] = base[k]
    return {"entry": _r(entry, 2), "limit": _r(entry + LIMIT_ATR * atr, 2), "stop": None, "target": None,
            "horizon_sessions": HORIZON, "exit_by": str(sessions_ahead[HORIZON - 1]) if len(sessions_ahead) >= HORIZON else None,
            "atr": _r(atr, 2), "atr_pct": _r(atr / entry, 4) if entry else None, "range": rng or None,
            "size": {"account": account, "slots": HORIZON, "slot_value": _r(slot, 0), "shares": shares, "value": _r(shares * entry, 0)}}


# --------------------------------------------------------------------------- trade simulation (shared by backtest + record)
def simulate_trade(o: np.ndarray, h: np.ndarray, l: np.ndarray, c: np.ndarray, start: int, stop_atr: float, atr: float,
                   horizon: int = HORIZON, use_stop: bool = True, use_target: bool = False, cost: float = 0.001,
                   limit: float | None = None):
    """Enter at the open of `start` (no fill when a limit is given and the open is above it → (None, start, "no_fill", []));
    stop = entry − stop_atr·ATR (exit at the stop, or at the open if it gaps through);
    optional 2R target; otherwise exit at the close of the horizon-th session.

    Returns (net return, exit index, reason, path) or None if there is no entry print. `path` holds the gross
    mark-to-market return for every session start..exit (a missing close carries the previous mark).
    reason: stop | target | time | open (the horizon runs past the data)."""
    n = len(c)
    if start >= n or not np.isfinite(o[start]) or not np.isfinite(atr) or atr <= 0:
        return None
    entry = o[start]
    if limit is not None and entry > limit:
        return None, start, "no_fill", []
    stop = entry - stop_atr * atr
    tgt = entry + TARGET_R * (entry - stop)
    end = min(start + horizon - 1, n - 1)
    path: list[float] = []
    mark = 0.0
    for k in range(start, end + 1):
        if use_stop and k > start and np.isfinite(o[k]) and o[k] <= stop:
            path.append(o[k] / entry - 1)
            return o[k] / entry - 1 - 2 * cost, k, "stop", path
        if use_stop and np.isfinite(l[k]) and l[k] <= stop:
            path.append(stop / entry - 1)
            return stop / entry - 1 - 2 * cost, k, "stop", path
        if use_target and np.isfinite(h[k]) and h[k] >= tgt:
            px = max(tgt, o[k]) if k > start and np.isfinite(o[k]) else tgt   # a gap above the target fills at the open
            path.append(px / entry - 1)
            return px / entry - 1 - 2 * cost, k, "target", path
        if np.isfinite(c[k]):
            mark = c[k] / entry - 1
        path.append(mark)
    reason = "time" if start + horizon - 1 <= n - 1 else "open"
    return mark - 2 * cost, end, reason, path
