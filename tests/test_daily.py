"""Daily pick: trade simulation, live-lens logic, news parsing, page build. No network."""
import datetime as dt
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from engine import daily as D
from engine import news as NW
from engine import pick as PK
from engine import site

ROOT = Path(__file__).resolve().parent.parent


# --------------------------------------------------------------------------- simulate_trade
def arr(*x):
    return np.array(x, dtype=float)


def test_time_exit_uses_horizon_close_and_costs():
    o = arr(100, 101, 102, 103)
    c = arr(100.5, 101.5, 102.5, 110)
    r = PK.simulate_trade(o, c + 1, o - 1, c, 0, 2.0, 1.0, horizon=3, use_stop=False, cost=0.001)
    ret, ex, reason, path = r
    assert ex == 2 and reason == "time"
    assert ret == pytest.approx(102.5 / 100 - 1 - 0.002)
    assert len(path) == 3


def test_stop_fills_at_stop_or_gap_open():
    o = arr(100, 99, 90, 95)
    c = arr(99, 98, 91, 96)
    h, l = arr(101, 100, 92, 97), arr(99, 97.5, 89, 94)
    # stop = 100 - 2*1 = 98 → day 1 low 97.5 touches → exit at 98
    ret, ex, reason, _ = PK.simulate_trade(o, h, l, c, 0, 2.0, 1.0, horizon=4, cost=0)
    assert (ex, reason) == (1, "stop") and ret == pytest.approx(-0.02)
    # wider stop (94): day 2 opens at 90 below it → fill at the open
    ret, ex, reason, _ = PK.simulate_trade(o, h, l, c, 0, 3.0, 2.0, horizon=4, cost=0)
    assert (ex, reason) == (2, "stop") and ret == pytest.approx(-0.10)


def test_open_trade_and_missing_prints():
    o = arr(100, np.nan, 102)
    c = arr(101, np.nan, 103)
    ret, ex, reason, path = PK.simulate_trade(o, c, c, c, 0, 2.0, 1.0, horizon=21, use_stop=False, cost=0)
    assert reason == "open" and ex == 2
    assert path == pytest.approx([0.01, 0.01, 0.03])     # missing close carries the last mark


def test_limit_no_fill():
    r = PK.simulate_trade(arr(105, 106), arr(106, 107), arr(104, 105), arr(105, 106), 0, 2.0, 1.0, limit=104.0)
    assert r[0] is None and r[2] == "no_fill"


def test_no_entry_print_returns_none():
    assert PK.simulate_trade(arr(np.nan, 1), arr(1, 1), arr(1, 1), arr(1, 1), 0, 2, 1) is None


# --------------------------------------------------------------------------- plan
def test_plan_equal_slot_sizing():
    sess = [dt.date(2026, 10, 5) + dt.timedelta(days=k) for k in range(30)]
    p = PK.plan(100.0, 4.0, pd.Timestamp("2026-10-02"), sess, account=21_000, base={"p10": -0.1, "median": 0.01, "p90": 0.1})
    assert p["size"]["slot_value"] == 1000 and p["size"]["shares"] == 10
    assert p["limit"] == 101.0 and p["stop"] is None
    assert p["range"]["p10"] == 90.0 and p["range"]["p90"] == 110.0
    assert p["exit_by"] == str(sess[20])


def test_gate_multiplier_blocks_on_fail():
    L = [{"key": "momentum", "status": "fail"}, {"key": "earnings", "status": "pass"}, {"key": "news", "status": "fail"}]
    m, b = PK.gate_multiplier(L)
    assert m == 0 and b == "News"                          # price lenses never gate; first live fail is named
    m, b = PK.gate_multiplier([{"key": "data", "status": "warn"}, {"key": "analysts", "status": "na"}])
    assert m == pytest.approx(0.93 * 0.97) and b is None


# --------------------------------------------------------------------------- live lenses
SESS = [dt.date(2026, 10, 5) + dt.timedelta(days=k) for k in range(40)]


def test_earnings_lens_window():
    last = dt.date(2026, 10, 2)
    nas = pd.DataFrame({"date": ["2026-10-06"], "ticker": ["AAA"], "session": ["AMC"]})
    L, e = D.earnings_lens("AAA", nas, None, last, SESS)
    assert L["status"] == "fail" and e["days"] == 2
    nas = pd.DataFrame({"date": ["2026-10-20"], "ticker": ["AAA"], "session": ["BMO"]})
    L, _ = D.earnings_lens("AAA", nas, "2026-10-21", last, SESS)
    assert L["status"] == "warn"                           # inside the 21-session hold
    L, e = D.earnings_lens("AAA", nas.iloc[0:0], "2026-12-01", last, SESS)
    assert L["status"] == "pass" and e["sources"] == ["Yahoo"]
    nas.attrs["complete"] = True
    L, _ = D.earnings_lens("ZZZ", nas, None, last, SESS)   # Nasdaq answered every day, no row → no report in the window
    assert L["status"] == "pass"
    nas.attrs["complete"] = False
    L, _ = D.earnings_lens("ZZZ", nas, None, last, SESS)   # a day failed → can't vouch for the window
    assert L["status"] == "na"
    L, _ = D.earnings_lens("ZZZ", nas.iloc[0:0], None, last, SESS)
    assert L["status"] == "na"


def test_analyst_lens():
    L, a = D.analyst_lens({"recommendationMean": 1.8, "numberOfAnalystOpinions": 20, "targetMeanPrice": 120, "recommendationKey": "buy"}, 100)
    assert L["status"] == "pass" and a["upside"] == pytest.approx(0.2)
    L, _ = D.analyst_lens({"recommendationMean": 3.8, "numberOfAnalystOpinions": 5}, 100)
    assert L["status"] == "fail"
    L, _ = D.analyst_lens({"recommendationMean": 2.0, "numberOfAnalystOpinions": 9, "targetMeanPrice": 90}, 100)
    assert L["status"] == "warn"                           # price above the mean target
    L, _ = D.analyst_lens({}, 100)
    assert L["status"] == "na"


def test_data_lens(monkeypatch):
    src = D.Sources()
    monkeypatch.setattr(D, "nasdaq_close", lambda t, d: 100.0)
    assert D.data_lens("A", 100.2, dt.date(2026, 10, 2), src)["status"] == "pass"
    assert D.data_lens("A", 101.0, dt.date(2026, 10, 2), src)["status"] == "warn"
    assert D.data_lens("A", 103.0, dt.date(2026, 10, 2), src)["status"] == "fail"
    monkeypatch.setattr(D, "nasdaq_close", lambda t, d: None)
    monkeypatch.setattr(D, "stooq_close", lambda t, d: None)
    assert D.data_lens("A", 103.0, dt.date(2026, 10, 2), src)["status"] == "na"


# --------------------------------------------------------------------------- news
def test_tone_and_flags():
    assert NW.tone("Acme beats estimates, raises guidance") > 0
    assert NW.tone("Acme misses, shares plunge") < 0
    assert NW.flag_of("Acme cuts full-year guidance")[1] == "fail"
    assert NW.flag_of("SEC probe into Acme accounting")[1] == "fail"
    assert NW.flag_of("Analyst downgrades Acme to Hold")[1] == "warn"
    assert NW.flag_of("Acme CEO to step down at year end")[1] == "warn"
    assert NW.flag_of("Acme launches new product") == (None, None)


def test_dedupe_merges_near_duplicates():
    now = dt.datetime(2026, 10, 3, tzinfo=dt.timezone.utc)
    items = [{"title": "Acme shares jump after earnings beat", "published": now, "via": "Yahoo Finance", "source": "Reuters", "link": "a"},
             {"title": "Acme shares jump after earnings beat - Reuters", "published": now, "via": "Google News", "source": "Reuters", "link": "b"},
             {"title": "Something else entirely", "published": now, "via": "Google News", "source": "X", "link": "c"}]
    out = NW.dedupe(items)
    assert len(out) == 2 and out[0]["n_sources"] == 2


def test_news_lens_red_flag(monkeypatch):
    now = dt.datetime(2026, 10, 3, tzinfo=dt.timezone.utc)
    monkeypatch.setattr(NW, "yahoo_headlines", lambda t: [{"title": "Acme faces SEC investigation", "published": now, "via": "Yahoo Finance", "source": "R", "link": "x"}])
    monkeypatch.setattr(NW, "google_headlines", lambda t, n: [])
    monkeypatch.setattr(NW, "sec_8k", lambda t: [])
    L, heads, filings, counts = NW.lens("ACME", "Acme", now)
    assert L["status"] == "fail" and "probe" in L["flags"] and counts["Yahoo news"] == 1
    monkeypatch.setattr(NW, "yahoo_headlines", lambda t: [])
    monkeypatch.setattr(NW, "sec_8k", lambda t: [{"date": "2026-10-01", "severity": "fail", "flag": "restatement", "items": ["4.02"]}])
    L, *_ = NW.lens("ACME", "Acme", now)
    assert L["status"] == "fail"
    monkeypatch.setattr(NW, "sec_8k", lambda t: [])
    assert NW.lens("ACME", "Acme", now)[0]["status"] == "na"


# --------------------------------------------------------------------------- page
def test_site_build_embeds_and_escapes(tmp_path):
    doc = {"meta": {"x": "</script><script>alert(1)</script>"}}
    out = site.build(doc, out=tmp_path / "i.html")
    html = out.read_text()
    assert "/*__PICK_DATA__*/null" not in html
    assert "</script><script>alert(1)" not in html


def test_sample_matches_contract():
    d = json.loads((ROOT / "site" / "sample_pick.json").read_text())
    for k in ("meta", "regime", "funnel", "pick", "candidates", "record", "backtest", "market", "book", "rules"):
        assert k in d
    p = d["pick"]
    assert [L["key"] for L in p["lenses"]] == PK.LENS_ORDER
    for k in ("entry", "limit", "exit_by", "size", "range"):
        assert k in p["plan"]
    assert len(p["chart"]["dates"]) == len(p["chart"]["c"]) == len(p["chart"]["o"])
