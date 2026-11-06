#!/usr/bin/env python3
"""stats-74 self-test for the vendor-prefix fold pass in
scripts/merge_duplicate_rows.py. Plain-assert, no framework — run:

    python3 tests/test_merge_vendor_prefix.py

Exits non-zero on any failure. Covers: the positive fold (Tencent Hy4 <- Hy4,
cross-source cells + meta merge), the three refusals (or_id mismatch, missing
or_id, provider mismatch), the colon style, case-insensitive provider,
cross-table folds, and a phase-1 (stats-70) regression case.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "scripts"))
from merge_duplicate_rows import merge_duplicate_rows  # noqa: E402

BENCHES = ["Artificial Analysis", "BenchLM.ai", "Design Arena"]
AVG = ["Artificial Analysis", "BenchLM.ai", "Design Arena"]


def doc_of(closed, open_rows=None, meta=None):
    return {
        "benchmarks": list(BENCHES),
        "avg_benchmarks": list(AVG),
        "unified_closed": closed,
        "unified_open": open_rows or [],
        "models_meta": meta or {},
    }


def names(doc, table="unified_closed"):
    return [r["name"] for r in doc[table]]


def case(name):
    print(f"  ok: {name}")


# 1. Positive: AA's 'Tencent Hy4' + BenchLM/DesignArena's 'Hy4', same or_id.
d = doc_of(
    closed=[
        {"name": "Tencent Hy4", "Artificial Analysis": 35.0},
        {"name": "Hy4", "BenchLM.ai": 61.6, "Design Arena": 76.6},
        {"name": "Gemini 4 Carbon", "Artificial Analysis": 60.0},
    ],
    meta={
        "Tencent Hy4": {"or_id": "tencent/hy4", "provider": "Tencent",
                        "context_length": 1048576},
        "Hy4": {"or_id": "tencent/hy4", "provider": "Tencent",
                "hugging_face_id": "tencent/Hy4-preview"},
    },
)
merges = merge_duplicate_rows(d, log=lambda *_: None)
assert merges == [("Tencent Hy4", ["Hy4"])], merges
assert names(d) == ["Tencent Hy4", "Gemini 4 Carbon"], names(d)
keeper = d["unified_closed"][0]
assert keeper["Artificial Analysis"] == 35.0, keeper
assert keeper["BenchLM.ai"] == 61.6 and keeper["Design Arena"] == 76.6, keeper
assert keeper["num_benchmarks"] == 3 and "unranked" not in keeper, keeper
assert d["models_meta"]["Tencent Hy4"]["hugging_face_id"] == "tencent/Hy4-preview"
assert d["models_meta"]["Tencent Hy4"]["context_length"] == 1048576  # keeper's own kept
assert "Hy4" not in d["models_meta"]
case("positive fold: cells keep-best, meta gap-filled, absorbed meta dropped")

# 2. Refusal: same prefix shape but DIFFERENT or_ids — never guessed.
d = doc_of(
    closed=[
        {"name": "Google Foo", "Artificial Analysis": 50.0},
        {"name": "Foo", "BenchLM.ai": 40.0},
    ],
    meta={"Google Foo": {"or_id": "google/foo"}, "Foo": {"or_id": "other-lab/foo"}},
)
merges = merge_duplicate_rows(d, log=lambda *_: None)
assert merges == [] and names(d) == ["Google Foo", "Foo"], (merges, names(d))
case("refusal: or_id mismatch → no fold")

# 3. Refusal: base row has no meta (no identity evidence) → no fold.
d = doc_of(
    closed=[
        {"name": "Mistral Bar", "Artificial Analysis": 30.0},
        {"name": "Bar", "BenchLM.ai": 44.0},
    ],
    meta={"Mistral Bar": {"or_id": "mistral/bar"}},
)
merges = merge_duplicate_rows(d, log=lambda *_: None)
assert merges == [] and names(d) == ["Mistral Bar", "Bar"], (merges, names(d))
case("refusal: base meta missing or_id → no fold")

# 4. Phase-2 refusal: name shape matches but the catalog ids disagree —
# never guessed (different models under vendor-prefix spellings).
d = doc_of(
    closed=[
        {"name": "Tencent Hy4", "Artificial Analysis": 35.0},
        {"name": "Hy4", "BenchLM.ai": 61.6},
    ],
    meta={"Tencent Hy4": {"or_id": "tencent/hy4", "provider": "Tencent"},
          "Hy4": {"or_id": "tencent/hy4-preview", "provider": "Tencent"}},
)
merges = merge_duplicate_rows(d, log=lambda *_: None)
assert merges == [] and names(d) == ["Tencent Hy4", "Hy4"], (merges, names(d))
case("refusal: vendor prefix matches but or_id differs → no fold")

# 5. Colon style + case-insensitive provider + cross-table fold.
d = doc_of(
    closed=[{"name": "Hy4", "BenchLM.ai": 61.6}],
    open_rows=[{"name": "Tencent: Hy4", "Artificial Analysis": 35.0}],
    meta={"Tencent: Hy4": {"or_id": "tencent/hy4", "provider": "tencent"},
          "Hy4": {"or_id": "tencent/hy4", "provider": "Tencent"}},
)
merges = merge_duplicate_rows(d, log=lambda *_: None)
assert merges == [("Tencent: Hy4", ["Hy4"])], merges
assert names(d, "unified_closed") == [] and names(d, "unified_open") == ["Tencent: Hy4"]
assert d["unified_open"][0]["BenchLM.ai"] == 61.6
case("colon style, lowercase provider, cross-table fold")

# 6. Phase-1 regression: formatting-only twins still fold by normalize key.
d = doc_of(
    closed=[
        {"name": "Qwen3 235B-A22B", "Artificial Analysis": 44.0},
        {"name": "Qwen3-235B-A22B", "BenchLM.ai": 55.0},
    ],
    meta={},
)
merges = merge_duplicate_rows(d, log=lambda *_: None)
assert len(merges) == 1 and len(names(d)) == 1, (merges, names(d))
case("phase-1 regression: normalize-key twins still fold")

print("PASS: all vendor-prefix fold cases green")
