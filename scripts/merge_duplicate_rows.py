#!/usr/bin/env python3
"""stats-70: fold unified rows that are one model under two spellings.

build_unified_table() joins sources on normalize_model_name(), but rows that
reach public/ through other paths (prior-public carry-over, older snapshots)
can predate a normalize fix and sit side by side — "o3 2025.04 16" next to
"o3 (2025-04-16)", "Qwen3 235B-A22B" next to "Qwen3-235B-A22B". This pass
groups closed+open rows by the CURRENT normalize key and merges each group:

  keeper   = row with the most filled cells, then a name without scrape
             debris like "(120K, )", then the shorter name
             (build_unified_table's shortest-display rule)
  cells    = best score per benchmark (same keep-best as the scraper)
  derived  = num_benchmarks / cl / unranked recomputed from avg_benchmarks
  meta     = keeper's record, gaps filled from the absorbed records;
             absorbed records are dropped with their rows

Usage: python3 scripts/merge_duplicate_rows.py [path] [--dry-run]
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bench_scraper import normalize_model_name  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB = os.path.join(REPO_ROOT, "public", "benchmark_results.json")


_DEBRIS = re.compile(r"\(\s*,|,\s*\)|\(\s*\)")


def _filled(row, benches):
    return sum(1 for b in benches if row.get(b) is not None)


def merge_duplicate_rows(doc, log=print):
    """Mutates doc in place; returns [(keeper_name, [absorbed names])]."""
    benches = doc.get("benchmarks") or []
    avg = doc.get("avg_benchmarks") or []
    meta = doc.setdefault("models_meta", {})
    groups = {}
    for table in ("unified_closed", "unified_open"):
        for row in doc.get(table, []):
            groups.setdefault(normalize_model_name(row["name"]), []).append((table, row))

    merges = []
    for members in groups.values():
        if len(members) < 2:
            continue
        members.sort(key=lambda tr: (-_filled(tr[1], benches), bool(_DEBRIS.search(tr[1]["name"])),
                                     len(tr[1]["name"]), tr[1]["name"]))
        k_table, keeper = members[0]
        absorbed = [r for _, r in members[1:]]
        for r in absorbed:
            for b in benches:
                s = r.get(b)
                if s is not None and (keeper.get(b) is None or s > keeper[b]):
                    keeper[b] = s
        n_core = sum(1 for b in avg if keeper.get(b) is not None)
        keeper["num_benchmarks"] = n_core
        keeper["cl"] = round(n_core / len(avg) * 100, 1) if avg else 0
        if n_core >= 2:
            keeper.pop("unranked", None)
        else:
            keeper["unranked"] = True

        rec = meta.get(keeper["name"])
        for r in absorbed:
            other = meta.pop(r["name"], None) or {}
            if rec is None:
                rec = meta[keeper["name"]] = {}
            for k, v in other.items():
                if k not in ("or_name",) and rec.get(k) in (None, [], "") and v not in (None, [], ""):
                    rec[k] = v
        gone = {id(r) for r in absorbed}
        for table in ("unified_closed", "unified_open"):
            doc[table] = [r for r in doc.get(table, []) if id(r) not in gone]
        names = [r["name"] for r in absorbed]
        merges.append((keeper["name"], names))
        log(f"  [Dedup] {keeper['name']!r} ({k_table}) <- {names}")
    return merges


def main(argv):
    dry = "--dry-run" in argv
    paths = [a for a in argv if not a.startswith("--")] or [PUB]
    for path in paths:
        with open(path) as f:
            doc = json.load(f)
        merges = merge_duplicate_rows(doc)
        print(f"{path}: {len(merges)} duplicate group(s){' (dry run)' if dry else ''}")
        if merges and not dry:
            with open(path, "w") as f:
                json.dump(doc, f, indent=2, ensure_ascii=False)


if __name__ == "__main__":
    main(sys.argv[1:])
