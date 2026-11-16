#!/usr/bin/env python3
"""stats-81 self-test: a base model row must NOT be folded into its variant.

Plain-assert, no framework — run:

    python3 tests/test_unified_base_variant_fold.py

Exits non-zero on any failure.

Background (2026-11-16, Ibrahim "where is Fable 5.2's Arena score" audit):
build_unified_table's truncated-family merge treated a single-word family
with a version ("gpt 5.5") as a truncation of any same-version multi-word
family that extends it ("gpt 5.5 pro", "gpt 5.5 instant"). That is a
base→variant relation, not a truncation, so the BASE row was deleted and its
cells were mislabeled onto the variant: Arena's GPT-5.5 (High) 1481.3
(rescaled ~89.5 by vintage) shipped on our GPT-5.5 Pro row across the
2026-11-10..11-13 docs while plain GPT-5.5 vanished — and the upstream
lmarena-ai/leaderboard-dataset never listed GPT-5.5 Pro once (full-split
parquet audit, 7 publishes).

Fix: skip candidate Y when X's full key is a word-prefix of Y's key.
True truncations keep their shape because the extra family word sits
BEFORE the version ("claude 4.7" -> "claude opus 4.7" is not a prefix).
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "scripts"))
from bench_scraper import build_unified_table  # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(f"{'ok' if ok else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


def run(stations):
    """stations: {bench_name: [(model_name, raw_score), ...]} -> row dict by name."""
    all_results = {}
    for bname, entries in stations.items():
        closed = [(n, s) for n, s in entries]
        all_results[bname] = {"closed": closed, "open": []}
    closed_t, open_t, _benchmarks, _avg = build_unified_table(all_results)
    return {r["name"]: r for r in closed_t + open_t}


# ── Case 1: base survives, variant keeps its own row, no cell bleed ──────
rows = run({
    "Arena.ai Text": [("GPT-5.5 (High)", 1481), ("GPT-5.5", 1476), ("GPT-5.5 Instant", 1473)],
    "Artificial Analysis": [("GPT-5.5 Pro", 55.0), ("GPT-5.5", 52.0)],
})
check("plain GPT-5.5 row exists", "GPT-5.5" in rows,
      "rows=" + str(sorted(rows.keys())))
check("plain GPT-5.5 kept its Arena cell",
      rows.get("GPT-5.5", {}).get("Arena.ai Text") is not None,
      str(rows.get("GPT-5.5", {}).get("Arena.ai Text")))
check("GPT-5.5 Pro row exists separately", "GPT-5.5 Pro" in rows)
check("GPT-5.5 Pro has NO Arena cell (no bleed)",
      rows.get("GPT-5.5 Pro", {}).get("Arena.ai Text") is None,
      str(rows.get("GPT-5.5 Pro", {}).get("Arena.ai Text")))
check("GPT-5.5 Pro kept its AA cell",
      rows.get("GPT-5.5 Pro", {}).get("Artificial Analysis") is not None)
check("GPT-5.5 Instant row exists separately", "GPT-5.5 Instant" in rows)

# ── Case 2: true truncation still merges ("claude 4.7" -> "claude opus 4.7") ──
rows = run({
    "ARC-AGI-2": [("Claude 4.7", 80.0)],
    "BenchLM.ai": [("Claude Opus 4.7", 90.0)],
})
check("truncated 'Claude 4.7' merged into 'Claude Opus 4.7'",
      "Claude 4.7" not in rows and "Claude Opus 4.7" in rows,
      "rows=" + str(sorted(rows.keys())))
check("merged row kept the ARC-AGI-2 cell",
      rows.get("Claude Opus 4.7", {}).get("ARC-AGI-2") is not None)
check("merged row kept the BenchLM.ai cell",
      rows.get("Claude Opus 4.7", {}).get("BenchLM.ai") is not None)

# ── Case 3: smaller-variant guard still blocks (stats-50 behavior kept) ──
rows = run({
    "SimpleBench.com": [("GLM 5.3", 70.0)],
    "BenchLM.ai": [("GLM 5.3 Flash", 65.0)],
})
check("GLM 5.3 not absorbed by GLM 5.3 Flash",
      "GLM 5.3" in rows and "GLM 5.3 Flash" in rows,
      "rows=" + str(sorted(rows.keys())))

print()
if FAILS:
    print(f"FAILED: {len(FAILS)} check(s): {FAILS}")
    sys.exit(1)
print("ALL BASE-VARIANT FOLD CHECKS PASSED")
