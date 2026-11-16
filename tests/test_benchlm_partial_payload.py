#!/usr/bin/env python3
"""stats-84 self-test: BenchLM __NEXT_DATA__ partial-payload detection.
Plain-assert, no framework, no network — run:

    python3 tests/test_benchlm_partial_payload.py

Exits non-zero on any failure.

Background (2026-11-16): the BenchLM homepage payload began shipping
leaderboard.rows as a SINGLE PAGE (25 rows of summary.rowCount=1034,
rankedCount=215) while the real census pages in on 'Load 25 more'. The old
full-census parser accepted the slice as the whole leaderboard (46 scored ≥
the old 30 floor) and BenchLM's entire open-weight section silently vanished
from the fresh doc — BenchLM cells 193 -> 46, 23 ranked rows demoted. The
payload slice must now be compared against the site's own summary.rowCount;
anything short of the declared census goes to the DOM harvest, which clicks
through the full pagination (live-verified 2026-11-16: 1025 rows, 215 scored
— exactly rankedCount).

Two legs tested here:
  1. _benchlm_parse_next_payload — the pure slice reader: column extraction
     on the widened 43-slot rows (indexes unchanged: [1] name, [7] status,
     [10]/[11] price, [15] Elo, [26] score), malformed/empty rows skipped,
     census block surfaced.
  2. _benchlm_next_verdict — the census decision matrix: partial slice,
     full census, legacy too-small floor, low-scored floor.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "scripts"))
from bench_scraper import (  # noqa: E402
    _benchlm_next_verdict,
    _benchlm_parse_next_payload,
)


def _row(name, score=None, status="Current", elo=1474.09, pin=10, pout=50, rank=1):
    """A synthetic 43-slot leaderboard row in the 2026-11-16 layout.
    Indexes per the live-verified map: [0] rank, [1] name, [7] status,
    [10]/[11] price in/out, [15] Elo, [26] score; the rest is filler we
    never read (sub-scores, category arrays, strings)."""
    r = [None] * 43
    r[0] = rank
    r[1] = name
    r[7] = status
    r[10] = pin
    r[11] = pout
    r[15] = elo
    if score is not None:
        r[26] = score
    return r


def _payload(rows, row_count=None, ranked_count=None):
    """A __NEXT_DATA__ dict shaped like the real one."""
    summary = {"mode": "bench-align-v5"}
    if row_count is not None:
        summary["rowCount"] = row_count
    if ranked_count is not None:
        summary["rankedCount"] = ranked_count
    return {"props": {"pageProps": {"homepageData": {"leaderboard": {
        "rows": rows,
        "rankingMode": "bench-align-v5",
        "summary": summary,
    }}}}}


def test_parse_extracts_columns_from_widened_rows():
    d = _payload([_row("GPT-6 Astra", score=85.65, status="Current",
                       elo=1474.09, pin=10, pout=50, rank=2)])
    items, scored, census, rows_n = _benchlm_parse_next_payload(d)
    assert rows_n == 1, rows_n
    assert scored == 1, scored
    assert items[0]["model"] == "GPT-6 Astra"
    assert items[0]["score"] == "85.65"
    assert items[0]["status"] == "Current"
    assert items[0]["elo"] == "1474.09"
    assert items[0]["price"] == "$10 / $50"
    # int scores are scores too (the site rounds some rows to integers)
    d2 = _payload([_row("Older Model", score=62)])
    items2, scored2, _, _ = _benchlm_parse_next_payload(d2)
    assert scored2 == 1 and items2[0]["score"] == "62"


def test_parse_skips_malformed_rows_and_keeps_census():
    rows = [
        _row("Model A", score=80.0, rank=1),
        ["garbage"],                       # not a list -> skipped
        _row("", score=70.0),              # empty name -> skipped
        _row("Tracked Model", score=None, status="Tracked"),  # no score
        _row("Model B", score=999.0),      # out of 0-100 band -> unscored
    ]
    d = _payload(rows, row_count=1034, ranked_count=215)
    items, scored, census, rows_n = _benchlm_parse_next_payload(d)
    assert rows_n == 5
    assert len(items) == 3, [i["model"] for i in items]
    assert scored == 1, scored  # only Model A is in the 0-100 band
    assert census == {"rowCount": 1034, "rankedCount": 215}, census
    assert items[1]["score"] == ""  # tracked row keeps its (empty) score


def test_parse_handles_shape_drift_without_raising():
    for broken in ({}, {"props": {}}, {"props": {"pageProps": {}}},
                   {"props": {"pageProps": {"homepageData": {}}}},
                   {"props": {"pageProps": {"homepageData": {"leaderboard": {}}}}},
                   None):
        items, scored, census, rows_n = _benchlm_parse_next_payload(broken)
        assert items == [] and scored == 0 and census == {} and rows_n is None


def test_verdict_partial_slice_falls_back():
    # THE regression: 25-row slice of a 1034-row census must NOT pass
    ok, reason = _benchlm_next_verdict(25, 25, {"rowCount": 1034, "rankedCount": 215})
    assert (ok, reason) == (False, "partial"), (ok, reason)
    # this morning's shape: ~120-row slice, still partial
    ok, reason = _benchlm_next_verdict(120, 46, {"rowCount": 1034, "rankedCount": 215})
    assert (ok, reason) == (False, "partial"), (ok, reason)


def test_verdict_full_census_passes():
    # the 2026-10-07 verified shape: full census in the payload
    ok, reason = _benchlm_next_verdict(882, 200, {"rowCount": 882, "rankedCount": 200})
    assert (ok, reason) == (True, None), (ok, reason)
    # exactly equal counts
    ok, reason = _benchlm_next_verdict(50, 30, {"rowCount": 50, "rankedCount": 30})
    assert (ok, reason) == (True, None), (ok, reason)


def test_verdict_legacy_floor_without_summary():
    # payloads without the summary block keep the legacy 50-row floor
    ok, reason = _benchlm_next_verdict(25, 25, {})
    assert (ok, reason) == (False, "too-small"), (ok, reason)


def test_verdict_low_scored_full_census():
    ok, reason = _benchlm_next_verdict(60, 10, {"rowCount": 60, "rankedCount": 10})
    assert (ok, reason) == (False, "low-scored"), (ok, reason)


def test_verdict_no_rows():
    ok, reason = _benchlm_next_verdict(None, 0, {})
    assert (ok, reason) == (False, "no-rows"), (ok, reason)


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"  ok  {fn.__name__}")
    print(f"{len(fns)} checks passed — stats-84 self-test green")
