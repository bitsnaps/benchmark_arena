#!/usr/bin/env python3
"""stats-93 self-test: the MaxxBench station.

Plain-assert, no framework — run:

    python3 tests/test_maxxbench.py

Exits non-zero on any failure.

Contract (2026-11-20, Ibrahim approved): MaxxBench (unLAP's anti-memorization
DeepSWE mutations) joins as a NON-CORE column read from BenchLM's public
markdown mirror:
  · parser takes the self-run leaderboard table only ("Run by MaxxBench"
    column; BenchLM's own Estimated aggregates never touch the cells)
  · scores are 0-100 pass rates — no rescale entry, identity passthrough
  · EXCLUDE_FROM_AVG — the Score blend, cl and num_benchmarks are untouched
    by the new column (ranked math red line)
  · doc stamps: maxxbench_asof + maxxbench_source (CC BY-NC 4.0 attribution)
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "scripts"))
import bench_scraper as bs  # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(f"{'ok' if ok else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


FIXTURE = """# MaxxBench (mutated DeepSWE tasks) (MaxxBench)

> unLAP's MaxxBench takes 89 DeepSWE software engineering tasks and changes
> the instructions or starting code while keeping the core problem.

Canonical page: https://benchlm.ai/benchmarks/maxxbench

- Last updated: November 19, 2026

## Leaderboard (14 models)

| Rank | Model | Creator | Score | Who ran it |
|------|-------|---------|-------|-----------|
| 1 | [Claude Opus 5.5](/models/claude-opus-5-5) | Anthropic | 76.4% | Run by MaxxBench |
| 2 | [GPT-6 Astra](/models/gpt-6-astra) | OpenAI | 71.9% | Run by MaxxBench |
| 7 | [GLM-5.3](/models/glm-5-3) | Z.AI | 56.7% | Run by MaxxBench |
| 8 | [DeepSeek V4.1 Flash 1017](/models/deepseek-v4-1-flash) | DeepSeek | 55.6% | Run by MaxxBench |

## FAQ

### Which model leads MaxxBench?

Claude Opus 5.5 at max effort leads with 76.4% (136 of 178 attempts),
ahead of GPT-6 Astra at xhigh (71.9%).

## Compare Top Models on MaxxBench

- [Claude Opus 5.5 vs GPT-6 Astra](/compare/claude-opus-5-5-vs-gpt-6-astra)
"""

# ── parser (no network — feed the fixture through the same regex path) ────
rows, seen = [], set()
m = __import__("re").search(r"Last updated:\s*([A-Za-z]+ \d{1,2}, \d{4})", FIXTURE)
asof = None
if m:
    import time as _t
    asof = _t.strftime("%Y-%m-%d", _t.strptime(m.group(1), "%B %d, %Y"))
for rank, name, score in bs.MAXX_ROW_RE.findall(FIXTURE):
    name = name.strip()
    try:
        val = float(score)
    except ValueError:
        continue
    if not name or name.lower() in seen or not (0.0 <= val <= 100.0):
        continue
    seen.add(name.lower())
    rows.append((name, val))
rows.sort(key=lambda x: -x[1])

check("table rows parsed", len(rows) == 4, str(rows))
check("rank order preserved by score sort",
      rows[0][0] == "Claude Opus 5.5" and rows[0][1] == 76.4, str(rows[0]))
check("snapshot-tail name kept verbatim",
      "DeepSeek V4.1 Flash 1017" in [n for n, _ in rows], str(rows))
check("FAQ prose and compare links produce no phantom rows",
      all(v <= 100 for _, v in rows) and len(rows) == 4)
check("asof parsed to ISO", asof == "2026-11-19", str(asof))

# ── red lines ─────────────────────────────────────────────────────────────
src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "scripts", "bench_scraper.py")).read()
check("EXCLUDE_FROM_AVG carries MaxxBench", '"MaxxBench"' in
      src.split("EXCLUDE_FROM_AVG = ")[1].split("}")[0])
check("no _benchmark_scale entry for MaxxBench (identity passthrough)",
      '"MaxxBench"' not in src.split("def _benchmark_scale")[1].split("def ")[0])
check("site registered", '"MaxxBench": f"{TMP_DIR}/bench_MaxxBench.json"' in src)
check("dispatcher wired", 'scrape_maxxbench()' in src.split("def _scrape_site")[1].split("def ")[0])

# live names must resolve to canonical meta rows (join discipline) — the
# scraper hits the network only when run directly, so this runs on the last
# baked doc instead
import json  # noqa: E402
doc = json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                  "public", "benchmark_results.json")))
mm = doc.get("models_meta") or {}
per = (doc.get("per_benchmark") or {}).get("MaxxBench") or {}
board_names = [n for n, _ in (per.get("closed") or []) + (per.get("open") or [])]
if board_names:
    unresolved = [n for n in board_names if n not in mm]
    check("baked per_benchmark names all resolve to meta rows", not unresolved, str(unresolved))
    check("column inserted after DeepSWE in doc.benchmarks",
          doc["benchmarks"].index("MaxxBench") == doc["benchmarks"].index("DeepSWE") + 1,
          str(doc["benchmarks"]))
    check("MaxxBench NOT in the shipped avg set", "MaxxBench" not in (doc.get("avg_benchmarks") or []))
    check("doc carries the vintage stamps",
          bool(doc.get("maxxbench_asof")) and "CC BY-NC 4.0" in (doc.get("maxxbench_source") or ""))
    ranked = doc["unified_closed"] + doc["unified_open"]
    cells = {r["name"]: r["MaxxBench"] for r in ranked if r.get("MaxxBench") is not None}
    check("ranked cells ship (14 models baked)",
          len(cells) == 14, f"{len(cells)} cells")
    check("no cell changed any cl/num_benchmarks (non-core column)",
          all(r["cl"] == round((sum(1 for b in (doc.get("avg_benchmarks") or [])
                                    if r.get(b) is not None)) / len(doc["avg_benchmarks"]) * 100, 1)
              for r in ranked))
else:
    check("doc carries MaxxBench data", False, "per_benchmark.MaxxBench missing — bake not applied?")

print()
if FAILS:
    print(f"{len(FAILS)} check(s) FAILED: {FAILS}")
    sys.exit(1)
print("all stats-93 MaxxBench checks passed")
