#!/usr/bin/env python3
"""stats-77 self-test: ARC-AGI-2 layout change + benchmark-basis hardening.
Plain-assert, no framework, no network — run:

    python3 tests/test_arc_layout_and_basis.py

Exits non-zero on any failure.

Background (2026-11-11): arcprize.org moved to ONE TABLE PER MODEL CARD
(name in <caption>, headers version-suffixed on the sticky clone only). The
old querySelector('table') grabbed the zero-row header clone, ARC-AGI-2
parsed to an empty dataset, and the fresh doc silently shipped WITHOUT the
benchmark — 12 benches / 7-cell avg set instead of 13/8 — shifting every
baked cl/score until the client-mirror unit parity broke in prepush.

Two legs tested here:
  1. parse_arc_models — both layout shapes deliver {model, score} dicts;
     percentages split off, '—' skipped, bounds enforced.
  2. carry_missing_benchmarks — a shipped benchmark missing from the fresh
     doc is carried over (both lists), order-preserving, idempotent.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "scripts"))
from bench_scraper import parse_arc_models  # noqa: E402
from merge_full_scrape_into_public import carry_missing_benchmarks  # noqa: E402


def test_arc_card_layout_parse():
    """2026-11 card layout output: one dict per model, caption name, raw
    score cell text ('94.2%' or '—')."""
    data = [
        {"model": "Gemini 4 Carbon", "score": "94.2%"},
        {"model": "Claude Fable 5.2", "score": "93.8%"},
        {"model": "Beam 1.0", "score": "—"},
        {"model": "", "score": "77.0%"},            # empty name skipped
        {"model": "Nemotron 3.5 Super VL", "score": "88.9%, $2.10/task"},
    ]
    got = parse_arc_models(data)
    assert got == [
        ("Gemini 4 Carbon", 94.2),
        ("Claude Fable 5.2", 93.8),
        ("Nemotron 3.5 Super VL", 88.9),
    ], f"card layout -> {got}"


def test_arc_legacy_layout_parse():
    """2025-2026-09 single-table shape passes through the same contract.
    Name filtering (AI SYSTEM / '-' rows) already happened in the eval JS —
    python only ever sees candidate model rows."""
    data = [
        {"model": "GPT-5.6 Sol", "score": "95.0%"},
        {"model": "Kimi K3 (High Effort)", "score": "82.3%, $1.2/task"},
        {"model": "Claude Sonnet 5", "score": "—"},       # no data yet
        {"model": "   ", "score": "50.0%"},               # blank name skipped
    ]
    got = parse_arc_models(data)
    assert got == [("GPT-5.6 Sol", 95.0), ("Kimi K3 (High Effort)", 82.3)], \
        f"legacy shape -> {got}"


def test_arc_parse_degenerate_inputs():
    """None / empty / wrong types -> empty list, no exceptions."""
    for bad in (None, [], "[]", 42, [None, 7, "x"], [{"model": "M"}]):
        got = parse_arc_models(bad)
        assert isinstance(got, list), f"{bad!r} must return a list"
    assert parse_arc_models([{"model": "M", "score": "—"}]) == []
    assert parse_arc_models([{"model": "M", "score": "150%"}]) == []  # bound
    assert parse_arc_models([{"model": "M", "score": "0%"}]) == []    # bound


def test_carry_missing_benchmarks_both_lists():
    """The incident shape: fresh doc lost ARC-AGI-2 from both lists."""
    pub = {"benchmarks": ["AA", "BenchLM", "ARC-AGI-2", "Chess"],
           "avg_benchmarks": ["AA", "BenchLM", "ARC-AGI-2"]}
    dl = {"benchmarks": ["AA", "BenchLM", "Chess"],
          "avg_benchmarks": ["AA", "BenchLM"]}
    carried = carry_missing_benchmarks(pub, dl)
    assert dl["benchmarks"] == ["AA", "BenchLM", "Chess", "ARC-AGI-2"]
    assert dl["avg_benchmarks"] == ["AA", "BenchLM", "ARC-AGI-2"]
    assert carried == [("benchmarks", ["ARC-AGI-2"]),
                       ("avg_benchmarks", ["ARC-AGI-2"])]


def test_carry_is_order_preserving_and_idempotent():
    """Fresh order first, carried appended; second run is a no-op."""
    pub = {"benchmarks": ["B1", "B2", "B3"], "avg_benchmarks": ["B1", "B3"]}
    dl = {"benchmarks": ["B1", "B2"], "avg_benchmarks": ["B1"]}
    carry_missing_benchmarks(pub, dl)
    assert dl["benchmarks"] == ["B1", "B2", "B3"]
    assert dl["avg_benchmarks"] == ["B1", "B3"]
    # idempotent: nothing new to carry on the healed doc
    carried2 = carry_missing_benchmarks(pub, dl)
    assert carried2 == []
    assert dl["benchmarks"] == ["B1", "B2", "B3"]


def test_carry_noop_when_fresh_is_complete():
    """Healthy scrape (all benchmarks present, or legitimately NEW ones) ->
    zero carries, doc untouched."""
    pub = {"benchmarks": ["B1", "B2"], "avg_benchmarks": ["B1"]}
    dl = {"benchmarks": ["B1", "B2", "B3-NEW"], "avg_benchmarks": ["B1", "B3-NEW"]}
    assert carry_missing_benchmarks(pub, dl) == []
    assert dl["benchmarks"] == ["B1", "B2", "B3-NEW"]


def test_carry_tolerates_missing_keys():
    """Docs without the lists (old shapes) must not crash."""
    pub, dl = {}, {"benchmarks": ["B1"]}
    assert carry_missing_benchmarks(pub, dl) == []
    assert dl["benchmarks"] == ["B1"]


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"  ok: {fn.__name__}")
    print(f"ALL PASS ({len(fns)} cases)")
