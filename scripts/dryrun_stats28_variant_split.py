#!/usr/bin/env python3
"""stats-28 dry run: prove the variant-split fix in normalize_model_name()
changes EXACTLY the DeepSeek dated-variant rows and nothing else.

Method (A/B, truncation-proof):
  1. Load the OLD scraper module from git HEAD (pre-fix) and the NEW one
     (working tree) as two separate module instances.
  2. Feed BOTH the same input: the published per_benchmark snapshot (raw
     name/score pairs) with _rescale_score patched to identity — the
     published per-benchmark cells are already display-rescaled, so an
     identity rescale reproduces the published unified cell values exactly
     on both sides, making the diff purely a function of the normalize
     change. TOP_N truncation affects both sides equally and cancels out.
  3. Assert the resulting unified_open/unified_closed diff is exactly the
     expected variant split:
       + DeepSeek V4 Pro 0813   (AA 36.0, BenchLM 56.0, Arena 86.2, ARC 61.3)
       + DeepSeek V4 Flash 0731 (AA 35.0, ARC 61.4, EQB 63.1)
       ~ DeepSeek V4 Pro        (loses the 0813 cells: AA 36->31, BenchLM/ARC gone)
       ~ deepseek v4 flash      (loses the 0731 cells: AA/ARC gone, Arena +high-preview)
       closed table: byte-identical
  4. Assert the normalize probe set (full-date canon, effort strip, kept dates).

Usage: python3 scripts/dryrun_stats28_variant_split.py
"""
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRAPER = os.path.join(REPO, "scripts", "bench_scraper.py")
PUB = os.path.join(REPO, "public", "benchmark_results.json")

sys.path.insert(0, os.path.join(REPO, "scripts"))


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def rebuild(mod, per_benchmark):
    """build_unified_table() on the published snapshot, identity rescale."""
    mod._rescale_score = lambda s, b, all_s=None: s
    all_results = {
        b: {"closed": [tuple(x) for x in d["closed"]],
            "open": [tuple(x) for x in d["open"]]}
        for b, d in per_benchmark.items()
    }
    closed, opened, all_b, avg_b = mod.build_unified_table(dict(all_results))
    return closed, opened


def rowmap(table):
    return {r["name"]: r for r in table}


def main():
    pub = json.load(open(PUB))
    per_benchmark = pub["per_benchmark"]

    # old module straight from git HEAD
    old_src = subprocess.run(
        ["git", "-C", REPO, "show", "HEAD:scripts/bench_scraper.py"],
        check=True, capture_output=True, text=True).stdout
    tmp = tempfile.NamedTemporaryFile("w", suffix="_scraper_old.py", delete=False)
    tmp.write(old_src)
    tmp.close()
    old = load_module(tmp.name, "scraper_old")
    new = load_module(SCRAPER, "scraper_new")

    old_closed, old_open = rebuild(old, per_benchmark)
    new_closed, new_open = rebuild(new, per_benchmark)

    failures = []

    def check(cond, msg):
        print(("  PASS  " if cond else "  FAIL  ") + msg)
        if not cond:
            failures.append(msg)

    print("== probe: normalize_model_name (new) ==")
    probes = [
        # (raw, expected key)
        ("DeepSeek V4 Pro 0813 (max)", "deepseek 4 pro 0813"),
        ("DeepSeek V4 Pro 0813", "deepseek 4 pro 0813"),
        ("DeepSeek V4 Pro (max)", "deepseek 4 pro"),
        ("DeepSeek V4 Flash 0731 (Max)", "deepseek 4 flash 0731"),
        ("DeepSeek-V4-Flash-0731", "deepseek 4 flash 0731"),
        ("DeepSeek V4 Flash Vision (max)", "deepseek 4 flash vision"),
        ("deepseek v4 pro high 20260813", "deepseek 4 pro 0813"),   # full-date + bare effort
        ("deepseek v4 pro high preview", "deepseek 4 pro"),          # bare effort + preview
        ("deepseek v4 flash high preview", "deepseek 4 flash"),
        ("GPT-4 0613", "gpt 4 0613"),                                # kept distinct
        ("GPT-5.6 Luna 2026-07-30 (Max)", "gpt 5.6 luna 0730"),     # hyphen full-date canon
        ("MiMo-V2-Flash (Feb 2026)", "mimo 2 flash (feb 2026)"),     # year token survives (row below CL floor either way)
        ("Qwen3.8 Max", "qwen 3.8"),                                 # trailing max convention intact
        ("Claude Fable 5.1 (xhigh with fallback)", "claude fable 5.1"),
        ("Claude Opus 4.8 - High", "claude opus 4.8"),
    ]
    for raw, want in probes:
        got = new.normalize_model_name(raw)
        check(got == want, f"normalize {raw!r} -> {got!r} (want {want!r})")

    print("== A/B diff: unified_closed ==")
    check(rowmap(old_closed) == rowmap(new_closed),
          "closed table byte-identical (no closed rows carry dated variants)")

    print("== A/B diff: unified_open ==")
    om, nm = rowmap(old_open), rowmap(new_open)
    added = sorted(set(nm) - set(om))
    removed = sorted(set(om) - set(nm))
    changed = sorted(k for k in set(nm) & set(om) if om[k] != nm[k])
    print(f"  added={added} removed={removed} changed={changed}")
    check(added == ["DeepSeek V4 Flash 0731", "DeepSeek V4 Pro 0813"],
          f"exactly the two dated variants added (got {added})")
    check(removed == [], f"no rows removed (got {removed})")
    check(changed == ["DeepSeek V4 Pro", "deepseek v4 flash"],
          f"exactly the two base rows changed (got {changed})")

    r = nm.get("DeepSeek V4 Pro 0813")
    check(r is not None and r["Artificial Analysis"] == 36.0
          and r["BenchLM.ai"] == 56.0 and r["Arena.ai Text"] == 86.2
          and r["ARC-AGI-2"] == 61.3 and r["num_benchmarks"] == 4,
          f"0813 row cells AA=36.0 BenchLM=56.0 Arena=86.2 ARC=61.3 n=4 (got {r})")
    r = nm.get("DeepSeek V4 Flash 0731")
    check(r is not None and r["Artificial Analysis"] == 35.0
          and r["ARC-AGI-2"] == 61.4 and r["EQBench CW"] == 63.1
          and r["num_benchmarks"] == 2,
          f"0731 row cells AA=35.0 ARC=61.4 EQB=63.1 n=2 (got {r})")
    r = nm.get("DeepSeek V4 Pro")
    check(r is not None and r["Artificial Analysis"] == 31.0
          and r["BenchLM.ai"] is None and r["ARC-AGI-2"] is None
          and r["Arena.ai Text"] == 85.8 and r["num_benchmarks"] == 3,
          f"base Pro row no longer absorbs 0813 cells (got {r})")
    r = nm.get("deepseek v4 flash")
    check(r is not None and r["Artificial Analysis"] is None
          and r["ARC-AGI-2"] is None and r["Arena.ai Text"] == 82.8
          and r["num_benchmarks"] == 2,
          f"base Flash row no longer absorbs 0731 cells (got {r})")

    # meta matcher: the new row name must exact-match the dated catalog slug
    print("== probe: OpenRouter meta matching ==")
    or_models = [{"id": "deepseek/deepseek-v4-pro", "name": "DeepSeek: DeepSeek V4 Pro 0423"},
                 {"id": "deepseek/deepseek-v4-pro-0813", "name": "DeepSeek: DeepSeek V4 Pro 0813"},
                 {"id": "deepseek/deepseek-v4-flash", "name": "DeepSeek: DeepSeek V4 Flash 0423"},
                 {"id": "deepseek/deepseek-v4-flash-0731", "name": "DeepSeek: DeepSeek V4 Flash 0731"}]
    m = new.match_models_to_openrouter(
        ["DeepSeek V4 Pro", "DeepSeek V4 Pro 0813",
         "deepseek v4 flash", "DeepSeek V4 Flash 0731"], or_models)
    check(m.get("DeepSeek V4 Pro 0813", (None,))[0]["id"] == "deepseek/deepseek-v4-pro-0813",
          "row 'DeepSeek V4 Pro 0813' exact-matches the dated slug")
    check(m.get("DeepSeek V4 Pro", (None,))[0]["id"] == "deepseek/deepseek-v4-pro",
          "row 'DeepSeek V4 Pro' matches the base slug")
    check(m.get("DeepSeek V4 Flash 0731", (None,))[0]["id"] == "deepseek/deepseek-v4-flash-0731",
          "row 'DeepSeek V4 Flash 0731' exact-matches the dated slug")

    # supersession safety: base and dated variants must never share a series
    # group (annotate_supersession groups by (fam, var) — if they shared it,
    # the newer dated release would hide the base row behind 'Older versions')
    print("== probe: parse_series / supersession grouping ==")
    for base_id, dated_id in (("deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-pro-0813"),
                              ("deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-flash-0731")):
        ps_base = new.parse_series(base_id)
        ps_dated = new.parse_series(dated_id)
        same_group = (ps_base is not None and ps_dated is not None
                      and ps_base[:2] == ps_dated[:2])
        check(not same_group,
              f"{base_id} vs {dated_id}: series groups differ "
              f"(base={ps_base}, dated={ps_dated})")

    print()
    if failures:
        print(f"DRY RUN FAILED: {len(failures)} assertion(s)")
        sys.exit(1)
    print("DRY RUN OK — the variant split is exactly as designed.")


if __name__ == "__main__":
    main()
