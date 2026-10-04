"""Data fetchers. Everything degrades gracefully: a failed source returns an
empty frame / dict and the rest of the pipeline continues.

Sources (all keyless):
  * yfinance  – daily OHLCV, pre-market bars, fundamentals (.info), earnings
                dates, analyst actions, insider purchases, news
  * Stooq     – daily OHLCV fallback for tickers yfinance misses
  * Nasdaq    – earnings calendar JSON (api.nasdaq.com)
  * RSS       – Yahoo Finance / Google News headlines
Optional (env keys): FRED_API_KEY for HY OAS + claims; FINNHUB_API_KEY unused
for now but reserved.
"""
from __future__ import annotations

import concurrent.futures as cf
import datetime as dt
import logging
import os
import time
from typing import Iterable
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import requests

log = logging.getLogger(__name__)

try:
    import yfinance as yf
except Exception:  # pragma: no cover
    yf = None

BROWSER_HEADERS = {
    "accept": "application/json, text/plain, */*",
    "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "accept-language": "en-US,en;q=0.9",
    "origin": "https://www.nasdaq.com",
    "referer": "https://www.nasdaq.com/",
}


# --------------------------------------------------------------------------- prices
def _normalise_download(raw: pd.DataFrame, tickers: list[str], keep_tz: bool = False, min_rows: int = 5) -> dict[str, pd.DataFrame]:
    """yf.download output -> {ticker: DataFrame[Open, High, Low, Close, Volume]}"""
    out: dict[str, pd.DataFrame] = {}
    if raw is None or raw.empty:
        return out
    if isinstance(raw.columns, pd.MultiIndex):
        lvl0 = raw.columns.get_level_values(0)
        # group_by="ticker" => level0 = ticker; otherwise level0 = field
        if set(tickers) & set(lvl0):
            for t in tickers:
                if t in lvl0:
                    df = raw[t].copy()
                    out[t] = df
        else:
            for t in tickers:
                try:
                    df = raw.xs(t, axis=1, level=1).copy()
                    out[t] = df
                except KeyError:
                    continue
    else:
        if len(tickers) == 1:
            out[tickers[0]] = raw.copy()
    clean = {}
    for t, df in out.items():
        df = df.rename(columns=str.title)
        need = ["Open", "High", "Low", "Close", "Volume"]
        if not all(c in df.columns for c in need):
            continue
        df = df[need].dropna(subset=["Close"])
        idx = pd.to_datetime(df.index)
        if getattr(idx, "tz", None) is not None and not keep_tz:
            idx = idx.tz_localize(None)
        df.index = idx
        df = df[~df.index.duplicated(keep="last")].sort_index()
        if len(df) >= min_rows:
            clean[t] = df
    return clean


def fetch_prices(tickers: Iterable[str], period: str = "2y", chunk_size: int = 40,
                 pause: float = 1.5, max_retries: int = 3, interval: str = "1d",
                 prepost: bool = False) -> dict[str, pd.DataFrame]:
    """Chunked yfinance download with retries; returns {ticker: OHLCV}."""
    tickers = list(dict.fromkeys(tickers))
    result: dict[str, pd.DataFrame] = {}
    if yf is None:
        return result
    for i in range(0, len(tickers), chunk_size):
        chunk = tickers[i:i + chunk_size]
        for attempt in range(max_retries):
            try:
                raw = yf.download(chunk, period=period, interval=interval, group_by="ticker",
                                  auto_adjust=True, threads=True, progress=False,
                                  prepost=prepost, timeout=30)
                got = _normalise_download(raw, chunk)
                result.update(got)
                missing = [t for t in chunk if t not in got]
                if missing and attempt < max_retries - 1 and len(missing) > len(chunk) // 2:
                    raise RuntimeError(f"{len(missing)} of {len(chunk)} missing")
                break
            except Exception as e:
                wait = pause * (2 ** attempt) * 2
                log.warning("chunk %d attempt %d failed: %s (sleep %.0fs)", i // chunk_size, attempt + 1, e, wait)
                time.sleep(wait)
        time.sleep(pause)
    log.info("prices: %d/%d tickers", len(result), len(tickers))
    return result


def fetch_prices_raw(tickers: Iterable[str], period: str = "1mo", chunk_size: int = 50, pause: float = 1.0, max_retries: int = 3) -> dict[str, pd.DataFrame]:
    """Unadjusted bars *plus* Adj Close (auto_adjust=False) — used to extend the stored history for the rotation model."""
    tickers = list(dict.fromkeys(tickers))
    result: dict[str, pd.DataFrame] = {}
    if yf is None:
        return result
    cols = ["Open", "High", "Low", "Close", "Adj Close", "Volume"]
    for i in range(0, len(tickers), chunk_size):
        chunk = tickers[i:i + chunk_size]
        for attempt in range(max_retries):
            try:
                raw = yf.download(chunk, period=period, interval="1d", group_by="ticker", auto_adjust=False, actions=False,
                                  threads=True, progress=False, timeout=30)
                got = {}
                if raw is not None and not raw.empty:
                    lvl0 = set(raw.columns.get_level_values(0)) if isinstance(raw.columns, pd.MultiIndex) else set()
                    for t in chunk:
                        try:
                            df = raw[t] if t in lvl0 else (raw if len(chunk) == 1 else None)
                        except KeyError:
                            df = None
                        if df is None:
                            continue
                        df = df.copy(); df.columns = [str(c) for c in df.columns]
                        if "Adj Close" not in df.columns and "Close" in df.columns:
                            df["Adj Close"] = df["Close"]
                        if not all(c in df.columns for c in cols):
                            continue
                        df = df[cols].dropna(subset=["Close"])
                        idx = pd.to_datetime(df.index)
                        if getattr(idx, "tz", None) is not None:
                            idx = idx.tz_localize(None)
                        df.index = idx.normalize()
                        df = df[~df.index.duplicated(keep="last")].sort_index()
                        if len(df):
                            got[t] = df
                result.update(got)
                if len(got) < len(chunk) // 2 and attempt < max_retries - 1:
                    raise RuntimeError(f"{len(chunk) - len(got)} of {len(chunk)} missing")
                break
            except Exception as e:
                wait = pause * (2 ** attempt) * 2
                log.warning("raw chunk %d attempt %d failed: %s (sleep %.0fs)", i // chunk_size, attempt + 1, e, wait)
                time.sleep(wait)
        time.sleep(pause)
    log.info("raw prices: %d/%d tickers", len(result), len(tickers))
    return result


def fetch_prices_stooq(tickers: Iterable[str], days: int = 760) -> dict[str, pd.DataFrame]:
    """Fallback: Stooq daily CSV per ticker (no key)."""
    out = {}
    start = (dt.date.today() - dt.timedelta(days=days)).strftime("%Y%m%d")
    for t in tickers:
        sym = t.lower().replace("-", ".") + ".us"
        url = f"https://stooq.com/q/d/l/?s={sym}&d1={start}&i=d"
        try:
            r = requests.get(url, timeout=20, headers={"User-Agent": BROWSER_HEADERS["user-agent"]})
            if r.status_code != 200 or "Date" not in r.text[:50]:
                continue
            df = pd.read_csv(pd.io.common.StringIO(r.text), parse_dates=["Date"]).set_index("Date")
            df = df.rename(columns=str.title)[["Open", "High", "Low", "Close", "Volume"]].dropna()
            df = df[~df.index.duplicated(keep="last")].sort_index()
            if len(df) >= 5:
                out[t] = df
        except Exception as e:
            log.debug("stooq %s failed: %s", t, e)
        time.sleep(0.3)
    return out


# --------------------------------------------------------------------------- pre-market
def fetch_premarket(tickers: Iterable[str], last_close: pd.Series, chunk_size: int = 60) -> pd.DataFrame:
    """Latest pre-market (or regular-session) price vs prior close using 5m prepost bars.
    Returns DataFrame[ticker, pm_price, pm_gap_pct, pm_volume, pm_time]."""
    rows = []
    tickers = list(tickers)
    if yf is None:
        return pd.DataFrame(columns=["ticker", "pm_price", "pm_gap_pct", "pm_volume", "pm_time"])
    now_et = dt.datetime.now(ZoneInfo("America/New_York"))
    today_et = now_et.date()
    premarket = now_et.time() < dt.time(9, 30)
    for i in range(0, len(tickers), chunk_size):
        chunk = tickers[i:i + chunk_size]
        try:
            raw = yf.download(chunk, period="1d", interval="5m", group_by="ticker", prepost=True,
                              auto_adjust=False, threads=True, progress=False, timeout=30)
            got = _normalise_download(raw, chunk, keep_tz=True, min_rows=1) if raw is not None and (isinstance(raw.columns, pd.MultiIndex) or len(chunk) == 1) else {}
        except Exception as e:
            log.warning("premarket chunk failed: %s", e)
            continue
        for t, df in got.items():
            if df.empty or t not in last_close.index:
                continue
            df = df.dropna(subset=["Close"])
            # keep only bars from the current ET calendar day so a Friday close never masquerades as Monday pre-market
            try:
                bar_ts = pd.to_datetime(df.index)
                if getattr(bar_ts, "tz", None) is not None:
                    bar_ts = bar_ts.tz_convert("America/New_York")
                same_day = bar_ts.date >= today_et
                # extended-hours bars only: before 09:30 when pre-market, after 16:00 otherwise
                ext = (bar_ts.time < dt.time(9, 30)) if premarket else (bar_ts.time >= dt.time(16, 0))
                df = df[same_day & ext]
            except Exception:
                pass
            if df.empty:
                continue
            last = df.iloc[-1]
            prev = float(last_close[t])
            if prev <= 0:
                continue
            rows.append({
                "ticker": t,
                "pm_price": float(last["Close"]),
                "pm_gap_pct": (float(last["Close"]) / prev - 1) * 100,
                "pm_volume": float(df["Volume"].fillna(0).sum()),
                "pm_time": str(df.index[-1]),
            })
        time.sleep(1.0)
    return pd.DataFrame(rows)


def fetch_latest_quotes(tickers: Iterable[str]) -> dict[str, dict]:
    """fast_info snapshot for a handful of symbols (futures, VIX...)."""
    out = {}
    if yf is None:
        return out
    for t in tickers:
        try:
            fi = yf.Ticker(t).fast_info
            out[t] = {
                "last": _f(getattr(fi, "last_price", None)),
                "prev_close": _f(getattr(fi, "previous_close", None)),
                "regular_close": _f(getattr(fi, "regular_market_previous_close", None)),
            }
        except Exception as e:
            log.debug("fast_info %s: %s", t, e)
    return out


# --------------------------------------------------------------------------- fundamentals
INFO_FIELDS = [
    "marketCap", "trailingEps", "forwardEps", "trailingPE", "forwardPE", "pegRatio",
    "revenueGrowth", "earningsGrowth", "earningsQuarterlyGrowth", "returnOnEquity",
    "grossMargins", "operatingMargins", "profitMargins", "shortPercentOfFloat", "shortRatio",
    "sharesShort", "sharesShortPriorMonth", "floatShares", "recommendationMean",
    "recommendationKey", "numberOfAnalystOpinions", "targetMeanPrice", "targetMedianPrice", "targetLowPrice", "targetHighPrice",
    "beta", "heldPercentInstitutions", "heldPercentInsiders", "sector", "industry",
    "shortName", "longName", "website",
]


def _f(x):
    try:
        if x is None:
            return None
        v = float(x)
        return None if (np.isnan(v) or np.isinf(v)) else v
    except Exception:
        return None


def _fetch_one_fundamental(ticker: str) -> dict:
    row: dict = {"ticker": ticker}
    try:
        tk = yf.Ticker(ticker)
        info = tk.info or {}
        for k in INFO_FIELDS:
            v = info.get(k)
            row[k] = v if isinstance(v, str) else _f(v)
        # Earnings dates (past + future) with surprise
        try:
            ed = tk.get_earnings_dates(limit=8)
            if ed is not None and not ed.empty:
                ed = ed.copy()
                ed.index = pd.to_datetime(ed.index).tz_localize(None)
                ed = ed[ed.index.notna()]  # yfinance scrape can misalign rows and leave NaT dates
                today = pd.Timestamp(dt.datetime.now(ZoneInfo("America/New_York")).date())
                past = ed[ed.index < today]
                fut = ed[ed.index >= today]
                if not fut.empty:
                    row["next_earnings"] = str(fut.index.min().date())
                if not past.empty:
                    last = past.sort_index().iloc[-1]
                    row["last_earnings"] = str(past.index.max().date())
                    sp = None
                    for c in ed.columns:
                        if "Surprise" in str(c):
                            sp = _f(last[c])
                    row["last_surprise_pct"] = sp
                    for c in ed.columns:
                        if "Reported" in str(c):
                            row["last_reported_eps"] = _f(last[c])
                        if "Estimate" in str(c):
                            row["last_eps_estimate"] = _f(last[c])
        except Exception as e:
            log.debug("%s earnings dates: %s", ticker, e)
        # Analyst actions last 60 days
        try:
            ud = tk.get_upgrades_downgrades()
            if ud is not None and not ud.empty:
                ud = ud.copy()
                ud.index = pd.to_datetime(ud.index).tz_localize(None)
                recent = ud[ud.index >= pd.Timestamp.today() - pd.Timedelta(days=60)]
                acts = recent["Action"].astype(str).str.lower() if "Action" in recent.columns else pd.Series(dtype=str)
                row["upgrades_60d"] = int(acts.str.contains("up").sum())
                row["downgrades_60d"] = int(acts.str.contains("down").sum())
                row["initiations_60d"] = int(acts.str.contains("init").sum())
        except Exception as e:
            log.debug("%s upgrades: %s", ticker, e)
        # Recommendation trend (current vs 1-3 months ago)
        try:
            rt = tk.get_recommendations()
            if rt is not None and not rt.empty and "strongBuy" in rt.columns:
                rt = rt.reset_index(drop=True)
                if "period" in rt.columns:
                    rt = rt.set_index(rt["period"].astype(str))
                def score(r):
                    n = r[["strongBuy", "buy", "hold", "sell", "strongSell"]].sum()
                    return None if n == 0 else float((r["strongBuy"] * 1 + r["buy"] * 2 + r["hold"] * 3 + r["sell"] * 4 + r["strongSell"] * 5) / n)
                now_row = rt.loc["0m"] if "0m" in rt.index else rt.iloc[0]
                old_row = rt.loc["-3m"] if "-3m" in rt.index else (rt.iloc[-1] if len(rt) > 1 else None)
                row["rec_now"] = score(now_row)
                row["rec_3m"] = score(old_row) if old_row is not None else None
                row["analysts"] = int(now_row[["strongBuy", "buy", "hold", "sell", "strongSell"]].sum())
        except Exception as e:
            log.debug("%s rec trend: %s", ticker, e)
        # Insider purchases (last 6 months summary table)
        try:
            ip = tk.get_insider_purchases()
            if ip is not None and not ip.empty:
                ip = ip.copy()
                first = ip.columns[0]
                ip[first] = ip[first].astype(str)
                def get(label, col):
                    m = ip[ip[first].str.contains(label, case=False, na=False)]
                    return _f(m.iloc[0][col]) if not m.empty and col in ip.columns else None
                row["insider_buy_shares_6m"] = get("Purchases", "Shares")
                row["insider_buy_trans_6m"] = get("Purchases", "Trans")
                row["insider_sell_shares_6m"] = get("Sales", "Shares")
                row["insider_sell_trans_6m"] = get("Sales", "Trans")
                row["insider_net_shares_6m"] = get("Net Shares Purchased", "Shares")
                row["insider_pct_net_6m"] = get("% Net Shares Purchased", "Shares")
        except Exception as e:
            log.debug("%s insiders: %s", ticker, e)
    except Exception as e:
        log.warning("fundamentals %s failed: %s", ticker, e)
        row["error"] = str(e)[:120]
    return row


def fetch_fundamentals(tickers: Iterable[str], workers: int = 4) -> pd.DataFrame:
    tickers = list(tickers)
    if yf is None or not tickers:
        return pd.DataFrame(columns=["ticker"])
    rows = []
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(_fetch_one_fundamental, t): t for t in tickers}
        for fut in cf.as_completed(futs):
            try:
                rows.append(fut.result())
            except Exception as e:
                rows.append({"ticker": futs[fut], "error": str(e)[:120]})
    df = pd.DataFrame(rows)
    log.info("fundamentals: %d rows (%d errors)", len(df), int(df.get("error", pd.Series(dtype=object)).notna().sum()) if "error" in df else 0)
    return df


# --------------------------------------------------------------------------- earnings calendar
def fetch_nasdaq_earnings(dates: Iterable[dt.date]) -> pd.DataFrame:
    rows, failures = [], 0
    dates = list(dates)
    sess = requests.Session()
    sess.headers.update(BROWSER_HEADERS)
    for d in dates:
        try:
            r = sess.get("https://api.nasdaq.com/api/calendar/earnings", params={"date": d.strftime("%Y-%m-%d")}, timeout=20)
            r.raise_for_status()
            js = r.json()
            for row in (js.get("data") or {}).get("rows") or []:
                rows.append({
                    "date": d.strftime("%Y-%m-%d"),
                    "ticker": str(row.get("symbol", "")).replace(".", "-"),
                    "name": row.get("name"),
                    "time": row.get("time"),  # time-pre-market / time-after-hours / time-not-supplied
                    "eps_forecast": row.get("epsForecast"),
                    "last_eps": row.get("lastYearEPS"),
                    "market_cap": row.get("marketCap"),
                })
        except Exception as e:
            failures += 1
            log.warning("nasdaq earnings %s: %s", d, e)
            if failures >= 4 and not rows:
                break  # blocked outright — stop hammering
        time.sleep(0.4)
    if not rows:
        raise RuntimeError(f"Nasdaq earnings calendar returned no rows for {len(dates)} dates ({failures} failures)")
    df = pd.DataFrame(rows)
    df["session"] = df["time"].map({"time-pre-market": "BMO", "time-after-hours": "AMC"}).fillna("TBD")
    return df


# --------------------------------------------------------------------------- news
def _parse_feed(url: str, limit: int = 8) -> list[dict]:
    try:
        import feedparser
        r = requests.get(url, timeout=20, headers={"User-Agent": BROWSER_HEADERS["user-agent"]})
        feed = feedparser.parse(r.content)
        items = []
        for e in feed.entries[:limit]:
            items.append({
                "title": e.get("title", "").strip(),
                "link": e.get("link"),
                "published": e.get("published", e.get("updated", "")),
                "source": (e.get("source") or {}).get("title") if isinstance(e.get("source"), dict) else None,
            })
        return items
    except Exception as e:
        log.debug("feed %s: %s", url, e)
        return []


def fetch_news(tickers: Iterable[str], per_ticker: int = 3) -> dict[str, list[dict]]:
    out = {}
    for t in tickers:
        url = f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={t}&region=US&lang=en-US"
        items = _parse_feed(url, per_ticker)
        if not items:
            items = _parse_feed(f"https://news.google.com/rss/search?q={t}+stock&hl=en-US&gl=US&ceid=US:en", per_ticker)
        out[t] = items
        time.sleep(0.3)
    return out


def fetch_market_news(limit: int = 10) -> list[dict]:
    items = _parse_feed("https://news.google.com/rss/search?q=stock+market+today+futures&hl=en-US&gl=US&ceid=US:en", limit)
    if not items:
        items = _parse_feed("https://finance.yahoo.com/news/rssindex", limit)
    return items


# --------------------------------------------------------------------------- FRED (optional)
def fetch_fred(series: dict[str, str], days: int = 400) -> dict[str, pd.Series]:
    key = os.environ.get("FRED_API_KEY")
    out = {}
    if not key:
        return out
    start = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    for name, sid in series.items():
        try:
            r = requests.get("https://api.stlouisfed.org/fred/series/observations",
                             params={"series_id": sid, "api_key": key, "file_type": "json", "observation_start": start},
                             timeout=20)
            obs = r.json().get("observations", [])
            s = pd.Series({pd.Timestamp(o["date"]): float(o["value"]) for o in obs if o["value"] not in (".", "")})
            out[name] = s.sort_index()
        except Exception as e:
            log.warning("fred %s: %s", sid, e)
    return out
