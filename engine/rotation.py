"""Rotation strategy core — shared by the research backtester and the live daily pipeline.

Everything here is a pure function of wide price panels (dates x tickers), so the daily job and
the 26-year backtest run *exactly* the same code path for signals, regime and selection.

Data model
----------
History.adj_close   dividend/split-adjusted close (returns, momentum, volatility)
History.close       raw close (price filters)
History.open_adj    adjusted open  = open * adj_close / close  (execution at the open)
History.member      point-in-time S&P 500 membership mask, lagged one session
History.bench       {symbol: adjusted close Series} for SPY, ^GSPC, ^IRX, ...

Strategy spec (a plain dict, see DEFAULT_SPEC) — kept deliberately small:
    signal      what to rank on            (ram = MSCI-style risk-adjusted momentum)
    screen      eligibility filters        (price, history, optional frog-in-the-pan)
    portfolio   n holdings, rank buffer, weighting
    rebalance   cadence and tranches
    regime      SPY trend ensemble -> equity exposure in {0, .25, .5, .75, 1}
"""
from __future__ import annotations

import copy
import logging
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

log = logging.getLogger(__name__)

DEFAULT_SPEC: dict = {
    "name": "ram30_trend",
    "signal": {"type": "ram", "lookbacks": [126, 252], "skip": 21, "vol_window": 252, "winsor": 3.0},
    "screen": {"min_price": 5.0, "min_history": 252, "fip": False, "fip_pool": 100, "fip_keep": 50},
    "portfolio": {"n": 30, "buffer": 60, "weighting": "equal", "vol_cap": [0.5, 2.0]},
    "rebalance": {"freq": "M", "tranches": 1},
    "regime": {"type": "ensemble", "panic_halve": True, "sma_long": 200, "sma_10m": 210, "tsmom": 252, "cross": [63, 252]},
    "costs": {"bps_per_side": 10.0},
    "delisting": {"terminal_return": 0.0},
}


# Ticker changes where Yahoo keeps the whole history under the NEW symbol (same company, continuous series).
# The old symbol returns nothing, so its membership spell is re-pointed at the new one. Acquisitions and
# bankruptcies are NOT listed: their history is simply gone from free data and is counted in coverage.csv.
RENAMES = {
    "FB": "META", "ANTM": "ELV", "WLTW": "WTW", "FI": "FISV", "ABC": "COR", "PKI": "RVTY", "RE": "EG", "FLT": "CPAY",
    "BK": "BNY", "GPS": "GAP", "CDAY": "DAY",
    "PCLN": "BKNG", "TMK": "GL", "HRS": "LHX", "BBT": "TFC", "CTL": "LUMN", "SYMC": "NLOK", "NLOK": "GEN", "ARNC": "HWM",
    "COG": "CTRA", "LB": "BBWI", "HFC": "DINO", "FBHS": "FBIN", "CBS": "VIAC", "VIAC": "PARA", "PARA": "PSKY", "DISCA": "WBD",
    "MYL": "VTRS", "UTX": "RTX", "DWDP": "DD", "ADS": "BFH", "SQ": "XYZ", "KORS": "CPRI", "HCP": "PEAK", "PEAK": "DOC",
    "HCN": "WELL", "BLL": "BALL", "DPS": "KDP", "BHGE": "BKR", "MMC": "MRSH",
}


def resolve_rename(t: str) -> str:
    seen = set()
    while t in RENAMES and RENAMES[t] != t and t not in seen:
        seen.add(t)
        t = RENAMES[t]
    return t


def apply_renames(spells: pd.DataFrame, have: set[str]) -> pd.DataFrame:
    """Re-point spells of renamed tickers at the symbol that carries the history, when the old one has none."""
    out = spells.copy()
    for old in list(RENAMES):
        new = resolve_rename(old)
        if old != new and old not in have and new in have:
            out.loc[out["ticker"] == old, "ticker"] = new
    return out


def make_spec(**overrides) -> dict:
    """Deep-merge overrides like {"portfolio": {"n": 20}} into DEFAULT_SPEC."""
    spec = copy.deepcopy(DEFAULT_SPEC)
    for k, v in overrides.items():
        if isinstance(v, dict) and isinstance(spec.get(k), dict):
            spec[k].update(v)
        else:
            spec[k] = v
    return spec


# --------------------------------------------------------------------------- data
@dataclass
class History:
    adj_close: pd.DataFrame
    close: pd.DataFrame
    open_adj: pd.DataFrame
    volume: pd.DataFrame
    member: pd.DataFrame
    bench: dict = field(default_factory=dict)
    spells: pd.DataFrame | None = None
    high: pd.DataFrame | None = None      # adjusted high (same factor as the close)
    low: pd.DataFrame | None = None       # adjusted low

    @property
    def dates(self) -> pd.DatetimeIndex:
        return self.adj_close.index

    @property
    def tickers(self) -> list[str]:
        return list(self.adj_close.columns)


def clean_open(open_adj: pd.DataFrame, adj: pd.DataFrame) -> pd.DataFrame:
    """Reject bad opening prints using only information known at the open (the previous close):
    missing, non-positive, or more than 50% away from the prior close -> use the prior close."""
    prev = adj.shift(1)
    bad = open_adj.isna() | (open_adj <= 0) | ((open_adj / prev - 1).abs() > 0.5)
    return open_adj.where(~bad, prev).where(adj.notna())


def load_membership(path: Path) -> pd.DataFrame:
    m = pd.read_csv(path)
    m["ticker"] = m["ticker"].astype(str).str.strip().str.upper().str.replace(".", "-", regex=False)
    m["start_date"] = pd.to_datetime(m["start_date"])
    m["end_date"] = pd.to_datetime(m["end_date"])
    return m[["ticker", "start_date", "end_date"]]


def membership_mask(spells: pd.DataFrame, dates: pd.DatetimeIndex, tickers: list[str], lag_days: int = 1) -> pd.DataFrame:
    """True where ticker was an index member on that date (membership known with a one-session lag)."""
    col = {t: i for i, t in enumerate(tickers)}
    arr = np.zeros((len(dates), len(tickers)), dtype=bool)
    end_default = dates[-1] + pd.Timedelta(days=1)
    for r in spells.itertuples(index=False):
        j = col.get(r.ticker)
        if j is None:
            continue
        s = dates.searchsorted(r.start_date)
        e = dates.searchsorted(r.end_date if pd.notna(r.end_date) else end_default)
        if e > s:
            arr[s:e, j] = True
    mask = pd.DataFrame(arr, index=dates, columns=tickers)
    if lag_days:
        mask = mask.shift(lag_days, fill_value=False)
    return mask


def drop_reused_tickers(spells: pd.DataFrame, adj: pd.DataFrame, grace_days: int = 365) -> pd.DataFrame:
    """A symbol whose price series starts more than a year after a membership spell began is a *different*
    company that later reused the ticker (AAL 1996 vs AAL 2013, CNC Conseco vs Centene). Blank such *ended* spells
    so the newcomer's prices are never attributed to the old member. Current members are kept (FOX, IR: the same
    entity continuing after a restructuring that reset Yahoo's history)."""
    first = adj.apply(lambda s: s.first_valid_index())
    keep = []
    dropped = []
    for r in spells.itertuples(index=False):
        f = first.get(r.ticker)
        if f is not None and pd.notna(f) and r.start_date < adj.index[0] - pd.Timedelta(days=30):
            keep.append(True)  # spell began before our data window: cannot judge, keep
        elif f is not None and pd.notna(f) and pd.notna(r.end_date) and (f - r.start_date).days > grace_days:
            # ended spell whose prices only begin long after it started: ambiguous at best, a different company at worst
            keep.append(False)
            dropped.append(f"{r.ticker}({r.start_date.year}-{r.end_date.year if pd.notna(r.end_date) else 'now'})")
        else:
            keep.append(True)
    if dropped:
        log.info("reused tickers: blanked %d spells whose prices start >1y after membership began: %s", len(dropped), ", ".join(dropped[:20]))
    return spells[np.array(keep)]


def spell_window_mask(spells: pd.DataFrame, dates: pd.DatetimeIndex, tickers: list[str], before_days: int, after_days: int) -> pd.DataFrame:
    padded = spells.copy()
    padded["start_date"] = padded["start_date"] - pd.Timedelta(days=before_days)
    padded["end_date"] = padded["end_date"] + pd.Timedelta(days=after_days)
    return membership_mask(padded, dates, tickers, lag_days=0)


def corrupt_series(adj: pd.DataFrame, spells: pd.DataFrame, dates: pd.DatetimeIndex, up: float = 3.0, down: float = -0.85, max_down: int = 3) -> list[str]:
    """Tickers whose adjusted series shows a > +300% day, or three or more < -85% days, inside a membership window
    (+40 sessions). Real S&P 500 members never do the first and only bankruptcies do the second once; the rest is
    Yahoo's corrupted history for recycled symbols (CBE, MEE, TIE, CFC, BOL, MCIC ...)."""
    win = membership_mask(spells, dates, list(adj.columns), lag_days=0)
    ext = win.copy()
    for k in range(1, 41):
        ext = ext | win.shift(k, fill_value=False)
    r = adj.pct_change(fill_method=None).where(ext)
    n_up = (r > up).sum()
    n_down = (r < down).sum()
    # spike-and-revert: a > +40% day followed within three sessions by a < -30% day (or the reverse) is a data
    # artefact, not a market move; three or more of them and the series is untrustworthy (EP, UVN, GR, MNST ...)
    big_up, big_dn = r > 0.4, r < -0.3
    dn_next = big_dn.shift(-1, fill_value=False) | big_dn.shift(-2, fill_value=False) | big_dn.shift(-3, fill_value=False)
    up_next = big_up.shift(-1, fill_value=False) | big_up.shift(-2, fill_value=False) | big_up.shift(-3, fill_value=False)
    flips = ((big_up & dn_next) | (big_dn & up_next)).sum()
    return list(adj.columns[(n_up > 0) | (n_down >= max_down) | (flips >= 3)])


def null_bad_prints(adj: pd.DataFrame, close: pd.DataFrame, open_adj: pd.DataFrame, up: float = 1.0, down: float = -0.6, passes: int = 3):
    """Blank single-day prints that move more than +100% / -60% against the last valid price. A spike that reverts
    disappears; a genuine crash is merely booked one session later (the next valid print is compared with the
    price before the gap). Runs a few passes so a two-day glitch is caught too."""
    total = 0
    for _ in range(passes):
        r = adj / adj.ffill().shift(1) - 1
        bad = (r > up) | (r < down)
        n = int(bad.sum().sum())
        if n == 0:
            break
        total += n
        adj = adj.mask(bad)
        close = close.mask(bad)
        open_adj = open_adj.mask(bad)
    return adj, close, open_adj, total


def load_history(hist_dir: Path, start: str | None = "1998-01-01", end: str | None = None,
                 min_rows: int = 60) -> History:
    """Read data/history/*.parquet into wide panels restricted to ever-members of the index."""
    hist_dir = Path(hist_dir)
    files = sorted(f for f in hist_dir.glob("prices_*.parquet") if not f.name.endswith(".tmp.parquet") and f.name != "prices_tail.parquet")
    if not files:
        raise FileNotFoundError(f"no prices_*.parquet in {hist_dir}")
    tail = hist_dir / "prices_tail.parquet"
    if tail.exists():
        files.append(tail)  # last => wins in drop_duplicates(keep="last")
    frames = [pd.read_parquet(f) for f in files]
    long = pd.concat(frames, ignore_index=True)
    long["date"] = pd.to_datetime(long["date"])
    if start:
        long = long[long["date"] >= pd.Timestamp(start)]
    if end:
        long = long[long["date"] <= pd.Timestamp(end)]
    # ticker renames (FB -> META ...): fold the old symbol's rows into the new one; the new symbol's rows win
    long["is_new"] = ~long["ticker"].isin(RENAMES.keys())
    long["ticker"] = long["ticker"].map(resolve_rename)
    long = long.sort_values(["is_new"]).drop_duplicates(["date", "ticker"], keep="last").drop(columns=["is_new"])
    counts = long.groupby("ticker").size()
    keep = counts[counts >= min_rows].index
    if len(keep) < len(counts):
        log.info("min_rows=%d dropped %d short series: %s", min_rows, len(counts) - len(keep), ", ".join(sorted(set(counts.index) - set(keep))[:15]))
    long = long[long["ticker"].isin(keep)]

    def wide(col):
        return long.pivot(index="date", columns="ticker", values=col).sort_index()

    adj = wide("adj_close")
    close = wide("close")
    opn = wide("open")
    vol = wide("volume")
    # adjusted open: the same adjustment factor as the close of that day
    factor = (adj / close).replace([np.inf, -np.inf], np.nan)
    open_adj = (opn * factor)
    open_adj = clean_open(open_adj, adj)
    dates = adj.index
    gaps = pd.Series(dates[1:] - dates[:-1], index=dates[1:])
    if len(gaps) and gaps.max() > pd.Timedelta(days=10):
        raise ValueError(f"price history has a {gaps.max().days}-day hole ending {gaps.idxmax().date()} — a prices_YYYY.parquet file is missing")

    spells = load_membership(hist_dir / "sp500_membership.csv") if (hist_dir / "sp500_membership.csv").exists() else None
    if spells is not None:
        spells = apply_renames(spells, set(adj.columns))
        spells = drop_reused_tickers(spells, adj)
        # keep prices only around membership spells (signal warm-up before, a selling window after): everything
        # else is irrelevant to a members-only strategy and is where Yahoo's recycled-symbol garbage lives
        win = spell_window_mask(spells, dates, list(adj.columns), before_days=420, after_days=90)
        adj, close, open_adj, vol = adj.where(win), close.where(win), open_adj.where(win), vol.where(win)
        bad = corrupt_series(adj, spells, dates)
        if bad:
            log.warning("dropping %d series with impossible moves inside their membership window: %s", len(bad), ", ".join(sorted(bad)))
            adj, close, open_adj, vol = (f.drop(columns=bad) for f in (adj, close, open_adj, vol))
        adj, close, open_adj, n_bad = null_bad_prints(adj, close, open_adj)
        if n_bad:
            log.info("blanked %d single-day prints moving > +100%% or < -60%% (real crashes are deferred one session, bad prints vanish)", n_bad)
        member = membership_mask(spells, dates, list(adj.columns))
    else:
        member = pd.DataFrame(True, index=dates, columns=adj.columns)

    bench = {}
    bpath = hist_dir / "benchmarks.parquet"
    if bpath.exists():
        b = pd.read_parquet(bpath)
        b["date"] = pd.to_datetime(b["date"])
        for t, g in b.groupby("ticker"):
            s = g.set_index("date")["adj_close"].sort_index()
            s = s[~s.index.duplicated(keep="last")]
            bench[t] = s
    log.info("history: %d dates x %d tickers (%s → %s), %d benchmarks", len(dates), adj.shape[1], dates[0].date(), dates[-1].date(), len(bench))
    # adjusted high/low on the surviving columns; clipped so the bar always contains its open and close
    hi = (wide("high") * factor).reindex(index=dates, columns=adj.columns)
    lo = (wide("low") * factor).reindex(index=dates, columns=adj.columns)
    ok = adj.notna()
    hi = hi.where(ok).combine(adj, np.fmax).combine(open_adj, np.fmax).where(ok)
    lo = lo.where(ok).combine(adj, np.fmin).combine(open_adj, np.fmin).where(ok)
    return History(adj_close=adj, close=close, open_adj=open_adj, volume=vol, member=member, bench=bench, spells=spells, high=hi, low=lo)


# --------------------------------------------------------------------------- signals
def _zscore_rows(x: pd.DataFrame, winsor: float | None = 3.0) -> pd.DataFrame:
    """Cross-sectional z-score. The raw variable is winsorised at the 1st/99th percentiles first so a
    single outlier cannot inflate the dispersion, then the z-scores are clipped at +/- winsor."""
    lo, hi = x.quantile(0.01, axis=1), x.quantile(0.99, axis=1)
    xw = x.clip(lower=lo, upper=hi, axis=0)
    mu = xw.mean(axis=1)
    sd = xw.std(axis=1, ddof=0).replace(0, np.nan)
    z = xw.sub(mu, axis=0).div(sd, axis=0)
    if winsor:
        z = z.clip(-winsor, winsor)
    return z


def total_return(adj: pd.DataFrame, lookback: int, skip: int = 0) -> pd.DataFrame:
    """Return from t-lookback to t-skip (both in sessions)."""
    return adj.shift(skip) / adj.shift(lookback) - 1


def realised_vol(adj: pd.DataFrame, window: int) -> pd.DataFrame:
    r = np.log(adj).diff()
    return r.rolling(window, min_periods=int(window * 0.8)).std() * np.sqrt(252)


def frog_in_pan(adj: pd.DataFrame, lookback: int = 252, skip: int = 21) -> pd.DataFrame:
    """Information discreteness (Da, Gurun & Warachka): sign(ret) * (%neg - %pos). Lower = smoother path."""
    r = adj.pct_change(fill_method=None)
    win = lookback - skip
    pos = (r > 0).astype(float).rolling(win, min_periods=int(win * 0.8)).sum().shift(skip)
    neg = (r < 0).astype(float).rolling(win, min_periods=int(win * 0.8)).sum().shift(skip)
    n = (pos + neg).replace(0, np.nan)
    ret = total_return(adj, lookback, skip)
    return np.sign(ret) * (neg - pos) / n


def clenow_slope(adj: pd.DataFrame, window: int = 90) -> pd.DataFrame:
    """Annualised exponential-regression slope x R^2 over `window` sessions (Clenow, Stocks on the Move)."""
    y = np.log(adj)
    n = window
    k = pd.Series(np.arange(len(y), dtype=float), index=y.index)
    y = y.ffill(limit=5)  # a lone missing print must not blank a whole window
    ky = y.mul(k, axis=0)
    A = ky.rolling(n, min_periods=n).sum()
    B = y.rolling(n, min_periods=n).sum()
    start = (k - n + 1)
    S_iy = A - B.mul(start, axis=0)  # sum over the window of i * y_i with i = 0..n-1
    mean_i = (n - 1) / 2.0
    var_i = (n * n - 1) / 12.0
    mean_y = B / n
    cov = S_iy / n - mean_i * mean_y
    slope = cov / var_i
    var_y = y.rolling(n, min_periods=n).var(ddof=0)
    r2 = (slope ** 2 * var_i / var_y.replace(0, np.nan)).clip(0, 1)
    ann = np.exp(slope * 252) - 1
    return ann * r2


def compute_scores(hist: History, spec: dict, rf_daily: pd.Series | None = None) -> pd.DataFrame:
    """Cross-sectional score (higher = better) for every date, NaN where ineligible."""
    adj = hist.adj_close
    sg, sc = spec["signal"], spec["screen"]
    elig = eligibility(hist, spec)
    typ = sg["type"]
    if typ == "ram":
        vol = realised_vol(adj, sg["vol_window"])
        parts = []
        for lb in sg["lookbacks"]:
            ret = total_return(adj, lb, sg["skip"])
            if rf_daily is not None:
                rf_cum = (1 + rf_daily.reindex(adj.index).fillna(0)).rolling(lb - sg["skip"]).apply(np.prod, raw=True).shift(sg["skip"]) - 1
                ret = ret.sub(rf_cum, axis=0)
            parts.append(_zscore_rows((ret / vol).where(elig), sg["winsor"]))
        score = sum(parts) / len(parts)
    elif typ == "mom":
        score = _zscore_rows(total_return(adj, sg["lookbacks"][0], sg["skip"]).where(elig), sg["winsor"])
    elif typ == "mom_blend":
        parts = [_zscore_rows(total_return(adj, lb, sg["skip"]).where(elig), sg["winsor"]) for lb in sg["lookbacks"]]
        score = sum(parts) / len(parts)
    elif typ == "clenow":
        score = _zscore_rows(clenow_slope(adj, sg.get("window", 90)).where(elig), sg["winsor"])
    elif typ == "high52":
        hi = adj.rolling(252, min_periods=200).max()
        score = _zscore_rows((adj / hi).where(elig), sg["winsor"])
    elif typ == "sharpe_mom":
        ret = total_return(adj, sg["lookbacks"][0], sg["skip"])
        vol = realised_vol(adj, sg["vol_window"])
        score = _zscore_rows((ret / vol).where(elig), sg["winsor"])
    else:
        raise ValueError(f"unknown signal type {typ}")
    score = score.where(elig)
    if sc.get("fip"):
        # keep the smoothest `fip_keep` of the top `fip_pool` by score; others get -inf-ish
        fip = frog_in_pan(adj, max(sg["lookbacks"]), sg["skip"])
        rank = score.rank(axis=1, ascending=False, method="first")
        in_pool = rank <= sc["fip_pool"]
        fip_rank = fip.where(in_pool).rank(axis=1, ascending=True, method="first")
        keep = fip_rank <= sc["fip_keep"]
        # pool names that failed the smoothness screen are demoted below the whole pool; names outside the pool are untouched
        score = score.where(keep | ~in_pool, score - 10.0)
    return score


def eligibility(hist: History, spec: dict) -> pd.DataFrame:
    sc = spec["screen"]
    adj = hist.adj_close
    hist_days = adj.notna().rolling(sc["min_history"], min_periods=1).sum()
    ok = hist.member & adj.notna() & (hist.close >= sc["min_price"]) & (hist_days >= sc["min_history"] * 0.95)
    # stale series (no print for 5+ sessions) are not tradable
    stale = adj.isna().rolling(5, min_periods=1).sum() >= 5
    return ok & ~stale


# --------------------------------------------------------------------------- regime
def trend_rules(spy: pd.Series, spec: dict) -> pd.DataFrame:
    """Four price-trend rules on the index, each True = risk-on."""
    rg = spec["regime"]
    c = spy.dropna()
    rules = pd.DataFrame(index=c.index)
    rules["sma200"] = c > c.rolling(rg["sma_long"]).mean()
    rules["sma10m"] = c > c.rolling(rg["sma_10m"]).mean()
    rules["tsmom12"] = c / c.shift(rg["tsmom"]) - 1 > 0
    f, s = rg["cross"]
    rules["cross"] = c.rolling(f).mean() > c.rolling(s).mean()
    return rules


def exposure_series(spy: pd.Series, spec: dict) -> pd.Series:
    """Equity exposure 0..1 from the trend ensemble (+ optional panic halving)."""
    rg = spec["regime"]
    typ = rg["type"]
    c = spy.dropna()
    if typ == "none":
        return pd.Series(1.0, index=c.index)
    rules = trend_rules(c, spec)
    if typ == "sma200":
        exp = rules["sma200"].astype(float)
    elif typ == "sma10m":
        exp = rules["sma10m"].astype(float)
    elif typ == "tsmom":
        exp = rules["tsmom12"].astype(float)
    elif typ == "ensemble":
        exp = rules.mean(axis=1)
    else:
        raise ValueError(typ)
    # warm-up: before the longest window is available, assume risk-on
    exp = exp.where(rules.notna().all(axis=1) & (np.arange(len(c)) >= max(rg["sma_long"], rg["sma_10m"], rg["tsmom"], rg["cross"][1])), 1.0)
    if rg.get("panic_halve"):
        vol = np.log(c).diff().rolling(126).std() * np.sqrt(252)
        pct = vol.expanding(min_periods=756).apply(lambda x: (x[:-1] < x[-1]).mean() if len(x) > 1 else np.nan, raw=True)
        panic = (exp <= 0.5) & (pct >= 0.8)
        exp = exp.where(~panic, exp * 0.5)
    return exp


# --------------------------------------------------------------------------- selection
def select_holdings(scores: pd.Series, current: list[str], n: int, buffer: int) -> tuple[list[str], pd.Series]:
    """Rank-buffer selection: keep current names still ranked <= buffer, fill to n with the best new names."""
    s = scores.dropna().sort_values(ascending=False)
    ranks = pd.Series(np.arange(1, len(s) + 1), index=s.index)
    keep = [t for t in current if t in ranks.index and ranks[t] <= buffer]
    slots = max(0, n - len(keep))
    new = [t for t in s.index if t not in keep][:slots]
    return keep + new, ranks


def target_weights(holdings: list[str], exposure: float, spec: dict, vol_row: pd.Series | None = None) -> pd.Series:
    if not holdings:
        return pd.Series(dtype=float)
    pf = spec["portfolio"]
    w = pd.Series(1.0, index=holdings)
    if pf["weighting"] == "inv_vol" and vol_row is not None:
        v = vol_row.reindex(holdings).astype(float)
        v = v.fillna(v.median()).clip(lower=1e-4)
        w = 1.0 / v
        w = w / w.sum()
        lo, hi = pf.get("vol_cap", [0.5, 2.0])
        eq = 1.0 / len(holdings)
        w = w.clip(lo * eq, hi * eq)
    w = w / w.sum() * exposure
    return w


def rebalance_dates(dates: pd.DatetimeIndex, freq: str = "M", offset_weeks: int = 0) -> pd.DatetimeIndex:
    """Signal dates: last session of each month (or week). offset_weeks shifts monthly dates by whole weeks (tranching)."""
    s = pd.Series(np.arange(len(dates)), index=dates)
    if freq == "W":
        idx = s.groupby([dates.isocalendar().year, dates.isocalendar().week]).last()
    elif freq == "M":
        idx = s.groupby([dates.year, dates.month]).last()
    elif freq == "Q":
        idx = s.groupby([dates.year, dates.quarter]).last()
    else:
        raise ValueError(freq)
    if len(idx) and idx.iloc[-1] == len(dates) - 1:
        # the panel's last session is only a signal date if its calendar period is actually over
        nxt = dates[-1] + pd.offsets.BDay(1)
        closed = {"M": nxt.month != dates[-1].month, "Q": nxt.quarter != dates[-1].quarter,
                  "W": nxt.isocalendar()[1] != dates[-1].isocalendar()[1]}[freq]
        if not closed:
            idx = idx.iloc[:-1]
    pos = idx.values + offset_weeks * 5
    pos = pos[(pos >= 0) & (pos < len(dates))]
    return dates[np.unique(pos)]
