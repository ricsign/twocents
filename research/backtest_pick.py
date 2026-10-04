"""Backtest of the daily pick rules (pre-registered in docs/research/05_daily_pick_prereg.md).

Every trading day from 2003-01-02: if the market gate is on (exposure ≥ 0.5), take the highest price score among
point-in-time S&P 500 members, buy the next open, stop at entry − 2·ATR(14), exit at the 21st session's close,
10 bps per side. The live-only gates (earnings, news, analysts, data check) cannot be replayed and are excluded.

Comparisons, same entry/exit windows:
    spy        SPY open → close
    random     average of every eligible member (= the pick made at random), no stop
    top10      average of the day's top-10 scores, same stop
    no_stop    the pick without the stop
    target_2r  the pick with a 2R profit target
    ungated    the pick on every day, ignoring the market gate

    python -m research.backtest_pick            → docs/data/backtest_pick.json + research/output/pick_trades.csv
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import time
from pathlib import Path

import numpy as np
import pandas as pd

from engine import pick as PK
from engine import rotation as R
from engine import rotation_live as LV

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data" / "backtest_pick.json"
TRADES = ROOT / "research" / "output" / "pick_trades.csv"
COST = 0.001
RULES = dict(PK.RULES)
EDGES = [round(x, 3) for x in np.arange(-0.30, 0.4001, 0.025)]
BUCKETS = [(-1.0, -0.08, "below −8%"), (-0.08, -0.05, "−8 to −5%"), (-0.05, -0.03, "−5 to −3%"), (-0.03, 0.0, "−3 to 0%"), (0.0, 1.0, "no dip")]   # 5-session move into the pick
log = logging.getLogger("bt_pick")


def r_(x, nd=4):
    try:
        x = float(x)
        return round(x, nd) if math.isfinite(x) else None
    except Exception:
        return None


def hist_counts(x) -> list[int]:
    x = np.clip(np.asarray(x, float), EDGES[0] + 1e-9, EDGES[-1] - 1e-9)
    return np.histogram(x, bins=EDGES)[0].tolist()


def nw_t(x: np.ndarray, lag: int = 21) -> float:
    """Newey–West t-stat of the mean (overlapping 21-session trades are autocorrelated)."""
    x = np.asarray(x, float)
    x = x[np.isfinite(x)]
    n = len(x)
    if n < 50:
        return float("nan")
    e = x - x.mean()
    s = e @ e / n
    for k in range(1, lag + 1):
        s += 2 * (1 - k / (lag + 1)) * (e[k:] @ e[:-k]) / n
    return float(x.mean() / math.sqrt(s / n))


def summ(r) -> dict:
    r = np.asarray([v for v in r if v is not None and np.isfinite(v)], float)
    if not len(r):
        return {"n": 0}
    return {"n": int(len(r)), "win": r_((r > 0).mean()), "avg": r_(r.mean()), "median": r_(np.median(r)),
            "p10": r_(np.percentile(r, 10)), "p90": r_(np.percentile(r, 90)), "worst": r_(r.min()), "best": r_(r.max())}


def curve_stats(eq: pd.Series) -> dict:
    eq = eq.dropna()
    yrs = (eq.index[-1] - eq.index[0]).days / 365.25
    d = eq.pct_change().dropna()
    dd = eq / eq.cummax() - 1
    return {"cagr": r_(eq.iloc[-1] ** (1 / yrs) - 1), "vol": r_(d.std() * math.sqrt(252)),
            "sharpe": r_(d.mean() / d.std() * math.sqrt(252)) if d.std() > 0 else None, "max_dd": r_(dd.min()),
            "total": r_(eq.iloc[-1] - 1)}


def run(start: str = "2003-01-02", hist=None, P=None, rules: dict | None = None, out_path: Path | None = None) -> dict:
    global RULES
    RULES = dict(PK.RULES, **(rules or {}))
    t0 = time.time()
    spec = LV.load_spec()
    if hist is None:
        hist = R.load_history(ROOT / "data" / "history", start="1998-01-01")
    if P is None:
        P = PK.panels(hist, spec)
    dates = hist.dates
    n = len(dates)
    spy_c = hist.bench["SPY"].reindex(dates).ffill()
    raw = pd.read_parquet(ROOT / "data" / "history" / "benchmarks.parquet")
    raw = raw[raw["ticker"] == "SPY"].assign(date=lambda d: pd.to_datetime(d["date"])).set_index("date").sort_index()
    spy_o = (spy_c * (raw["open"] / raw["close"]).reindex(dates)).fillna(spy_c)
    exposure = R.exposure_series(spy_c.dropna(), spec).reindex(dates).ffill().fillna(1.0)

    O, H, L, C = (hist.open_adj.values, hist.high.values, hist.low.values, hist.adj_close.values)
    cols = list(hist.adj_close.columns)
    score = P["score"].values
    ret5 = P["ret5"].values
    atr = P["atr"].values
    elig = P["elig"].values
    i0 = int(dates.searchsorted(pd.Timestamp(start)))
    hz = PK.HORIZON

    # random-member baseline: every eligible name, open(i+1) → close(i+21), no stop
    with np.errstate(invalid="ignore", divide="ignore"):
        fwd = np.full(C.shape, np.nan)
        fwd[: n - hz] = C[hz:] / O[1: n - hz + 1] - 1 - 2 * COST
    def picks_for(i, held):
        srow = score[i]
        ok = np.isfinite(srow)
        if not ok.any():
            return None, []
        order = list(np.argsort(-np.where(ok, srow, -np.inf))[: int(ok.sum())])
        top10 = order[:10]
        if RULES["skip_held"]:
            order = [j for j in order if cols[j] not in held]
        return (order[0] if order else None), top10

    def sim(j, s, i, stop=True, target=False):
        st = RULES["stop_atr"] if RULES["stop_atr"] else PK.STOP_ATR
        use = stop and RULES["stop_atr"] is not None
        return PK.simulate_trade(O[:, j], H[:, j], L[:, j], C[:, j], s, st, atr[i, j], use_stop=use, use_target=target, cost=COST)

    rows = []
    daily = np.zeros(n)          # 21-slot portfolio daily return (gated pick)
    daily_ug = np.zeros(n)       # ungated
    daily_t10 = np.zeros(n)
    held_until: dict[str, int] = {}
    nofill = 0
    for i in range(i0, n - 1):
        s = i + 1
        held = {t for t, e in held_until.items() if e >= s}
        j, order = picks_for(i, held)
        if j is None:
            continue
        lim = C[i, j] + PK.LIMIT_ATR * atr[i, j]          # the plan's buy limit: no fill if the open gaps above it
        if np.isfinite(O[s, j]) and O[s, j] > lim:
            nofill += 1
            continue
        res = sim(j, s, i)
        if res is None:
            continue
        ret, ex, reason, path = res
        gated = exposure.iloc[i] >= 0.5
        alt_stop = PK.simulate_trade(O[:, j], H[:, j], L[:, j], C[:, j], s, PK.STOP_ATR, atr[i, j], cost=COST)
        ns = PK.simulate_trade(O[:, j], H[:, j], L[:, j], C[:, j], s, PK.STOP_ATR, atr[i, j], use_stop=False, cost=COST)
        tg = PK.simulate_trade(O[:, j], H[:, j], L[:, j], C[:, j], s, PK.STOP_ATR, atr[i, j], use_target=True, cost=COST)
        t10 = []
        for jj in order:
            rr = sim(jj, s, i)
            if rr is not None:
                t10.append(rr[0])
                _accumulate(daily_t10, rr[3], s, len(order))
        end = min(s + hz - 1, n - 1)
        spy_r = spy_c.iloc[end] / spy_o.iloc[s] - 1 - 2 * COST
        rnd = np.nanmean(np.where(elig[i], fwd[i], np.nan)) if reason != "open" else np.nan
        _accumulate(daily_ug, path, s, 1)
        if gated:
            _accumulate(daily, path, s, 1)
            held_until[cols[j]] = ex
        rows.append({"date": dates[i], "ticker": cols[j], "score": float(score[i, j]), "dip5": float(ret5[i, j]), "gated": bool(gated), "exposure": float(exposure.iloc[i]),
                     "ret": ret, "reason": reason, "days": ex - s + 1, "stop_2atr": alt_stop[0] if alt_stop else np.nan,
                     "no_stop": ns[0] if ns else np.nan, "target_2r": tg[0] if tg else np.nan,
                     "top10": float(np.mean(t10)) if t10 else np.nan, "spy": spy_r, "random": rnd,
                     "mae": float(min(path)), "mfe": float(max(path))})
    tr = pd.DataFrame(rows)
    TRADES.parent.mkdir(parents=True, exist_ok=True)
    tr.to_csv(TRADES, index=False, float_format="%.5f")
    log.info("%d signal days, %d gated-on (%.0fs)", len(tr), int(tr["gated"].sum()), time.time() - t0)

    done = tr[tr["reason"] != "open"]
    g = done[done["gated"]]
    excess = (g["ret"] - g["spy"]).values
    # 21-slot staggered portfolios (each day's pick gets 1/21 of capital; cash when gated off or stopped out)
    idx = dates[i0:]
    eq = pd.Series(np.cumprod(1 + daily[i0:] / hz), index=idx)
    eq_ug = pd.Series(np.cumprod(1 + daily_ug[i0:] / hz), index=idx)
    eq_t10 = pd.Series(np.cumprod(1 + daily_t10[i0:] / hz), index=idx)
    spy_eq = (spy_c.iloc[i0:] / spy_c.iloc[i0])
    ew = np.nanmean(np.where(elig[:-1], C[1:] / C[:-1] - 1, np.nan), axis=1)
    ew_eq = pd.Series(np.cumprod(1 + np.nan_to_num(np.r_[0, ew][i0:])), index=idx)
    me = eq.resample("ME").last()
    curve = [{"date": str(d.date())[:7], "pick": r_(eq.loc[:d].iloc[-1], 4), "ungated": r_(eq_ug.loc[:d].iloc[-1], 4),
              "top10": r_(eq_t10.loc[:d].iloc[-1], 4), "spy": r_(spy_eq.loc[:d].iloc[-1], 4), "equal_weight": r_(ew_eq.loc[:d].iloc[-1], 4)}
             for d in me.index]

    by_year = []
    for y, gg in g.groupby(g["date"].dt.year):
        ey = eq[eq.index.year == y]
        sy = spy_eq[spy_eq.index.year == y]
        prev_e = eq[eq.index.year < y]
        prev_s = spy_eq[spy_eq.index.year < y]
        by_year.append({"year": int(y), "n": int(len(gg)), "pick": r_(gg["ret"].mean()), "spy": r_(gg["spy"].mean()),
                        "win": r_((gg["ret"] > 0).mean()),
                        "port": r_(ey.iloc[-1] / (prev_e.iloc[-1] if len(prev_e) else 1.0) - 1),
                        "spy_year": r_(sy.iloc[-1] / (prev_s.iloc[-1] if len(prev_s) else sy.iloc[0]) - 1)})
    by_score = []
    for lo, hi, lab in BUCKETS:
        b = g[(g["dip5"] >= lo) & (g["dip5"] < hi)]
        if len(b) < 30:
            continue
        by_score.append({"bucket": lab, "lo": lo, "hi": hi, "key": "dip5", **summ(b["ret"]), "avg_spy": r_(b["spy"].mean()),
                         "stop_hit": r_((b["reason"] == "stop").mean()), "hist": {"edges": EDGES, "counts": hist_counts(b["ret"])}})
    recent = []
    for _, r in tr.tail(63).iloc[::-1].iterrows():
        recent.append({"date": str(r["date"].date()), "ticker": r["ticker"], "score": r_(r["score"], 1), "ret": r_(r["ret"]),
                       "spy": r_(r["spy"]), "reason": r["reason"], "gated": bool(r["gated"]), "days": int(r["days"])})
    periods = []
    for a, b in (("2003", "2014"), ("2015", "2026")):
        p = g[(g["date"] >= a) & (g["date"] <= f"{b}-12-31")]
        if len(p):
            periods.append({"period": f"{a}–{b[2:]}", "role": "development" if a == "2003" else "holdout", "n": int(len(p)), "pick": r_(p["ret"].mean()), "spy": r_(p["spy"].mean()),
                            "random": r_(p["random"].mean()), "win": r_((p["ret"] > 0).mean())})
    out = {
        "from": str(dates[i0].date()), "to": str(done["date"].max().date()), "n": int(len(g)), "n_days": int(len(done)),
        "gated_off_share": r_(1 - done["gated"].mean(), 3), "no_fill": int(nofill),
        "rules": " · ".join(x for x in ["Top score each day", "skip names already held" if RULES["skip_held"] else None, "buy next open (limit close + 0.25 ATR)",
                                  f"stop {RULES['stop_atr']:g}×ATR" if RULES["stop_atr"] else "no stop", "exit after 21 sessions", "10 bps/side",
                                  "no trade when the market gate is off"] if x),
        "base": {**summ(g["ret"]), "avg_spy": r_(g["spy"].mean()), "avg_random": r_(g["random"].mean()), "stop_hit": r_((g["reason"] == "stop").mean()),
                 "hist": {"edges": EDGES, "counts": hist_counts(g["ret"])}},
        "pick": {**summ(g["ret"]), "stop_hit": r_((g["reason"] == "stop").mean()), "avg_days": r_(g["days"].mean(), 1),
                 "mae_med": r_(g["mae"].median()), "mfe_med": r_(g["mfe"].median())},
        "spy": summ(g["spy"]), "random": summ(g["random"]), "top10": summ(g["top10"]), "no_stop": summ(g["no_stop"]),
        "target_2r": summ(g["target_2r"]), "stop_2atr": summ(g["stop_2atr"]), "ungated": summ(done["ret"]), "rules_used": RULES,
        "excess": {**summ(excess), "t_stat": r_(nw_t(excess), 2)},
        "excess_vs_random": {**summ((g["ret"] - g["random"]).values), "t_stat": r_(nw_t((g["ret"] - g["random"]).values), 2)},
        "t_stat": r_(nw_t(excess), 2),
        "hist": {"edges": EDGES, "pick": hist_counts(g["ret"]), "spy": hist_counts(g["spy"]), "random": hist_counts(g["random"].dropna())},
        "portfolio": {"pick": curve_stats(eq), "ungated": curve_stats(eq_ug), "top10": curve_stats(eq_t10), "spy": curve_stats(spy_eq),
                      "equal_weight": curve_stats(ew_eq)},
        "by_year": by_year, "by_score": by_score, "periods": periods, "curve": curve, "recent": recent,
        "caveats": ["No edge over SPY is statistically proven (t < 2) after 14 logged trials; treat picks as a disciplined way to hold one uptrending stock, not as alpha.",
                    "Live gates (earnings, news, analysts, data) are not in the backtest — they can only remove trades.",
                    "Fills at the open with no slippage beyond 10 bps; stops fill at the stop unless the open gaps through.",
                    "Membership is point-in-time; delisted names are included until their last print.",
                    "Trial 1 rules were pre-registered (docs/research/05); trial 2 changes and every variant tried are logged in docs/research/06."],
        "trials": json.loads((ROOT / "research" / "pick_trials.json").read_text()) if (ROOT / "research" / "pick_trials.json").exists() else [],
        "verdict": {"edge_vs_spy": "not significant", "t_spy": r_(nw_t(excess), 2), "holdout_vs_spy": None},
        "generated_at": pd.Timestamp.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    ho = next((p for p in periods if p.get("role") == "holdout"), None)
    if ho:
        out["verdict"]["holdout_vs_spy"] = r_(ho["pick"] - ho["spy"])
        out["verdict"]["holdout_vs_random"] = r_(ho["pick"] - ho["random"])
    out["verdict"]["edge_vs_spy"] = "significant" if (out["t_stat"] or 0) >= 2 else "not significant"
    out_path = out_path or OUT
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, separators=(",", ":"), allow_nan=False))
    log.info("pick avg %.2f%% vs spy %.2f%% vs random %.2f%% · t=%.2f · CAGR %.1f%% vs %.1f%% (%.0fs)",
             100 * out["pick"]["avg"], 100 * out["spy"]["avg"], 100 * out["random"]["avg"], out["t_stat"],
             100 * out["portfolio"]["pick"]["cagr"], 100 * out["portfolio"]["spy"]["cagr"], time.time() - t0)
    return out


def _accumulate(daily: np.ndarray, path: list[float], s: int, k: int):
    """Add one trade's daily returns (mark-to-market path) into the slot-portfolio array, weighted 1/k, with costs."""
    prev = 1.0
    for m, v in enumerate(path):
        cur = 1 + v
        r = cur / prev - 1
        if m == 0:
            r -= COST
        if m == len(path) - 1:
            r -= COST
        if s + m < len(daily):
            daily[s + m] += r / k
        prev = cur


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2003-01-02")
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    run(a.start)
