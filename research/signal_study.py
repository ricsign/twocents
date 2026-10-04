"""Trial 2 — which single-stock signal deserves the daily pick? (dev 2003–2014 → choose; holdout 2015–data end → report once)

Why: trial 1 (the pre-registered composite) lost to a random S&P member on the full sample (see trial_log.md).
Candidates are fixed here, before any of them was run, and are all textbook signals with no tuned parameters:

    composite   the trial-1 score (baseline)
    ram         risk-adjusted 6m+12m momentum, skip 1m  (Barroso–Santa-Clara style scaling)
    resid_mom   12-1m residual momentum vs SPY, scaled by residual vol  (Blitz, Huij & Martens 2011)
    high52      close / 52-week high  (George & Hwang 2004)
    pullback    best momentum half, full uptrend (4/4), worst 5-day return  (short-term reversal inside momentum)
    low_vol     lowest 1y volatility among uptrend names  (Frazzini–Pedersen / Baker et al.)
    reversal    worst 21-day return among all eligible  (Jegadeesh 1990)

Each day: rank eligible members, buy the next open, hold 21 sessions, 10 bps per side, no stop.
Metric: average excess over the equal-weighted eligible pool (= a random pick), HAC t (lag 21), for top-1 and top-10.
Selection rule (fixed in advance): the highest dev-period top-10 t-stat vs random; the holdout is then reported as-is.
"""
from __future__ import annotations

import json
import math
import pickle
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from engine import pick as PK
from engine import rotation as R
from engine import rotation_live as LV
from research.backtest_pick import nw_t

ROOT = Path(__file__).resolve().parent.parent
HZ, COST = 21, 0.001
DEV = ("2003-01-02", "2014-12-31")
HOLD = ("2015-01-01", "2026-12-31")


def signals(hist: R.History, P: dict) -> dict[str, pd.DataFrame]:
    c = hist.adj_close
    elig = P["elig"]
    lr = np.log(c).diff()
    spy = hist.bench["SPY"].reindex(c.index).ffill()
    m = np.log(spy).diff()
    # rolling 252d beta via moments
    w = 252
    mm = m.rolling(w, min_periods=200).mean()
    var_m = m.rolling(w, min_periods=200).var()
    cov = lr.mul(m, axis=0).rolling(w, min_periods=200).mean().sub(lr.rolling(w, min_periods=200).mean().mul(mm, axis=0)) * (w / (w - 1))
    beta = cov.div(var_m, axis=0).shift(21)               # beta known before the formation window ends
    resid = lr.sub(beta.mul(m, axis=0))
    rsum = resid.rolling(231, min_periods=180).sum().shift(21)   # t-252 .. t-21
    rstd = resid.rolling(231, min_periods=180).std().shift(21)
    resid_mom = rsum / rstd
    hi = hist.high.rolling(252, min_periods=200).max()
    high52 = c / hi
    ret5 = c / c.shift(5) - 1
    ret21 = c / c.shift(21) - 1
    pull_ok = elig & (P["trend"] == 4) & (P["mom_pct"] >= 0.5)
    up = elig & (P["trend"] >= 3)
    S = {
        "composite": P["score"],
        "ram": P["ram"].where(elig),
        "resid_mom": resid_mom.where(elig),
        "high52": high52.where(elig),
        "pullback": (-ret5).where(pull_ok),
        "low_vol": (-P["vol"]).where(up),
        "reversal": (-ret21).where(elig),
    }
    return S


def study(hist, P) -> dict:
    C, O = hist.adj_close.values, hist.open_adj.values
    n = len(C)
    fwd = np.full(C.shape, np.nan)
    with np.errstate(invalid="ignore", divide="ignore"):
        fwd[: n - HZ] = C[HZ:] / O[1: n - HZ + 1] - 1 - 2 * COST
    elig = P["elig"].values
    pool = np.nanmean(np.where(elig, fwd, np.nan), axis=1)
    spy = hist.bench["SPY"].reindex(hist.dates).ffill().values
    spy_f = np.full(n, np.nan)
    spy_f[: n - HZ] = spy[HZ:] / spy[: n - HZ] - 1
    dates = hist.dates
    out = {}
    for name, S in signals(hist, P).items():
        v = S.values
        top1 = np.full(n, np.nan)
        top10 = np.full(n, np.nan)
        for i in range(n - HZ):
            row = v[i]
            ok = np.isfinite(row) & np.isfinite(fwd[i])
            k = ok.sum()
            if k < 10:
                continue
            idx = np.where(ok)[0]
            order = idx[np.argsort(-row[idx])]
            top1[i] = fwd[i, order[0]]
            top10[i] = fwd[i, order[:10]].mean()
        res = {}
        for per, (a, b) in (("dev", DEV), ("holdout", HOLD)):
            msk = (dates >= a) & (dates <= b) & np.isfinite(top1) & np.isfinite(pool)
            e1, e10 = top1[msk] - pool[msk], top10[msk] - pool[msk]
            res[per] = {"n": int(msk.sum()), "top1": round(float(np.mean(top1[msk])), 5), "top10": round(float(np.mean(top10[msk])), 5),
                        "pool": round(float(np.mean(pool[msk])), 5), "spy": round(float(np.nanmean(spy_f[msk])), 5),
                        "top1_ex": round(float(e1.mean()), 5), "top1_t": round(nw_t(e1), 2), "top10_ex": round(float(e10.mean()), 5),
                        "top10_t": round(nw_t(e10), 2), "top1_win": round(float((top1[msk] > 0).mean()), 3)}
        out[name] = res
        print(f"{name:10s} DEV top1 {res['dev']['top1_ex']*100:+.2f}% t{res['dev']['top1_t']:+.2f} top10 {res['dev']['top10_ex']*100:+.2f}% t{res['dev']['top10_t']:+.2f} | "
              f"HOLD top1 {res['holdout']['top1_ex']*100:+.2f}% t{res['holdout']['top1_t']:+.2f} top10 {res['holdout']['top10_ex']*100:+.2f}% t{res['holdout']['top10_t']:+.2f}", flush=True)
    best = max(out, key=lambda k: out[k]["dev"]["top10_t"])
    return {"design": __doc__, "results": out, "chosen_on_dev": best}


if __name__ == "__main__":
    hist, P = pickle.load(open(sys.argv[1] if len(sys.argv) > 1 else "/tmp/hp_full.pkl", "rb"))
    r = study(hist, P)
    (ROOT / "research" / "output").mkdir(parents=True, exist_ok=True)
    (ROOT / "research" / "signal_study.json").write_text(json.dumps(r, indent=1))
    print("chosen on dev:", r["chosen_on_dev"])
