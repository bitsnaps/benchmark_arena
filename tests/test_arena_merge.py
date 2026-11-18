#!/usr/bin/env python3
"""stats-88 self-test: the merged Arena column (Overall-primary + quantile-
equated text fill).

Plain-assert, no framework — run:

    python3 tests/test_arena_merge.py

Exits non-zero on any failure.

Background (Ibrahim, 2026-11-18): "use the overall score then fill the
missing scores with arena's text scores ... so everything falls into one
arena column". The two boards rank the shared cohort differently (Spearman
~0.5), so the fill is quantile equating, never a naive side-by-side rescale;
provenance (arena_source / arena_raw) ships per row.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "scripts"))
from bench_scraper import (  # noqa: E402
    _qq_quantile,
    build_unified_table,
    merge_arena_columns,
)

FAILS = []


def check(name, ok, detail=""):
    print(f"{'ok' if ok else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


def run_stations(text_entries, overall_entries, extra=None):
    """Build unified tables from station dicts, then run the merge.
    Returns (closed+open rows by name, all_results, benchmarks, avg, src, raw)."""
    all_results = {
        "Arena.ai Text": {"closed": list(text_entries), "open": []},
        "Arena.ai Overall": {"closed": list(overall_entries), "open": []},
    }
    for bname, entries in (extra or {}).items():
        all_results[bname] = {"closed": list(entries), "open": []}
    ct, ot, benches, avg = build_unified_table(all_results)
    src, raw = merge_arena_columns(ct, ot, all_results, benches, avg)
    by_name = {r["name"]: r for r in ct + ot}
    return by_name, all_results, benches, avg, src, raw


# ── Case 1: Overall wins on dual-listed rows; fill on text-only rows ────
rows, all_results, benches, avg, src, raw = run_stations(
    # text station: raw Elo (rescaled by the fixed 900-1550 ladder at build)
    [("Claude Opus 5.5 (High)", 1513.7), ("Opus 4.6", 1500.0),
     ("Mid Tier", 1300.0)],
    # overall station: raw delta points
    [("Claude Opus 5.5 (Max)", 18.2), ("Claude Fable 5.2 (Max)", 28.6)],
)
check("benchmarks list renamed to 'Arena'", benches == ["Arena"], str(benches))
check("avg set renamed to 'Arena'", avg == ["Arena"], str(avg))
check("no station keys survive on rows",
      all("Arena.ai Text" not in r and "Arena.ai Overall" not in r
          for r in rows.values()),
      str([k for r in rows.values() for k in r if "Arena.ai" in k]))

opus = rows.get("Claude Opus 5.5")
check("dual row keeps ONE merged row",
      opus is not None and "Claude Opus 5.5 (Max)" not in rows
      and "Claude Opus 5.5 (High)" not in rows,
      str(sorted(rows)))
check("dual row takes the MEASURED Overall cell",
      opus and opus.get("Arena") == 80.3,
      str(opus and opus.get("Arena")) + " (expected (18.2+30)/60*100 = 80.3)")
check("dual row source = overall", src.get("Claude Opus 5.5") == "overall")
check("overall raw ships the delta", raw.get("Claude Opus 5.5") == 18.2,
      str(raw.get("Claude Opus 5.5")))

fable = rows.get("Claude Fable 5.2")
check("Overall-only model becomes a row (Fable 5.2 case)",
      fable is not None and fable.get("Arena") == 97.7,
      str(fable and fable.get("Arena")))
check("Overall-only model stays unranked (1 core cell)",
      fable is not None and fable.get("unranked") is True
      and fable.get("num_benchmarks") == 1,
      f"nb={fable and fable.get('num_benchmarks')} unranked={fable and fable.get('unranked')}")

o46 = rows.get("Opus 4.6")
check("text-only row filled (calibrated)", o46 is not None
      and src.get("Opus 4.6") == "text-calibrated",
      str(src.get("Opus 4.6")))
check("fill raw ships the input Elo", raw.get("Opus 4.6") == 1500.0,
      str(raw.get("Opus 4.6")))

mid = rows.get("Mid Tier")
check("fill is monotone in Elo (1500 > 1300 ⇒ fill(Opus4.6) >= fill(Mid))",
      o46 and mid and o46["Arena"] >= mid["Arena"],
      f"{o46 and o46['Arena']} vs {mid and mid['Arena']}")
check("fill bounded to the Overall board's observed range",
      mid is not None and 10.0 <= mid["Arena"] <= 98.0,
      str(mid and mid["Arena"]) + " (board deltas -23.9..28.6 on the (-30,30) ladder)")
check("fill never fabricates precision below the board floor",
      mid is not None and mid["Arena"] >= 10.1,
      str(mid and mid["Arena"]))

# ── Case 2: re-baked derived fields ───────────────────────────────────────
rows2, _, _, avg2, src2, _ = run_stations(
    [("Nova Prime 9 (High)", 1500.0), ("Old Relay 3", 1450.0)],
    [("Nova Prime 9 (Max)", 10.0)],
    extra={"Artificial Analysis": [("Nova Prime 9", 55.0), ("Old Relay 3", 40.0)],
           "BenchLM.ai": [("Nova Prime 9", 60.0), ("Old Relay 3", 45.0)]},
)
dm = rows2.get("Nova Prime 9")
check("dual model counts ONE Arena cell of the avg set",
      dm is not None and dm["num_benchmarks"] == 3 and dm["cl"] == 100.0,
      f"nb={dm and dm['num_benchmarks']} cl={dm and dm['cl']} "
      f"(AA+BenchLM+Arena, all 3 shipped stations covered)")
check("dual model ranked (>=2 core cells)", dm is not None
      and "unranked" not in dm)
to = rows2.get("Old Relay 3")
check("text-only model keeps its other cells",
      to is not None and to["num_benchmarks"] == 3,
      f"nb={to and to['num_benchmarks']}")

# ── Case 3: missing Overall station -> text-only fallback, loudly ────────
all_results = {
    "Arena.ai Text": {"closed": [("Solo", 1400.0)], "open": []},
}
ct, ot, benches3, avg3 = build_unified_table(all_results)
src3, raw3 = merge_arena_columns(ct, ot, all_results, benches3, avg3)
solo = next((r for r in ct + ot if r["name"] == "Solo"), None)
check("fallback keeps the text cell under the new name",
      solo is not None and solo.get("Arena") is not None,
      str(solo and solo.get("Arena")))
check("fallback stamps text-only provenance",
      src3.get("Solo") == "text-only" and isinstance(raw3.get("Solo"), float),
      str(src3.get("Solo")) + " / " + str(raw3.get("Solo")))
check("fallback renamed the lists", benches3 == ["Arena"] and avg3 == ["Arena"],
      f"{benches3} / {avg3}")

# ── Case 4: quantile helper sanity ────────────────────────────────────────
check("qq: mid quantile interpolates", _qq_quantile(0.5, [0, 10]) == 5.0)
check("qq: clamps to the sample range",
      _qq_quantile(0.0, [3.0, 7.0]) == 3.0 and _qq_quantile(1.0, [3.0, 7.0]) == 7.0)
check("qq: empty sample is None", _qq_quantile(0.5, []) is None)

print()
if FAILS:
    print(f"FAILED: {len(FAILS)} check(s): {FAILS}")
    sys.exit(1)
print("ALL ARENA MERGE CHECKS PASSED")
