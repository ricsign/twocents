"""Daily pick orchestrator → docs/data/pick.json + docs/index.html.

    python -m engine.daily               full run (fresh bars + live lenses)
    python -m engine.daily --offline     stored history only; live lenses marked n/a (for development)

Steps
    1  stored point-in-time history (data/history) + today's bars chained on (yfinance)
    2  price lenses for every eligible S&P 500 member (engine/pick.py)
    3  market gate (trend ensemble on SPY)
    4  top-15 by price score → live lenses: earnings (Nasdaq ∩ Yahoo), news (Yahoo, Google News, SEC 8-K),
       analysts (Yahoo), data check (Yahoo close vs Nasdaq, Stooq fallback)
    5  final score = price score × gates; pick = highest unblocked
    6  plan, chart, base rate (from the backtest of the same rules), live record graded from prices
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import io
import json
import logging
import math
import time
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import requests

from . import calendar_events as cal
from . import news as NW
from . import pick as PK
from . import rotation as R
from . import rotation_live as LV

ROOT = Path(__file__).resolve().parent.parent
HIST_DIR = ROOT / "data" / "history"
DOCS = ROOT / "docs"
DATA_OUT = DOCS / "data"
PICKS_DIR = DOCS / "picks"
ET = ZoneInfo("America/New_York")
VERSION = "3.0"
N_LIVE = 15
log = logging.getLogger("daily")

SECTOR_ETF = {"Technology": "XLK", "Information Technology": "XLK", "Financial Services": "XLF", "Financials": "XLF",
              "Energy": "XLE", "Healthcare": "XLV", "Health Care": "XLV", "Consumer Cyclical": "XLY",
              "Consumer Discretionary": "XLY", "Consumer Defensive": "XLP", "Consumer Staples": "XLP",
              "Industrials": "XLI", "Basic Materials": "XLB", "Materials": "XLB", "Utilities": "XLU",
              "Real Estate": "XLRE", "Communication Services": "XLC"}
ETF_NAME = {"XLK": "Technology", "XLF": "Financials", "XLE": "Energy", "XLV": "Health Care", "XLY": "Cons. Discretionary",
            "XLP": "Cons. Staples", "XLI": "Industrials", "XLB": "Materials", "XLU": "Utilities", "XLRE": "Real Estate",
            "XLC": "Communication"}
BENCH_LIVE = ["SPY", "^GSPC", "^VIX", "QQQ", "IWM"] + list(ETF_NAME)
UA = {"accept": "application/json, text/plain, */*", "accept-language": "en-US,en;q=0.9",
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "origin": "https://www.nasdaq.com", "referer": "https://www.nasdaq.com/"}


# --------------------------------------------------------------------------- helpers
def r_(x, nd=4):
    try:
        if x is None:
            return None
        x = float(x)
        return None if not math.isfinite(x) else round(x, nd)
    except Exception:
        return None


def lst(s, nd=2):
    return [r_(v, nd) for v in s]


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


class Sources:
    """Book-keeping for meta.sources: which feeds answered and how many items they returned."""

    def __init__(self):
        self.d: dict[str, dict] = {}

    def add(self, name: str, n: int, ok: bool | None = None):
        e = self.d.setdefault(name, {"name": name, "ok": False, "n": 0, "calls": 0})
        e["n"] += int(n)
        e["calls"] += 1
        e["ok"] = e["ok"] or (ok if ok is not None else n > 0)

    def out(self):
        return [{"name": v["name"], "ok": v["ok"], "n": v["n"]} for v in self.d.values()]


# --------------------------------------------------------------------------- data
def load(offline: bool, src: Sources, warnings: list[str]) -> tuple[R.History, dict]:
    t0 = time.time()
    hist = R.load_history(HIST_DIR, start="1998-01-01")
    raw = spy_raw_ohlc()
    log.info("history loaded through %s (%.0fs)", hist.dates[-1].date(), time.time() - t0)
    if offline:
        return hist, raw
    from . import data as D
    live = list(hist.member.columns[hist.member.iloc[-1].values])
    live += [t for t in recent_pick_tickers() if t not in live]         # held names that left the index still need marks
    now_et = dt.datetime.now(ET)
    cutoff = now_et.date() if now_et.time() < dt.time(16, 20) else now_et.date() + dt.timedelta(days=1)
    try:
        fresh = D.fetch_prices_raw(live, period="1mo", chunk_size=50, pause=1.0)
        bench = D.fetch_prices_raw(BENCH_LIVE, period="1mo", chunk_size=50, pause=1.0)
        fresh = {k: clean_fresh(v[v.index.date < cutoff]) for k, v in fresh.items()}
        bench = {k: v[v.index.date < cutoff] for k, v in bench.items()}
        src.add("Yahoo prices", len(fresh))
        if len(fresh) < 0.8 * len(live):
            warnings.append(f"Yahoo returned bars for {len(fresh)} of {len(live)} members")
        if "SPY" in bench:
            b = bench["SPY"]
            raw = pd.concat([raw, b[["Open", "High", "Low", "Close"]].rename(columns=str.lower)])
            raw = raw[~raw.index.duplicated(keep="last")].sort_index()
        stored_last = hist.dates[-1]
        hist = LV.extend_history(hist, fresh, bench)
        hist = trim_partial(hist, live, stored_last, warnings)
    except Exception as e:
        log.exception("fresh bars failed")
        warnings.append(f"fresh bars failed ({e}); using stored history through {hist.dates[-1].date()}")
        src.add("Yahoo prices", 0, False)
    return hist, raw


def recent_pick_tickers(days: int = 45) -> list[str]:
    out = []
    cut = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    for f in sorted(PICKS_DIR.glob("*.json")):
        if f.stem >= cut:
            try:
                t = json.loads(f.read_text()).get("ticker")
            except Exception:
                t = None
            if t:
                out.append(t)
    return out


def clean_fresh(df: pd.DataFrame) -> pd.DataFrame:
    """Drop bars whose close moves > +100% or < −60% vs the prior bar (the stored history gets the same rule)."""
    if len(df) < 2:
        return df
    r = df["Close"] / df["Close"].shift(1)
    bad = (r > 2.0) | (r < 0.4)
    return df[~bad]


def trim_partial(hist: R.History, live: list[str], stored_last: pd.Timestamp, warnings: list[str]) -> R.History:
    """A new session counts only if ≥ 90% of current members have a bar for it (a half-finished download would
    otherwise shrink the pool silently)."""
    cols = [t for t in live if t in hist.adj_close.columns]
    drop = 0
    while hist.dates[-1 - drop] > stored_last and hist.adj_close.iloc[-1 - drop][cols].notna().mean() < 0.9:
        drop += 1
    if not drop:
        return hist
    keep = hist.dates[:-drop]
    warnings.append(f"dropped {drop} session(s) with < 90% member coverage; data ends {keep[-1].date()}")
    f = lambda x: None if x is None else x.loc[keep]
    return R.History(adj_close=f(hist.adj_close), close=f(hist.close), open_adj=f(hist.open_adj), volume=f(hist.volume),
                     member=f(hist.member), bench={k: v[v.index <= keep[-1]] for k, v in hist.bench.items()}, spells=hist.spells,
                     high=f(hist.high), low=f(hist.low))


def spy_raw_ohlc() -> pd.DataFrame:
    b = pd.read_parquet(HIST_DIR / "benchmarks.parquet")
    b = b[b["ticker"] == "SPY"].copy()
    b["date"] = pd.to_datetime(b["date"])
    return b.set_index("date")[["open", "high", "low", "close"]].sort_index()


def spy_adj_open(hist: R.History, raw: pd.DataFrame) -> pd.Series:
    """Adjusted SPY open = adjusted close × raw open / raw close (same session)."""
    c = hist.bench["SPY"].reindex(hist.dates).ffill()
    rr = (raw["open"] / raw["close"]).reindex(hist.dates)
    return (c * rr).fillna(c)


# --------------------------------------------------------------------------- market gate
def regime_block(hist: R.History, spec: dict, P: dict, i: int) -> dict:
    spy = hist.bench["SPY"].reindex(hist.dates).ffill().dropna()
    rg = spec["regime"]
    exp = R.exposure_series(spy, spec)
    rules = R.trend_rules(spy, spec)
    f, s = rg["cross"]
    vals = {"sma200": spy / spy.rolling(rg["sma_long"]).mean() - 1, "sma10m": spy / spy.rolling(rg["sma_10m"]).mean() - 1,
            "tsmom12": spy / spy.shift(rg["tsmom"]) - 1, "cross": spy.rolling(f).mean() / spy.rolling(s).mean() - 1}
    labels = {"sma200": "S&P > 200-day", "sma10m": "S&P > 10-month", "tsmom12": "12-mo return > 0", "cross": "3-mo avg > 12-mo avg"}
    e = float(exp.iloc[-1])
    state = "risk_on" if e >= 0.75 else "caution" if e >= 0.5 else "risk_off"
    n = 252
    sma200 = spy.rolling(200).mean()
    vix = hist.bench.get("^VIX")
    vix_last = vix_pct = None
    if vix is not None and len(vix.dropna()):
        v = vix.dropna()
        vix_last = float(v.iloc[-1])
        vix_pct = float((v.iloc[-252:] < vix_last).mean())
    c = hist.adj_close.iloc[i]
    m = hist.member.iloc[i] & c.notna()
    b50 = float((c[m] > P["sma50"].iloc[i][m]).mean())
    b200 = float((c[m] > P["sma200"].iloc[i][m]).mean())
    y0 = spy[spy.index.year == spy.index[-1].year]
    prev_year = spy[spy.index.year < spy.index[-1].year]
    ytd = float(spy.iloc[-1] / prev_year.iloc[-1] - 1) if len(prev_year) else None
    # exposure history (1y) for the gauge's sparkline
    return {"exposure": e, "state": state,
            "rules": [{"key": k, "label": labels[k], "on": bool(rules[k].iloc[-1]), "value": r_(vals[k].iloc[-1])} for k in ["sma200", "sma10m", "tsmom12", "cross"]],
            "spy": {"close": r_(spy.iloc[-1], 2), "ret_1d": r_(spy.iloc[-1] / spy.iloc[-2] - 1), "ret_21d": r_(spy.iloc[-1] / spy.iloc[-22] - 1),
                    "ytd": r_(ytd), "dates": [str(d.date()) for d in spy.index[-n:]], "spark": lst(spy.iloc[-n:]), "sma200": lst(sma200.iloc[-n:])},
            "exposure_hist": lst(exp.iloc[-n:], 2),
            "vix": r_(vix_last, 2), "vix_pct_1y": r_(vix_pct, 3), "breadth_50": r_(b50, 3), "breadth_200": r_(b200, 3)}


# --------------------------------------------------------------------------- live lenses
def fetch_nasdaq_earnings_window(start: dt.date, sessions: int, src: Sources) -> pd.DataFrame:
    """Nasdaq earnings calendar for each session in the window. df.attrs['complete'] is True only if every day answered."""
    days = cal.next_trading_days(start, sessions)
    rows, failed = [], []
    sess = requests.Session()
    sess.headers.update(UA)
    for d in days:
        try:
            r = sess.get("https://api.nasdaq.com/api/calendar/earnings", params={"date": str(d)}, timeout=20)
            r.raise_for_status()
            for row in ((r.json().get("data") or {}).get("rows") or []):
                rows.append({"date": str(d), "ticker": str(row.get("symbol", "")).replace(".", "-"),
                             "session": {"time-pre-market": "BMO", "time-after-hours": "AMC"}.get(row.get("time"), "TBD")})
        except Exception as e:
            failed.append(str(d))
            log.debug("nasdaq earnings %s: %s", d, e)
            if len(failed) >= 4 and not rows:
                failed += [str(x) for x in days[days.index(d) + 1:]]
                break
        time.sleep(0.3)
    df = pd.DataFrame(rows, columns=["date", "ticker", "session"])
    df.attrs["complete"] = not failed
    df.attrs["failed"] = failed
    src.add("Nasdaq earnings", len(df), ok=len(df) > 0)
    return df


def earnings_lens(t: str, nas: pd.DataFrame, yahoo_next: str | None, last: dt.date, sessions: list[dt.date]) -> tuple[dict, dict]:
    n_row = nas[nas["ticker"] == t] if len(nas) else nas
    nd = n_row["date"].min() if len(n_row) else None
    ses = n_row.sort_values("date")["session"].iloc[0] if len(n_row) else None
    yd = yahoo_next if yahoo_next and yahoo_next >= str(last) else None
    dates = [d for d in (nd, yd) if d]
    if not dates:
        # Nasdaq covered the whole window and has no row → no report inside the hold (single-source pass)
        covered = len(nas) > 0 and nas.attrs.get("complete", False)
        L = {"key": "earnings", "status": "pass" if covered else "na", "score": 1.0 if covered else None,
             "value": "none in window" if covered else "—",
             "detail": f"no report before {sessions[PK.HORIZON - 1]} (Nasdaq)" if covered else "no date from Nasdaq or Yahoo"}
        return L, {"next": None, "days": None, "session": None, "sources": ["Nasdaq"] if covered else []}
    nxt = min(dates)
    d = dt.date.fromisoformat(nxt)
    days = cal.trading_days_between(last, d)
    agree = (nd is not None and yd is not None and abs((dt.date.fromisoformat(nd) - dt.date.fromisoformat(yd)).days) <= 3)
    srcs = [s for s, v in (("Nasdaq", nd), ("Yahoo", yd)) if v]
    if days <= 3:
        st, sc = "fail", 0.0
    elif days <= PK.HORIZON:
        st, sc = "warn", 0.5
    else:
        st, sc = "pass", 1.0
    when = "inside the hold" if days <= PK.HORIZON else "after exit"
    detail = f"{nxt}{' ' + ses if ses and ses != 'TBD' else ''} · {when}" + ("" if agree or len(srcs) < 2 else " · sources differ")
    return ({"key": "earnings", "status": st, "score": sc, "value": f"{days} sessions", "detail": detail},
            {"next": nxt, "days": days, "session": ses, "sources": srcs, "agree": agree})


def analyst_lens(f: dict, close: float) -> tuple[dict, dict]:
    mean, n = f.get("recommendationMean"), f.get("numberOfAnalystOpinions") or f.get("analysts")
    tgt = f.get("targetMeanPrice")
    if mean is None or not n:
        return {"key": "analysts", "status": "na", "score": None, "value": "—", "detail": "no coverage data"}, {}
    up = (tgt / close - 1) if tgt and close else None
    key = (f.get("recommendationKey") or "").replace("_", " ").title() or None
    dn, ug = f.get("downgrades_60d") or 0, f.get("upgrades_60d") or 0
    if mean >= 3.5:
        st = "fail"
    elif mean > 2.6 or (up is not None and up < 0) or dn >= ug + 2:
        st = "warn"
    else:
        st = "pass"
    sc = max(0.0, min(1.0, (5 - mean) / 4))
    a = {"rating": key, "mean": r_(mean, 2), "n": int(n), "target_mean": r_(tgt, 2), "target_low": r_(f.get("targetLowPrice"), 2),
         "target_high": r_(f.get("targetHighPrice"), 2), "upside": r_(up), "upgrades_60d": int(ug), "downgrades_60d": int(dn),
         "rec_3m": r_(f.get("rec_3m"), 2)}
    val = f"{key or ''} · {up * 100:+.0f}%" if up is not None else (key or f"{mean:.1f}")
    det = f"{int(n)} analysts · mean {mean:.1f}/5" + (f" · {ug}↑ {dn}↓ 60d" if ug or dn else "")
    return {"key": "analysts", "status": st, "score": r_(sc, 3), "value": val, "detail": det}, a


def nasdaq_close(t: str, d: dt.date) -> float | None:
    try:
        r = requests.get(f"https://api.nasdaq.com/api/quote/{t.replace('-', '.')}/historical",
                         params={"assetclass": "stocks", "fromdate": str(d - dt.timedelta(days=7)), "todate": str(d), "limit": 10},
                         headers=UA, timeout=15)
        rows = ((r.json().get("data") or {}).get("tradesTable") or {}).get("rows") or []
        for row in rows:
            if dt.datetime.strptime(row["date"], "%m/%d/%Y").date() == d:
                return float(str(row["close"]).replace("$", "").replace(",", ""))
    except Exception as e:
        log.debug("nasdaq %s: %s", t, e)
    return None


def stooq_close(t: str, d: dt.date) -> float | None:
    try:
        r = requests.get("https://stooq.com/q/d/l/", params={"s": f"{t.lower().replace('-', '.')}.us", "i": "d",
                         "d1": (d - dt.timedelta(days=7)).strftime("%Y%m%d"), "d2": d.strftime("%Y%m%d")}, headers=UA, timeout=15)
        if not r.text.startswith("Date"):
            return None
        df = pd.read_csv(io.StringIO(r.text))
        row = df[df["Date"] == str(d)]
        return float(row["Close"].iloc[0]) if len(row) else None
    except Exception as e:
        log.debug("stooq %s: %s", t, e)
    return None


def data_lens(t: str, yahoo_close: float, d: dt.date, src: Sources) -> dict:
    other, name = nasdaq_close(t, d), "Nasdaq"
    src.add("Nasdaq quote check", 1 if other else 0)
    if other is None:
        other, name = stooq_close(t, d), "Stooq"
        src.add("Stooq quote check", 1 if other else 0)
    if other is None:
        return {"key": "data", "status": "na", "score": None, "value": "—", "detail": "no second source answered"}
    diff = yahoo_close / other - 1
    st = "pass" if abs(diff) <= 0.005 else "warn" if abs(diff) <= 0.02 else "fail"
    return {"key": "data", "status": st, "score": r_(max(0.0, 1 - abs(diff) / 0.02), 3), "value": f"Δ {diff * 100:+.2f}%",
            "detail": f"Yahoo {yahoo_close:.2f} vs {name} {other:.2f} on {d}"}


def fundamentals(t: str) -> dict:
    from . import data as D
    return D._fetch_one_fundamental(t)


def live_for(t: str, close: float, last: dt.date, sessions: list[dt.date], nas: pd.DataFrame, src: Sources, offline: bool) -> dict:
    if offline:
        na = lambda k: {"key": k, "status": "na", "score": None, "value": "—", "detail": "offline run"}
        return {"lenses": [na("earnings"), na("news"), na("analysts"), na("data")], "f": {}, "news": [], "filings": [], "analyst": {}, "earnings": {}}
    f = fundamentals(t)
    src.add("Yahoo fundamentals", 0 if f.get("error") else 1)
    eL, earn = earnings_lens(t, nas, f.get("next_earnings"), last, sessions)
    nL, heads, filings, counts = NW.lens(t, f.get("longName") or f.get("shortName"), now_utc())
    for k, v in counts.items():
        src.add(k, v)
    aL, an = analyst_lens(f, close)
    dL = data_lens(t, close, last, src)
    return {"lenses": [eL, nL, aL, dL], "f": f, "news": heads, "filings": filings, "analyst": an, "earnings": earn}


# --------------------------------------------------------------------------- pick details
def stock_stats(hist: R.History, P: dict, i: int, t: str) -> dict:
    c = hist.adj_close[t].iloc[: i + 1].dropna()
    spy = hist.bench["SPY"].reindex(hist.dates).ffill().iloc[: i + 1]
    ret = lambda n: r_(c.iloc[-1] / c.iloc[-n - 1] - 1) if len(c) > n else None
    rs, rm = np.log(c).diff().iloc[-252:], np.log(spy).diff().reindex(c.index).iloc[-252:]
    ok = rs.notna() & rm.notna()
    beta = float(np.cov(rs[ok], rm[ok])[0, 1] / np.var(rm[ok], ddof=1)) if ok.sum() > 100 else None
    hi = hist.high[t].iloc[max(0, i - 251): i + 1].max()
    return {"ret_1m": ret(21), "ret_3m": ret(63), "ret_6m": ret(126), "ret_12m": ret(252), "vol_1y": r_(P["vol"].iloc[i][t]),
            "beta": r_(beta, 2), "pct_52w_high": r_(c.iloc[-1] / hi), "rsi14": r_(P["rsi"].iloc[i][t], 1),
            "dollar_vol_m": r_(P["dvol"].iloc[i][t] / 1e6, 0), "ext_atr": r_(P["ext_atr"].iloc[i][t], 2)}


def chart_block(hist: R.History, P: dict, i: int, t: str, n: int = 126) -> dict:
    sl = slice(max(0, i - n + 1), i + 1)
    adj = hist.adj_close[t].iloc[sl]
    fac = (hist.close[t].iloc[sl] / adj).ffill().bfill()   # adjusted → raw (as quoted today on the chart)
    return {"dates": [str(d.date()) for d in adj.index], "o": lst(hist.open_adj[t].iloc[sl] * fac), "h": lst(hist.high[t].iloc[sl] * fac),
            "l": lst(hist.low[t].iloc[sl] * fac), "c": lst(hist.close[t].iloc[sl]), "v": [int(v) if np.isfinite(v) else None for v in hist.volume[t].iloc[sl]],
            "sma50": lst(P["sma50"][t].iloc[sl] * fac), "sma200": lst(P["sma200"][t].iloc[sl] * fac)}


def rs_block(hist: R.History, i: int, t: str, n: int = 252) -> dict:
    c = hist.adj_close[t].iloc[max(0, i - n + 1): i + 1].ffill()
    s = hist.bench["SPY"].reindex(c.index).ffill()
    return {"dates": [str(d.date()) for d in c.index], "stock": lst(100 * c / c.iloc[0], 2), "spy": lst(100 * s / s.iloc[0], 2)}


def spark(hist: R.History, i: int, t: str, n: int = 63) -> list:
    return lst(hist.close[t].iloc[max(0, i - n + 1): i + 1], 2)


def base_rate(bt: dict | None, dip5: float | None) -> dict | None:
    """Past picks under the same rules: all of them, plus the subset with a similar 5-session dip."""
    if not bt or not bt.get("base"):
        return None
    out = {k: bt["base"].get(k) for k in ("n", "win", "avg", "median", "avg_spy", "avg_random", "p10", "p90", "worst", "best", "hist")}
    for b in bt.get("by_score", []):
        if dip5 is not None and b["lo"] <= dip5 < b["hi"]:
            out["similar"] = {k: b.get(k) for k in ("bucket", "n", "win", "avg", "median", "avg_spy")}
    return out


# --------------------------------------------------------------------------- live record
def grade_record(hist: R.History, spy_open: pd.Series) -> dict:
    PICKS_DIR.mkdir(parents=True, exist_ok=True)
    picks = []
    spy = hist.bench["SPY"].reindex(hist.dates).ffill()
    idx = {d.date(): k for k, d in enumerate(hist.dates)}
    for f in sorted(PICKS_DIR.glob("*.json")):
        try:
            p = json.loads(f.read_text())
        except Exception:
            continue
        if not p.get("ticker"):
            picks.append({"date": p["pick_for"], "ticker": None, "status": "stand_aside", "reason": p.get("reason")})
            continue
        t, d0 = p["ticker"], dt.date.fromisoformat(p["pick_for"])
        row = {"date": p["pick_for"], "ticker": t, "score": p.get("score"), "stop": p["plan"].get("stop"), "target": p["plan"].get("target"),
               "sell_on": str(cal.next_trading_days(d0, PK.HORIZON)[-1]),
               "limit": p["plan"]["limit"], "status": "pending", "entry": None, "exit": None, "exit_date": None, "ret": None,
               "spy_ret": None, "days": 0, "reason": None, "path": []}
        k = idx.get(d0)
        if k is None or t not in hist.adj_close.columns:
            if d0 <= hist.dates[-1].date():           # the session passed with no usable print: void, not pending forever
                row.update({"status": "void", "reason": "no print"})
            picks.append(row)
            continue
        o, h, l, c = (hist.open_adj[t].values, hist.high[t].values, hist.low[t].values, hist.adj_close[t].values)
        ref = hist.adj_close[t].iloc[k - 1]                      # signal-day close in today's adjusted terms
        atr_abs = p["atr_pct"] * ref
        res = PK.simulate_trade(o, h, l, c, k, PK.RULES["stop_atr"] or PK.STOP_ATR, atr_abs, use_stop=PK.RULES["stop_atr"] is not None)
        if res is None:
            row.update({"status": "void", "reason": "no print"})
            picks.append(row)
            continue
        ret, ex, reason, path = res
        to_raw = hist.close[t].iloc[k] / hist.adj_close[t].iloc[k]
        lim = p["plan"].get("limit")
        if lim is not None and np.isfinite(o[k]) and o[k] * to_raw > lim * 1.0005:
            row.update({"status": "no_fill", "reason": "opened above limit", "entry": r_(o[k] * to_raw, 2)})
            picks.append(row)
            continue
        row.update({"entry": r_(o[k] * to_raw, 2), "ret": r_(ret), "days": int(ex - k + 1), "path": lst(path, 4),
                    "spy_ret": r_(spy.iloc[ex] / spy_open.iloc[k] - 1 - 0.002),
                    "status": "open" if reason == "open" else "closed", "reason": None if reason == "open" else reason,
                    "exit_date": None if reason == "open" else str(hist.dates[ex].date()),
                    "exit": None if reason == "open" else r_(o[k] * (1 + path[-1]) * hist.close[t].iloc[ex] / hist.adj_close[t].iloc[ex], 2),
                    "last": r_(hist.close[t].iloc[ex], 2)})
        picks.append(row)
    done = [p for p in picks if p.get("ret") is not None]
    closed = [p for p in done if p["status"] == "closed"]
    summ = {"n": len([p for p in picks if p.get("ticker")]), "open": len([p for p in done if p["status"] == "open"]), "closed": len(closed),
            "stand_aside": len([p for p in picks if p["status"] == "stand_aside"]),
            "no_fill": len([p for p in picks if p["status"] in ("no_fill", "void")]),
            "win": r_(np.mean([p["ret"] > 0 for p in closed])) if closed else None,
            "avg": r_(np.mean([p["ret"] for p in done])) if done else None,
            "avg_spy": r_(np.mean([p["spy_ret"] for p in done if p["spy_ret"] is not None])) if done else None}
    summ["excess"] = r_(summ["avg"] - summ["avg_spy"]) if summ["avg"] is not None and summ["avg_spy"] is not None else None
    return {"since": picks[0]["date"] if picks else None, "summary": summ, "picks": picks[::-1]}


def write_pick_file(pick: dict | None, pick_for: str, as_of: str, regime_state: str, hist: R.History, P: dict, i: int):
    PICKS_DIR.mkdir(parents=True, exist_ok=True)
    f = PICKS_DIR / f"{pick_for}.json"
    if pd.Timestamp(pick_for) in hist.dates:   # the session already traded: the pick is frozen
        return
    now = dt.datetime.now(ET)
    if dt.date.fromisoformat(pick_for) < now.date() or (dt.date.fromisoformat(pick_for) == now.date() and now.time() >= dt.time(9, 30)):
        log.warning("not writing %s: that session has already opened (stale data or a late run)", pick_for)
        return False
    if pick is None:
        body = {"pick_for": pick_for, "data_as_of": as_of, "ticker": None, "reason": regime_state}
    else:
        t = pick["ticker"]
        body = {"pick_for": pick_for, "data_as_of": as_of, "ticker": t, "score": pick["score"], "close": pick["close"],
                "atr_pct": r_(P["atr"].iloc[i][t] / hist.adj_close[t].iloc[i], 6), "plan": {k: pick["plan"][k] for k in ("entry", "limit", "stop", "target", "exit_by")},
                "lenses": {L["key"]: L["status"] for L in pick["lenses"]}, "generated_at": now_utc().strftime("%Y-%m-%dT%H:%M:%SZ")}
    f.write_text(json.dumps(body, indent=1))


# --------------------------------------------------------------------------- market panel
def market_block(hist: R.History, nas: pd.DataFrame, members: set[str], last: dt.date, offline: bool, src: Sources) -> dict:
    spy = hist.bench["SPY"].reindex(hist.dates).ffill()
    sectors = []
    for etf, name in ETF_NAME.items():
        s = hist.bench.get(etf)
        if s is None:
            continue
        s = s.reindex(hist.dates).ffill()
        if s.isna().iloc[-1]:
            continue
        r1, r3 = s.iloc[-1] / s.iloc[-22] - 1, s.iloc[-1] / s.iloc[-64] - 1
        sectors.append({"sector": name, "etf": etf, "ret_1m": r_(r1), "ret_3m": r_(r3), "rs": r_(r3 - (spy.iloc[-1] / spy.iloc[-64] - 1)),
                        "spark": lst((s.iloc[-63:] / s.iloc[-63]) * 100, 2)})
    sectors.sort(key=lambda x: -(x["rs"] or -9))
    wk = cal.next_trading_days(last + dt.timedelta(days=1), 5)
    ew = []
    if len(nas):
        e = nas[nas["ticker"].isin(members) & nas["date"].isin([str(d) for d in wk])]
        for _, r in e.sort_values("date").iterrows():
            ew.append({"date": r["date"], "ticker": r["ticker"], "session": r["session"]})
    heads = []
    if not offline:
        items = NW._rss("https://news.google.com/rss/search?q=stock+market+when:1d&hl=en-US&gl=US&ceid=US:en", "Google News", 20)
        items += NW._rss("https://feeds.finance.yahoo.com/rss/2.0/headline?s=SPY&region=US&lang=en-US", "Yahoo Finance", 20)
        src.add("Market headlines", len(items))
        for h in NW.dedupe(items)[:10]:
            heads.append({"title": h["title"], "source": h["source"], "link": h["link"], "sentiment": round(NW.tone(h["title"]), 2),
                          "published": h["published"].strftime("%Y-%m-%dT%H:%M:%SZ") if h["published"] else None})
    return {"sectors": sectors, "earnings_week": ew, "headlines": heads}


# --------------------------------------------------------------------------- main
def run(offline: bool = False, out: Path = DATA_OUT / "pick.json", build_html: bool = True) -> dict:
    t0 = time.time()
    src, warnings = Sources(), []
    hist, spy_raw = load(offline, src, warnings)
    spec = LV.load_spec()
    P = PK.panels(hist, spec)
    i = len(hist.dates) - 1
    last = hist.dates[i].date()
    sessions = cal.next_trading_days(last + dt.timedelta(days=1), PK.HORIZON + 5)
    pick_for = str(sessions[0])
    cal_end = max((e["date"] for e in cal.load_calendar() if e.get("category") == "holiday"), default="")
    if str(sessions[-1]) > cal_end:
        warnings.append(f"exchange holiday calendar ends {cal_end or '—'}: extend data/calendar_*.json")
    if (dt.datetime.now(ET).date() - last).days > 5:
        warnings.append(f"price data ends {last} — stale")
    regime = regime_block(hist, spec, P, i)

    # ---- funnel
    members = set(hist.member.columns[hist.member.iloc[i].values])
    elig = P["elig"].iloc[i]
    trend_ok = elig & (P["trend"].iloc[i] >= 3)
    tradable = P["tradable"].iloc[i]
    score = P["score"].iloc[i].dropna().sort_values(ascending=False)
    ram_rank = P["ram"].iloc[i].rank(ascending=False)
    pool_n = int(elig.sum())
    top = list(score.index[:N_LIVE])
    log.info("%d members, %d eligible, %d uptrend, %d tradable; top: %s", len(members), pool_n, int(trend_ok.sum()), int(tradable.sum()), ", ".join(top[:8]))

    # ---- the open book (earlier picks still held): never pick a name twice
    record = grade_record(hist, spy_adj_open(hist, spy_raw))
    held = {p["ticker"] for p in record["picks"] if p.get("ticker") and p["status"] in ("open", "pending") and p["date"] != pick_for}
    if PK.RULES["skip_held"] and held:
        score = score.drop([t for t in held if t in score.index])
        top = list(score.index[:N_LIVE])
    book = []
    for p in record["picks"]:
        if p.get("ticker") and p["status"] in ("open", "pending") and p["date"] != pick_for:
            book.append({"ticker": p["ticker"], "bought": p["date"], "entry": p["entry"], "sell_on": p.get("sell_on"), "days": p["days"],
                         "ret": p["ret"], "last": p.get("last"), "status": p["status"],
                         "action": "sell" if p.get("sell_on") == pick_for else ("buy" if p["status"] == "pending" else "hold")})
    book.sort(key=lambda b: b["sell_on"] or "")

    # ---- live lenses for the top names
    nas = pd.DataFrame(columns=["date", "ticker", "session"]) if offline else fetch_nasdaq_earnings_window(last, PK.HORIZON + 3, src)
    closes = {t: float(hist.close[t].iloc[i]) for t in top}
    live: dict[str, dict] = {}
    with cf.ThreadPoolExecutor(max_workers=1 if offline else 4) as ex:
        futs = {ex.submit(live_for, t, closes[t], last, sessions, nas, src, offline): t for t in top}
        for fu in cf.as_completed(futs):
            t = futs[fu]
            try:
                live[t] = fu.result()
            except Exception as e:
                log.exception("live lenses %s", t)
                na = lambda k: {"key": k, "status": "na", "score": None, "value": "—", "detail": f"error: {str(e)[:60]}"}
                live[t] = {"lenses": [na("earnings"), na("news"), na("analysts"), na("data")], "f": {}, "news": [], "filings": [], "analyst": {}, "earnings": {}}

    # sector strength rank among the 11 sector ETFs (3 months vs SPY)
    spy = hist.bench["SPY"].reindex(hist.dates).ffill()
    sec_rs = {}
    for etf in ETF_NAME:
        s = hist.bench.get(etf)
        if s is not None:
            s = s.reindex(hist.dates).ffill()
            sec_rs[etf] = s.iloc[i] / s.iloc[i - 63] - 1 - (spy.iloc[i] / spy.iloc[i - 63] - 1)
    sec_order = sorted(sec_rs, key=lambda k: -sec_rs[k])

    cands = []
    for t in top:
        L = live[t]
        f = L["f"]
        etf = SECTOR_ETF.get(f.get("sector") or "")
        srank = f"{sec_order.index(etf) + 1}/{len(sec_order)}" if etf in sec_order else None
        lenses = PK.price_lenses(P, i, t, pool_n, int(ram_rank[t]), srank) + L["lenses"]
        for x in lenses:
            x["label"] = PK.LENS_LABEL[x["key"]]
        mult, blocked = PK.gate_multiplier(lenses)
        if blocked is None and lenses[1]["status"] == "fail":
            blocked = "Trend"
        base = float(score[t])
        cands.append({"ticker": t, "name": f.get("shortName") or f.get("longName") or t, "sector": f.get("sector"), "industry": f.get("industry"),
                      "close": r_(closes[t], 2), "price_score": r_(base, 1), "score": 0.0 if blocked else r_(base, 1), "gates": r_(mult, 3), "blocked_by": blocked,
                      "lenses": lenses, "agree": sum(x["status"] == "pass" for x in lenses), "live": L, "etf": etf})
    cands.sort(key=lambda c: (c["blocked_by"] is not None, -(c["price_score"] or 0)))   # checks veto; they never reorder
    risk_off = regime["exposure"] < 0.5
    winner = None if risk_off else next((c for c in cands if c["blocked_by"] is None), None)

    bt = None
    btf = DATA_OUT / "backtest_pick.json"
    if btf.exists():
        try:
            bt = json.loads(btf.read_text())
        except Exception as e:
            warnings.append(f"backtest_pick.json unreadable: {e}")
    else:
        warnings.append("backtest_pick.json missing — run research/backtest_pick.py")

    pick = None
    if winner:
        t = winner["ticker"]
        f = winner["live"]["f"]
        pct = float(P["score"].iloc[i].rank(pct=True)[t])
        sc = winner["score"]
        br = base_rate(bt, float(P["ret5"].iloc[i][t]))
        atr_raw = float(P["atr"].iloc[i][t] * hist.close[t].iloc[i] / hist.adj_close[t].iloc[i])
        q, fi = float(P["quality"].iloc[i][t]), float(P["fit"].iloc[i][t])
        pick = {"ticker": t, "name": f.get("longName") or winner["name"], "sector": winner["sector"], "industry": winner["industry"],
                "close": winner["close"], "market_cap_b": r_((f.get("marketCap") or 0) / 1e9, 1) or None,
                "score": r_(sc, 1), "price_score": winner["price_score"], "rank_pct": r_(pct, 3),
                "rank": 1 + sum(1 for c in cands if c is not winner and (c["blocked_by"] is None) and (c["score"] or 0) > (sc or 0)),
                "pool": int(tradable.sum()), "dip5": r_(P["ret5"].iloc[i][t]),
                "agree": winner["agree"], "lenses_total": len(winner["lenses"]), "lenses": winner["lenses"],
                "components": {"quality": r_(q, 3), "fit": r_(fi, 3), "gates": winner["gates"]},
                "plan": PK.plan(winner["close"], atr_raw, hist.dates[i], sessions, base=br),
                "stats": stock_stats(hist, P, i, t), "chart": chart_block(hist, P, i, t), "rs_line": rs_block(hist, i, t),
                "news": winner["live"]["news"], "filings": winner["live"]["filings"], "analyst": winner["live"]["analyst"],
                "earnings": winner["live"]["earnings"], "base_rate": br,
                "sector_etf": winner["etf"], "runner_up": next((c["ticker"] for c in cands if c is not winner and not c["blocked_by"]), None)}
        pick["plan"]["entry_session"] = pick_for

    candidates = []
    for c in cands[:12]:
        t = c["ticker"]
        candidates.append({"ticker": t, "name": c["name"], "sector": c["sector"], "close": c["close"], "score": c["score"],
                           "price_score": c["price_score"], "blocked_by": c["blocked_by"], "agree": c["agree"],
                           "ret_6m": r_(hist.adj_close[t].iloc[i] / hist.adj_close[t].iloc[i - 126] - 1), "vol_1y": r_(P["vol"].iloc[i][t]),
                           "rsi14": r_(P["rsi"].iloc[i][t], 1), "ext_atr": r_(P["ext_atr"].iloc[i][t], 2), "dip5": r_(P["ret5"].iloc[i][t]),
                           "mom_pct": r_(P["mom_pct"].iloc[i][t], 3),
                           "pct_52w_high": r_(hist.adj_close[t].iloc[i] / hist.high[t].iloc[max(0, i - 251): i + 1].max()),
                           "days_to_earnings": c["live"]["earnings"].get("days"),
                           "lens_status": {L["key"]: L["status"] for L in c["lenses"]},
                           "lens_value": {L["key"]: L["value"] for L in c["lenses"]}, "spark": spark(hist, i, t)})

    funnel = [{"stage": "S&P 500", "n": len(members)}, {"stage": "Liquid · 1y history", "n": pool_n},
              {"stage": "Full uptrend", "n": int((elig & (P["trend"].iloc[i] == 4)).sum())}, {"stage": "Top-half momentum", "n": int(tradable.sum())},
              {"stage": "Live-checked", "n": len(cands)}, {"stage": "Clear all gates", "n": sum(c["blocked_by"] is None for c in cands)},
              {"stage": "Pick", "n": 1 if pick else 0}]

    if offline:
        warnings.append("offline run — pick not recorded")
    elif write_pick_file(pick, pick_for, str(last), regime["state"], hist, P, i) is False:
        warnings.append(f"pick for {pick_for} not recorded: that session already opened (data ends {last})")
    record = grade_record(hist, spy_adj_open(hist, spy_raw))
    if bt:
        record["recent_sim"] = bt.get("recent", [])
    market = market_block(hist, nas, members, last, offline, src)

    if not offline:
        for e in src.out():
            if not e["ok"]:
                warnings.append(f"{e['name']} returned nothing")
        if pick and all(L["status"] == "na" for L in pick["lenses"][5:]):
            warnings.append("Live checks unavailable — today's pick rests on price checks only")
    doc = {"meta": {"version": VERSION, "pick_for": pick_for, "data_as_of": str(last), "generated_at": now_utc().strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "n_universe": len(members), "offline": offline, "sources": src.out(), "warnings": warnings, "runtime_s": round(time.time() - t0, 1)},
           "regime": regime, "funnel": funnel, "pick": pick, "candidates": candidates, "record": record, "book": book,
           "rules": {"signal": "Deepest 5-day dip · top-half momentum · full uptrend", "hold": PK.HORIZON, "stop": PK.RULES["stop_atr"],
                     "skip_held": PK.RULES["skip_held"], "slot": f"1/{PK.HORIZON} of account", "gate": "no new buys when exposure < 50%"},
           "backtest": {k: v for k, v in (bt or {}).items() if k not in ("recent",)} or None, "market": market}
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, separators=(",", ":"), allow_nan=False, default=str))
    log.info("pick for %s: %s (score %s) · %.0fs", pick_for, pick["ticker"] if pick else "none", pick["score"] if pick else "-", time.time() - t0)
    if build_html:
        from . import site
        site.build(doc)
    return doc


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--no-html", action="store_true")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    run(offline=a.offline, build_html=not a.no_html)


if __name__ == "__main__":
    main()
