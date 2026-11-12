"""stats-78 self-test: formatting-variant row fold with or_id-confirmed identity.

2026-11-12 live case: the unranked census admitted 'Qwen2.5-Coder-32B-Instruct'
as a second row of 'Qwen2.5 Coder 32B Instruct' — the same OpenRouter catalog
entry under two spellings. Root split: normalize_model_name strips space-form
parameter sizes anywhere (\s+\d+B\b) but hyphenated catalog tails never matched
that pattern, so the two spellings take DIFFERENT normalize keys and the
stats-70 phase-1 fold never sees them. The stats-78 tier folds on the generic
[a-z0-9] key ONLY when both metas agree on the same non-empty or_id norm key
(stats-74 discipline, never guess by name shape).
"""
import copy
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))

from merge_duplicate_rows import merge_duplicate_rows  # noqa: E402


def _doc():
    return {
        "benchmarks": ["AA", "BenchLM"],
        "avg_benchmarks": ["AA", "BenchLM"],
        "unified_closed": [
            {"name": "Keeper Ranked", "AA": 90.0, "BenchLM": 88.0, "num_benchmarks": 2, "cl": 100.0},
        ],
        "unified_open": [
            # the live fork: spaced (established, better covered) vs hyphenated
            {"name": "Qwen2.5 Coder 32B Instruct", "AA": 44.2, "BenchLM": None,
             "num_benchmarks": 1, "cl": 50.0, "unranked": True},
            {"name": "Qwen2.5-Coder-32B-Instruct", "AA": None, "BenchLM": 61.6,
             "num_benchmarks": 1, "cl": 50.0, "unranked": True},
            # decoy 1: formatting collision but DIFFERENT or_ids -> never folded
            {"name": "Command R", "AA": 12.0, "num_benchmarks": 1, "cl": 50.0, "unranked": True},
            {"name": "Command R+", "AA": 20.0, "num_benchmarks": 1, "cl": 50.0, "unranked": True},
            # decoy 2: formatting collision, or_id missing on one side -> never folded
            {"name": "Mystery 7B", "AA": 10.0, "num_benchmarks": 1, "cl": 50.0, "unranked": True},
            {"name": "Mystery-7B", "AA": 11.0, "num_benchmarks": 1, "cl": 50.0, "unranked": True},
        ],
        "models_meta": {
            "Qwen2.5 Coder 32B Instruct": {"or_id": "qwen/qwen-2.5-coder-32b-instruct",
                                           "created": "2024-11-11"},
            "Qwen2.5-Coder-32B-Instruct": {"or_id": "qwen/qwen-2.5-coder-32b-instruct",
                                           "pricing_usd_per_1m": {"in": 0.9, "out": 0.9}},
            "Command R": {"or_id": "cohere/command-r"},
            "Command R+": {"or_id": "cohere/command-r-plus"},
            "Mystery 7B": {"or_id": "org/mystery-7b"},
            # Mystery-7B has NO or_id record at all
        },
    }


def test_stats78_folds_same_or_id_formatting_twins():
    doc = _doc()
    merges = merge_duplicate_rows(doc)
    folded = [m for m in merges if "Qwen2.5" in m[0] or any("Qwen2.5" in n for n in m[1])]
    assert folded == [("Qwen2.5 Coder 32B Instruct", ["Qwen2.5-Coder-32B-Instruct"])], folded

    names = [r["name"] for t in ("unified_closed", "unified_open") for r in doc[t]]
    assert names.count("Qwen2.5 Coder 32B Instruct") == 1
    assert "Qwen2.5-Coder-32B-Instruct" not in names

    keeper = next(r for r in doc["unified_open"] if r["name"] == "Qwen2.5 Coder 32B Instruct")
    # keep-best cell merge across the twin
    assert keeper["AA"] == 44.2 and keeper["BenchLM"] == 61.6
    # stats-65 graduation: 2nd source landed via the fold -> ranked row now
    assert "unranked" not in keeper
    assert keeper["num_benchmarks"] == 2 and keeper["cl"] == 100.0

    # absorbed meta is gone; keeper meta gap-filled from it
    assert "Qwen2.5-Coder-32B-Instruct" not in doc["models_meta"]
    rec = doc["models_meta"]["Qwen2.5 Coder 32B Instruct"]
    assert rec["or_id"] == "qwen/qwen-2.5-coder-32b-instruct"
    assert rec["created"] == "2024-11-11"
    assert rec["pricing_usd_per_1m"] == {"in": 0.9, "out": 0.9}


def test_stats78_never_folds_different_or_missing_ids():
    doc = _doc()
    merge_duplicate_rows(doc)
    names = [r["name"] for t in ("unified_closed", "unified_open") for r in doc[t]]
    # different or_id -> distinct models stay
    assert "Command R" in names and "Command R+" in names
    # one side has no or_id -> never guessed
    assert "Mystery 7B" in names and "Mystery-7B" in names
    # their metas untouched
    assert doc["models_meta"]["Command R"]["or_id"] != doc["models_meta"]["Command R+"]["or_id"]
    assert "Mystery-7B" not in doc["models_meta"] or doc["models_meta"]["Mystery-7B"] == {}


def test_stats78_folds_are_deterministic_and_printed(capsys):
    doc = _doc()
    merge_duplicate_rows(doc, log=print)
    out = capsys.readouterr().out
    fold_lines = [ln for ln in out.splitlines() if "[Dedup-stats78]" in ln and "<-" in ln]
    assert any("'Qwen2.5 Coder 32B Instruct'" in ln and "same or_id qwen25coder32binstruct" in ln
               for ln in fold_lines)
    # decoys are reported as LEFT UNFOLDED when both metas exist but ids
    # conflict; a meta-less member skips silently (nothing to confirm with)
    unfolded = [ln for ln in out.splitlines() if "left unfolded" in ln]
    assert any("Command R" in ln and "Command R+" in ln for ln in unfolded)
    assert not any("Mystery" in ln for ln in fold_lines)
    # second run over the folded doc is a no-op
    doc2 = copy.deepcopy(doc)
    assert merge_duplicate_rows(doc2) == []


def test_stats78_doc_stays_json_serializable():
    doc = _doc()
    merge_duplicate_rows(doc)
    json.dumps(doc)  # must not raise


def test_gap_fill_never_propagates_control_fields():
    # stats-78 regression (2026-11-12): folding a registry-kept formatting
    # variant into its live row-named keeper used to copy the variant's
    # no_bench_coverage onto the keeper — a live row then carried the
    # registry flag and tripped the stats-62 cells-vs-registry guard.
    from merge_duplicate_rows import _gap_fill_meta
    meta = {
        "Keeper": {"or_id": "org/model", "match": "exact"},
        "Keeper Variant": {"or_id": "org/model", "no_bench_coverage": True,
                           "match": "subset", "or_catalog_retired": True,
                           "superseded_by": "Other", "available_at": {"poe": "x"}},
    }
    rec = _gap_fill_meta("Keeper", ["Keeper Variant"], meta)
    assert "no_bench_coverage" not in rec
    assert rec["match"] == "exact"           # keeper keeps its own catalog state
    assert "or_catalog_retired" not in rec
    assert "superseded_by" not in rec
    assert rec["available_at"] == {"poe": "x"}  # seller history still fills
    assert "Keeper Variant" not in meta      # absorbed record popped
