#!/usr/bin/env python3
"""stats-82 self-test: ECI attach layer (parse + strict join + retention).

Plain-assert, no framework — run:

    python3 tests/test_eci_attach.py

Exits non-zero on any failure.

Background (2026-11-16, Ibrahim approved design): the Epoch Capabilities
Index (epoch.ai/data/eci_scores.csv, CC-BY 4.0) ships as a first-class
column with hard rules — RAW index values (never rescaled, never in the
Score blend), strict normKey join (no fuzzy, no aliases: the stats-81
wrong-join lesson), no new rows (ECI-only models stay out of the catalog),
and archive-over-remove: a cell Epoch drops keeps its last published value
with its old vintage instead of erasing.
"""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "scripts"))
import bench_scraper as bs  # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(f"{'ok' if ok else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


def rows_of(rows):
    return {r["name"]: r for r in rows}


tmp = tempfile.mkdtemp()
prior_path = os.path.join(tmp, "prior.json")
bs.RESULTS_PUBLIC_PATH = prior_path

# ── Case 1: strict join, raw values, meta, no new rows ──────────────────
closed = [{"name": "Claude Fable 5.2", "num_benchmarks": 6, "Artificial Analysis": 65.0}]
open_rows = [{"name": "Qwen3.5 Flash", "num_benchmarks": 4}]
json.dump({"unified_closed": [], "unified_open": [], "models_meta": {}}, open(prior_path, "w"))

eci_map = {
    bs.normalize_model_name("Claude Fable 5.2"): {"eci": 173.44, "lo": 169.93, "hi": 177.49, "vintage": "2026-11-09"},
    bs.normalize_model_name("Kimi K3.1 Pro"): {"eci": 161.9, "lo": 159.0, "hi": 164.8, "vintage": "2026-11-09"},
}
meta_handle = {}
matched, adopted = bs.attach_eci_cells(closed, open_rows, models_meta=meta_handle, eci_map=eci_map)

allrows = rows_of(closed + open_rows)
check("matched exactly the covered model", matched == 1, str(matched))
check("nothing retained when nothing is prior", adopted == 0, str(adopted))
check("cell attached to the right row",
      allrows["Claude Fable 5.2"].get("Epoch ECI") == 173.44,
      str(allrows["Claude Fable 5.2"].get("Epoch ECI")))
check("RAW value shipped (not rescaled to 0-100)",
      allrows["Claude Fable 5.2"]["Epoch ECI"] > 100)
check("models_meta.eci_ci written",
      meta_handle.get("Claude Fable 5.2", {}).get("eci_ci") == [169.93, 177.49],
      str(meta_handle.get("Claude Fable 5.2", {})))
check("models_meta.eci_vintage written",
      meta_handle.get("Claude Fable 5.2", {}).get("eci_vintage") == "2026-11-09")
check("ECI-only model did NOT become a row",
      all(x.get("Epoch ECI") is None for x in closed + open_rows if x["name"] != "Claude Fable 5.2"))

# ── Case 2: retention — a model dropped from the CSV keeps its cell ─────
prior2 = {
    "unified_closed": [{"name": "GPT-5.5 Pro", "Epoch ECI": 163.2}],
    "unified_open": [],
    "models_meta": {"GPT-5.5 Pro": {"eci_ci": [160.0, 166.0], "eci_vintage": "2026-11-01"}},
}
json.dump(prior2, open(prior_path, "w"))
closed3 = [{"name": "GPT-5.5 Pro", "num_benchmarks": 5}]
meta3 = {}
matched3, adopted3 = bs.attach_eci_cells(closed3, [], models_meta=meta3, eci_map={
    bs.normalize_model_name("Claude Fable 5.2"): {"eci": 173.44, "lo": 169.9, "hi": 177.5, "vintage": "2026-11-09"},
})
r3 = rows_of(closed3)
check("dropped-from-CSV model retained its cell",
      r3["GPT-5.5 Pro"].get("Epoch ECI") == 163.2,
      str(r3["GPT-5.5 Pro"].get("Epoch ECI")))
check("retention carried the OLD vintage",
      meta3.get("GPT-5.5 Pro", {}).get("eci_vintage") == "2026-11-01",
      str(meta3.get("GPT-5.5 Pro", {})))
check("retention counted", matched3 == 0 and adopted3 == 1, f"m={matched3} a={adopted3}")

# ── Case 3: CSV parser — ambiguous keys collapse, never guessed ─────────
csv_text = ("Model,Display name,eci,eci_ci_low,eci_ci_high,date\n"
            "GPT-5.5,GPT-5.5,160.0,158,162,2026-11-09\n"
            "GPT-5.5 (High),GPT-5.5 (High),163.0,160,166,2026-11-09\n"
            "Claude Fable 5.2,Claude Fable 5.2,173.44,169.93,177.49,2026-11-09\n")
parsed = bs._eci_parse_csv(csv_text)
check("ambiguous collapse drops the key (no guess)", "gpt 5.5" not in parsed, str(sorted(parsed)))
check("unambiguous model parsed with vintage",
      parsed.get("claude fable 5.2", {}).get("eci") == 173.44
      and parsed.get("claude fable 5.2", {}).get("vintage") == "2026-11-09",
      str(parsed.get("claude fable 5.2", {})))
check("identical-value duplicates do NOT drop the key",
      bs._eci_parse_csv(csv_text.replace("163.0,160,166", "160.0,158,162")).get("gpt 5.5") is not None)

print()
if FAILS:
    print(f"FAILED: {len(FAILS)} check(s): {FAILS}")
    sys.exit(1)
print("ALL ECI ATTACH CHECKS PASSED")
