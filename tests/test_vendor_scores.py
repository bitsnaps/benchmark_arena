#!/usr/bin/env python3
"""stats-91 self-test: the creator-reported (vendor) score lane.

Plain-assert, no framework — run:

    python3 tests/test_vendor_scores.py

Exits non-zero on any failure.

Contract (2026-11-19, Ibrahim approved): open-weight census models whose
creators publish their own eval numbers get them baked onto card_models
rows ONLY, with per-score provenance. Red lines:
  · ranked rows (unified_open / unified_closed) NEVER carry vendor_scores
    — a self-reported number must stay one namespace away from the Score
    blend (leak_detector asserts the same at refresh time)
  · every score ships benchmark (verbatim card wording), score in [0, 100],
    qualifier in {in-house, cited, reported} and source in {card, hf-eval}
  · hf-eval records carry their structured provenance when the source
    provides it (reported_date / reported_url)
  · model-level provenance: vendor_source_url matches the row's HF id
"""
import json
import os
import re
import sys

FAILS = []


def check(name, ok, detail=""):
    print(f"{'ok' if ok else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOC = os.path.join(ROOT, "public", "benchmark_results.json")
doc = json.load(open(DOC, encoding="utf-8"))
cards = doc.get("card_models") or []
meta = doc.get("models_meta") or {}

QUALIFIERS = {"in-house", "cited", "reported"}
SOURCES = {"card", "hf-eval"}

with_scores = [r for r in cards if r.get("vendor_scores")]
total = sum(len(r["vendor_scores"]) for r in with_scores)
check("census carries vendor scores", total > 0, f"{total} scores on {len(with_scores)} rows")
check("vendor models are a minority of the census (honest gaps allowed)",
      len(with_scores) <= len(cards), f"{len(with_scores)}/{len(cards)}")

# ── red line: ranked rows stay clean ──
leaks = []
for uni in ("unified_open", "unified_closed"):
    for r in doc.get(uni) or []:
        if "vendor_scores" in r:
            leaks.append(r.get("name"))
check("no ranked row carries vendor_scores", not leaks, ", ".join(leaks[:5]))

# ── per-record contract ──
bad_schema, bad_range, bad_enum, bad_url, bad_hf = [], [], [], [], []
url_re = re.compile(r"^https://huggingface\.co/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
for r in with_scores:
    hf = (meta.get(r["name"]) or {}).get("hugging_face_id")
    if not r.get("vendor_source_url") or not url_re.match(r["vendor_source_url"]):
        bad_url.append(r["name"])
    if hf and r["vendor_source_url"] != f"https://huggingface.co/{hf}":
        bad_hf.append(r["name"])
    if not r.get("vendor_extracted_at"):
        bad_schema.append(f"{r['name']}: no extracted_at")
    for s in r["vendor_scores"]:
        label = f"{r['name']}/{s.get('benchmark')}"
        if not isinstance(s.get("benchmark"), str) or len(s["benchmark"]) < 2 \
                or not isinstance(s.get("score"), (int, float)):
            bad_schema.append(label)
        elif not (0 <= s["score"] <= 100):
            bad_range.append(f"{label}={s['score']}")
        if s.get("qualifier") not in QUALIFIERS or s.get("source") not in SOURCES:
            bad_enum.append(label)
check("every record has benchmark + numeric score", not bad_schema, "; ".join(bad_schema[:4]))
check("all scores within [0, 100]", not bad_range, "; ".join(bad_range[:4]))
check("qualifier/source enums hold", not bad_enum, "; ".join(bad_enum[:4]))
check("vendor_source_url well-formed on every row", not bad_url, ", ".join(bad_url[:4]))
check("vendor_source_url matches the row's HF id", not bad_hf, ", ".join(bad_hf[:4]))

# ── structured lane carries provenance when the source provides it ──
hf_recs = [s for r in with_scores for s in r["vendor_scores"] if s["source"] == "hf-eval"]
check("structured (hf-eval) lane present", len(hf_recs) > 0, f"{len(hf_recs)} records")
missing_prov = [f"{r['name']}/{s['benchmark']}" for r in with_scores
                for s in r["vendor_scores"] if s["source"] == "hf-eval"
                and not (s.get("reported_date") or s.get("reported_url"))]
check("hf-eval records carry date or source url", not missing_prov, "; ".join(missing_prov[:4]))

# ── known anchors (fail loudly if the lane silently empties) ──
# stats-91 wrote these against the 2026-11-19 snapshot; census cards churn
# by design (stats-93: "removals/dedup stay the daily refresh's honest
# business"), so an anchor whose card LEFT the census goes dormant with a
# NOTE instead of failing — but a card that IS still in the census and has
# lost its anchored score fails loudly (that's the silent-empty class the
# anchors exist for; caught live 2026-11-22 when a cold-cache bake shipped
# LongCat 2.0 + Motif 3 as empty gaps).
by_name = {r["name"]: {s["benchmark"]: s["score"] for s in r.get("vendor_scores", [])} for r in cards}
census_names = {r.get("name") for r in cards}
for card, anchor_bench, anchor_val, label in (
    ("LongCat 2.0", "GPQA-diamond", 88.9, "LongCat 2.0 GPQA-diamond 88.9 (Ibrahim's example)"),
    ("LongCat 2.0", "SWE-bench Pro", 59.5, "LongCat 2.0 SWE-bench Pro 59.5"),
    ("Motif 3", "SWE-bench Verified", 76.2, "Motif 3 structured SWE-bench Verified 76.2"),
):
    if card not in census_names:
        print(f"NOTE  anchor dormant — {card} left the census (card churn)")
        continue
    check(label, (by_name.get(card) or {}).get(anchor_bench) == anchor_val,
          str((by_name.get(card) or {}).get(anchor_bench)))

print(f"vendor lane: {total} scores across {len(with_scores)} census models")
if FAILS:
    print(f"FAILED: {len(FAILS)} check(s)")
    sys.exit(1)
print("OK: vendor lane contract holds")
