#!/usr/bin/env python3
# stats-93: adopt the MaxxBench column + the B/C census growth onto the
# shipped public doc — the PR-shipping twin of the daily refresh for exactly
# these two sections, so production carries the new column/census rows the
# moment this lands (the daily refresh owns them from the next run on).
#
# What it does (ADDITIVE ONLY — every existing value stays byte-identical):
#   1. MaxxBench cells on ranked rows (14 self-run pass rates by unLAP, read
#      from BenchLM's public markdown mirror). Non-core benchmark: cl /
#      num_benchmarks / Score / rank math untouched (EXCLUDE_FROM_AVG).
#   2. 'MaxxBench' joins doc.benchmarks (after DeepSWE) + per_benchmark +
#      doc-level vintage stamps (maxxbench_asof / maxxbench_source).
#   3. Census additions (stats-93 B+C): :free-only OR listings now census-
#      eligible (ERNIE-5.5-Flash-Preview class) + the curated HF-only lane
#      (LongCat-2.5, Nex-N2.5-Max, Arete-27B, ...). Only rows NOT already in
#      the shipped census are appended — existing census rows (including
#      their baked vendor_scores fields) are never rebuilt or touched here;
#      removals/dedup stay the daily refresh's honest business.
#
# RED LINES: no Score/rank/avg-set math is recomputed (MaxxBench is excluded
# from the blend server-side in build_unified_table; the doc's avg set and
# every cl/num_benchmarks stay untouched). Ranked rows only GAIN a cell, and
# only where the source board lists the model. Dry-run by default — --apply
# writes.
import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "scripts"))
import bench_scraper as bs  # noqa: E402

DOC = os.path.join(REPO, "public", "benchmark_results.json")


def main():
    apply = "--apply" in sys.argv
    doc = json.load(open(DOC))
    print(f"doc: {doc.get('timestamp')} | benchmarks={len(doc.get('benchmarks') or [])} "
          f"| card={len(doc.get('card_models') or [])}")

    # ── 1. MaxxBench cells ────────────────────────────────────────────────
    rows = bs.scrape_maxxbench()
    if not rows:
        print("FAIL: MaxxBench mirror parsed to zero rows — aborting (nothing written)")
        return 1
    tables = [doc["unified_closed"], doc["unified_open"]]
    hit, miss = 0, []
    for name, score in rows:
        norm = bs.normalize_model_name(name)
        matched = [r for t in tables for r in t
                   if bs.normalize_model_name(r.get("name") or "") == norm]
        if not matched:
            miss.append(name)
            continue
        for r in matched:
            r["MaxxBench"] = score
            hit += 1
    print(f"cells: {hit} row(s) scored, unmatched: {miss or 'none'}")
    if not miss and hit < len(rows):
        print(f"NOTE: duplicate-norm rows absorbed {len(rows)} -> {hit} cells")

    # ── 2. benchmarks list + per_benchmark + stamps ──────────────────────
    bl = doc.get("benchmarks") or []
    if "MaxxBench" not in bl:
        idx = bl.index("DeepSWE") + 1 if "DeepSWE" in bl else len(bl)
        bl.insert(idx, "MaxxBench")
        doc["benchmarks"] = bl
        print(f"benchmarks: 'MaxxBench' inserted at {idx} (after DeepSWE)")
    else:
        print("benchmarks: 'MaxxBench' already present")
    avg = doc.get("avg_benchmarks") or []
    if "MaxxBench" in avg:
        print("FAIL: MaxxBench must never join the avg set — aborting")
        return 1
    closed = sorted([(n, s) for n, s in rows if bs.classify_model(n) == "closed"],
                    key=lambda x: -x[1])
    open_w = sorted([(n, s) for n, s in rows if bs.classify_model(n) != "closed"],
                    key=lambda x: -x[1])
    doc.setdefault("per_benchmark", {})["MaxxBench"] = {
        "closed": closed[:bs.TOP_N],
        "open": open_w[:bs.TOP_N],
    }
    doc["maxxbench_asof"] = bs.MAXX_ASOF
    doc["maxxbench_source"] = (
        "benchlm.ai/benchmarks/maxxbench — MaxxBench by unLAP (anti-memorization "
        "DeepSWE mutations, self-run), mirrored by BenchLM.ai, CC BY-NC 4.0")

    # ── 3. census additions (stats-93 B+C) — additive only ───────────────
    census = doc.get("card_models") or []
    have = {bs.normalize_model_name(r.get("name") or "") for r in census}
    or_models = bs.fetch_openrouter_models(force=True)
    if not or_models:
        print("FAIL: OpenRouter catalog unavailable — census step aborted "
              "(cells/stamps above are still valid)")
    else:
        fresh, fresh_meta = bs.collect_card_models(
            doc["unified_closed"] + doc["unified_open"], doc["benchmarks"],
            or_models=or_models)
        added = []
        for r in fresh:
            norm = bs.normalize_model_name(r.get("name") or "")
            if norm in have:
                continue  # already shipped — existing row stays untouched
            census.append(r)
            have.add(norm)
            added.append(r["name"])
            m = fresh_meta.get(r["name"])
            if m:
                doc.setdefault("models_meta", {}).setdefault(r["name"], m)
        print(f"census: +{len(added)} row(s) {added}")
        print(f"census size: {len(census)}")
    doc["card_models"] = census

    if not apply:
        print(f"\ndry-run only ({hit} cells + census additions) — rerun with --apply")
        return 0
    with open(DOC, "w") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
    print(f"\napplied -> {DOC}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
