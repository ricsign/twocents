"""News lens: headlines from three independent free sources, de-duplicated, scored with a finance lexicon.

Sources
    Yahoo Finance RSS        feeds.finance.yahoo.com/rss/2.0/headline?s=TICKER
    Google News RSS          news.google.com/rss/search?q="TICKER" stock
    SEC EDGAR 8-K filings    www.sec.gov/cgi-bin/browse-edgar … type=8-K&output=atom  (item codes = hard facts)

Scoring
    Each headline gets tone in [-1, 1] from a Loughran–McDonald-style word list (finance-specific: "liability",
    "beat", "downgrade" …), plus a red-flag tag for events that historically precede large drawdowns or make the
    momentum signal stale (fraud/probe/restatement, guidance cut, downgrade, offering, bankruptcy, delisting, CEO exit,
    take-private/acquisition). Aggregate tone is a recency-weighted mean (half-life 3 days) over the last 10 days.
Lens status
    fail  any hard red flag in the last 10 days (probe, fraud, restatement, bankruptcy, delisting, guidance cut,
          8-K item 4.02 / 3.01 / 1.03), or a pending acquisition of the company (the stock stops trending)
    warn  tone < -0.15, or a soft flag (downgrade, offering, executive departure, 8-K item 5.02)
    pass  otherwise;  na  when no source returned anything
"""
from __future__ import annotations

import datetime as dt
import email.utils
import html
import logging
import math
import re
import time
from difflib import SequenceMatcher

import requests

log = logging.getLogger(__name__)
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"}
SEC_UA = {"User-Agent": "SwingDesk research bot (github.com/ricsign/daily-stock-picker) admin@example.com", "Accept-Encoding": "gzip, deflate"}

POS = {"beat", "beats", "tops", "topped", "exceeds", "exceeded", "record", "surge", "surges", "soar", "soars", "jump", "jumps", "rally",
       "rallies", "upgrade", "upgraded", "upgrades", "raises", "raised", "boost", "boosts", "strong", "stronger", "growth", "gains",
       "outperform", "buy", "buyback", "repurchase", "dividend", "approval", "approved", "wins", "win", "awarded", "contract",
       "partnership", "expands", "expansion", "profit", "profitable", "accelerates", "momentum", "bullish", "high", "highs",
       "upbeat", "optimistic", "breakthrough", "demand", "rebound", "rebounds", "climbs", "climb", "rises", "rise", "lifts", "lift"}
NEG = {"miss", "misses", "missed", "falls", "fall", "drop", "drops", "plunge", "plunges", "slump", "slumps", "sink", "sinks", "tumble",
       "tumbles", "downgrade", "downgraded", "downgrades", "cut", "cuts", "lowers", "lowered", "weak", "weaker", "warning", "warns",
       "loss", "losses", "lawsuit", "sued", "probe", "investigation", "subpoena", "fraud", "recall", "delay", "delays", "layoffs",
       "layoff", "resigns", "resignation", "decline", "declines", "declined", "slowdown", "bearish", "sell", "underperform", "short",
       "concern", "concerns", "risk", "risks", "halt", "halted", "default", "bankruptcy", "restatement", "dilution", "offering",
       "slides", "slide", "lows", "low", "crash", "scrutiny", "penalty", "fine", "fined", "tariff", "tariffs", "ban", "banned"}
HARD = [(r"\b(fraud|accounting irregularit|restat(e|ement)|sec (charges|probe|investigation)|doj|subpoena)", "probe"),
        (r"\b(bankruptcy|chapter 11|going concern)", "bankruptcy"),
        (r"\b(delist|delisting)", "delisting"),
        (r"\b(cuts?|lowers?|slashes|withdraws?) (its |full[- ]year |annual |fy|quarterly )?(guidance|outlook|forecast)", "guidance cut"),
        (r"\b(to be acquired|agrees? to be (bought|acquired)|take[- ]private|buyout deal|to acquire .* for \$[\d.]+ (billion|bn) a share)", "acquisition")]
SOFT = [(r"\bdowngrade", "downgrade"), (r"\b(secondary|stock|share) offering|prices offering|convertible notes", "offering"),
        (r"\b(ceo|cfo|chief executive|chief financial).{0,30}(resign|step(s|ping)? down|depart|exit|ousted|fired)", "exec exit"),
        (r"\bshort[- ]seller|short report", "short report")]
ITEM_FLAGS = {"4.02": ("restatement", "fail"), "3.01": ("delisting", "fail"), "1.03": ("bankruptcy", "fail"),
              "5.02": ("officer change", "warn"), "2.06": ("impairment", "warn")}
ITEM_NAMES = {"1.01": "Material agreement", "1.02": "Agreement terminated", "1.03": "Bankruptcy", "2.01": "Acquisition completed",
              "2.02": "Results of operations", "2.03": "New obligation", "2.05": "Exit costs", "2.06": "Impairment", "3.01": "Delisting notice",
              "3.02": "Unregistered sale of equity", "4.01": "Auditor change", "4.02": "Non-reliance on financials", "5.02": "Officer/director change",
              "5.03": "Bylaw amendment", "5.07": "Shareholder vote", "7.01": "Reg FD disclosure", "8.01": "Other events", "9.01": "Exhibits"}

_cik_cache: dict[str, int] | None = None


def tone(title: str) -> float:
    words = re.findall(r"[a-z]+", title.lower())
    p = sum(w in POS for w in words)
    n = sum(w in NEG for w in words)
    if p + n == 0:
        return 0.0
    return (p - n) / (p + n)


def flag_of(title: str) -> tuple[str | None, str | None]:
    t = title.lower()
    for pat, name in HARD:
        if re.search(pat, t):
            return name, "fail"
    for pat, name in SOFT:
        if re.search(pat, t):
            return name, "warn"
    return None, None


def _parse_date(s: str | None) -> dt.datetime | None:
    if not s:
        return None
    try:
        d = email.utils.parsedate_to_datetime(s)
        return d.astimezone(dt.timezone.utc) if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)
    except Exception:
        pass
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(dt.timezone.utc)
    except Exception:
        return None


def _rss(url: str, source_default: str, limit: int = 20) -> list[dict]:
    try:
        import feedparser
        r = requests.get(url, headers=UA, timeout=15)
        if r.status_code != 200:
            return []
        f = feedparser.parse(r.content)
        out = []
        for e in f.entries[:limit]:
            title = html.unescape(e.get("title", "")).strip()
            src = None
            if isinstance(e.get("source"), dict):
                src = e["source"].get("title")
            if not src and " - " in title and "news.google" in url:
                title, src = title.rsplit(" - ", 1)
            out.append({"title": title, "link": e.get("link"), "published": _parse_date(e.get("published") or e.get("updated")),
                        "source": src or source_default, "via": source_default})
        return out
    except Exception as e:  # pragma: no cover - network
        log.debug("rss %s: %s", url, e)
        return []


def yahoo_headlines(t: str) -> list[dict]:
    return _rss(f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={t}&region=US&lang=en-US", "Yahoo Finance")


def google_headlines(t: str, name: str | None) -> list[dict]:
    q = f'"{t}" stock' if not name else f'"{name.split(",")[0].replace(" Inc.", "").replace(" Corporation", "")}" OR "{t}" stock'
    return _rss(f"https://news.google.com/rss/search?q={requests.utils.quote(q)}+when:10d&hl=en-US&gl=US&ceid=US:en", "Google News")


def cik_for(t: str) -> int | None:
    global _cik_cache
    if _cik_cache is None:
        try:
            r = requests.get("https://www.sec.gov/files/company_tickers.json", headers=SEC_UA, timeout=20)
            _cik_cache = {v["ticker"].upper().replace(".", "-"): int(v["cik_str"]) for v in r.json().values()}
        except Exception as e:  # pragma: no cover
            log.warning("SEC ticker map: %s", e)
            _cik_cache = {}
    return _cik_cache.get(t.upper())


def sec_8k(t: str, limit: int = 8) -> list[dict]:
    cik = cik_for(t)
    if not cik:
        return []
    try:
        import feedparser
        url = f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik}&type=8-K&dateb=&owner=include&count={limit}&output=atom"
        r = requests.get(url, headers=SEC_UA, timeout=20)
        if r.status_code != 200:
            return []
        f = feedparser.parse(r.content)
        out = []
        for e in f.entries[:limit]:
            summ = html.unescape(e.get("summary", ""))
            items = re.findall(r"Item\s+(\d\.\d\d)", summ)
            date = None
            m = re.search(r"Filed:</b>\s*(\d{4}-\d{2}-\d{2})", summ) or re.search(r"(\d{4}-\d{2}-\d{2})", e.get("updated", ""))
            if m:
                date = m.group(1)
            names = [ITEM_NAMES.get(i, f"Item {i}") for i in items if i != "9.01"]
            flag, sev = None, None
            for i in items:
                if i in ITEM_FLAGS:
                    flag, sev = ITEM_FLAGS[i]
                    if sev == "fail":
                        break
            out.append({"form": e.get("category", {}).get("term", "8-K") if isinstance(e.get("category"), dict) else "8-K",
                        "date": date, "title": " · ".join(names[:2]) or "Current report", "items": items,
                        "link": e.get("link"), "flag": flag, "severity": sev})
        time.sleep(0.15)  # SEC fair-access: ≤10 req/s
        return out
    except Exception as e:  # pragma: no cover
        log.debug("sec %s: %s", t, e)
        return []


def dedupe(items: list[dict]) -> list[dict]:
    out = []
    for it in sorted(items, key=lambda x: x["published"] or dt.datetime.min.replace(tzinfo=dt.timezone.utc), reverse=True):
        key = re.sub(r"[^a-z0-9 ]", "", it["title"].lower())
        dup = next((o for o in out if SequenceMatcher(None, key, o["_k"]).ratio() > 0.8), None)
        if dup:
            dup["n_sources"] = dup.get("n_sources", 1) + (1 if it["via"] not in dup["_via"] else 0)
            dup["_via"].add(it["via"])
            continue
        it = dict(it, _k=key, _via={it["via"]}, n_sources=1)
        out.append(it)
    for o in out:
        o.pop("_k", None)
        o["via"] = sorted(o.pop("_via"))
    return out


def lens(t: str, name: str | None, now: dt.datetime, days: int = 10) -> tuple[dict, list[dict], list[dict], dict]:
    """Returns (lens, headlines, filings, source_counts)."""
    y, g = yahoo_headlines(t), google_headlines(t, name)
    filings = sec_8k(t)
    counts = {"Yahoo news": len(y), "Google News": len(g), "SEC 8-K": len(filings)}
    cutoff = now - dt.timedelta(days=days)
    heads = [h for h in dedupe(y + g) if h["published"] is None or h["published"] >= cutoff]
    num = den = 0.0
    hard, soft = [], []
    for h in heads:
        h["sentiment"] = round(tone(h["title"]), 2)
        h["flag"], sev = flag_of(h["title"])
        if sev == "fail":
            hard.append(h["flag"])
        elif sev == "warn":
            soft.append(h["flag"])
        age = max(0.0, (now - h["published"]).total_seconds() / 86400) if h["published"] else days / 2
        w = 0.5 ** (age / 3) * (1 + 0.5 * (h.get("n_sources", 1) - 1))
        num += w * h["sentiment"]
        den += w
    recent_filings = [f for f in filings if f["date"] and f["date"] >= (now - dt.timedelta(days=30)).date().isoformat()]
    for f in recent_filings:
        if f["severity"] == "fail":
            hard.append(f["flag"])
        elif f["severity"] == "warn":
            soft.append(f["flag"])
    mean = num / den if den else None
    if not heads and not filings:
        status = "na"
    elif hard:
        status = "fail"
    elif soft or (mean is not None and mean < -0.15):
        status = "warn"
    else:
        status = "pass"
    flags = sorted(set(hard + soft))
    detail = f"{len(heads)} headlines · {len(set(sum([h['via'] for h in heads], [])))} sources" + (f" · {', '.join(flags)}" if flags else " · no red flags")
    if status == "na":
        detail = "no source answered"
    L = {"key": "news", "status": status, "score": None if mean is None else round((mean + 1) / 2, 3),
         "value": "—" if mean is None else f"{mean:+.2f}", "detail": detail, "flags": flags}
    for h in heads:
        h["published"] = h["published"].strftime("%Y-%m-%dT%H:%M:%SZ") if h["published"] else None
    return L, heads[:12], filings[:6], counts
