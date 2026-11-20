#!/usr/bin/env python3
"""stats-87 self-test: the OpenRouter-only card-model census.

Plain-assert, no framework — run:

    python3 tests/test_card_models.py

Exits non-zero on any failure.

Contract (2026-11-17, Ibrahim approved): open-weight models listed on the
OpenRouter catalog that NO tracked benchmark scores surface as a
display-only census section — row-shaped entries with card=True and all
benchmark cells null, plus models_meta records (match='card') so pricing,
context and HF identity render. Selection discipline:
  · a catalog entry already matched to a ranked row is NEVER re-listed
  · normKey collisions with ranked names are excluded ('+' is
    identity-bearing — Command A vs Command A+ stay apart)
  · :thinking/:extended variants and anon/cloaked entries are out
  · stats-93 (B): a `:free` twin of a PRICED listing is out (the priced row
    represents the model); a FREE-ONLY base (no priced listing) enters the
    census when HF-verified — served by OpenRouter's own free tier
  · open-weight evidence = the catalog's hugging_face_id (no repo → out)
  · display-name twins dedupe, newest release wins
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "scripts"))
import bench_scraper as bs  # noqa: E402

# stats-93 (C): the real curated lane must never fire during fixture runs
# (network fetches + non-deterministic sort order) — cleared for the whole
# file; the C section below installs its own lane fixture and restores this
# cleared state afterwards.
bs.CURATED_HF_LANE = []

FAILS = []


def check(name, ok, detail=""):
    print(f"{'ok' if ok else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


def entry(eid, name, hf=None, created=None, ctx=32768):
    return {
        "id": eid,
        "name": name,
        "created": created or 0,
        "context_length": ctx,
        "architecture": {
            "modality": "text->text",
            "input_modalities": ["text"],
            "output_modalities": ["text"],
            "tokenizer": "Test",
        },
        "top_provider": {"context_length": ctx, "max_completion_tokens": 8192},
        "pricing": {"prompt": "0.0000001", "completion": "0.0000004"},
        "hugging_face_id": hf,
        "supported_parameters": [],
        "description": "test model",
    }


# 2026-epoch timestamps (ordering must be provable, not all-1970)
T_MAR = 1774000000   # ~2026-03
T_MAY = 1779000000   # ~2026-05
T_NOV = 1794000000   # ~2026-11


BENCHES = ["Artificial Analysis", "BenchLM.ai", "Arena"]

# ── fixture universe ──────────────────────────────────────────────────────
# Ranked rows already matched: 'Vendor A: Alpha 2' + 'Cohere: Command A+'.
OR_CATALOG = [
    entry("vendor-a/alpha-2", "Vendor A: Alpha 2", hf="vendor-a/alpha-2", created=T_NOV),
    entry("cohere/command-a-plus", "Cohere: Command A+", hf="CohereForAI/c4ai-command-a-plus", created=T_NOV),
    # genuinely unbenchmarked open models
    entry("meituan-longcat/longcat-2.0", "Meituan: LongCat 2.0", hf="meituan-longcat/LongCat-2.0", created=T_NOV),
    entry("vend/omega-9b", "Vendor B: Omega 9B", hf="vend/omega-9b", created=T_MAY),
    # stats-93 (B): FREE-ONLY bases — no priced listing exists for these ids
    entry("baidu/ernie-5-5-flash-preview:free", "Baidu: ERNIE-5.5-Flash-Preview (free)",
          hf="baidu/ERNIE-5.5-Flash-Preview", created=T_NOV),
    entry("vend/flint-v1.0:free", "Vendor D: Flint (free)", hf="vend/flint", created=T_MAY),
    # must be EXCLUDED:
    entry("vend/alpha-2:free", "Vendor A: Alpha 2 (free)", hf="vendor-a/alpha-2"),  # :free twin of a PRICED listing
    entry("vend/thinky:thinking", "Vendor B: Thinky (thinking)", hf="vend/thinky"),  # non-free variant
    entry("anon/silent-1", "OpenRouter: Silent 1", hf="anon/silent-1", created=T_NOV),  # anon org
    entry("closed-vendor/sealed-70b", "ClosedCorp: Sealed 70B", hf=None),             # no HF repo
    entry("baidu/secret-preview:free", "Baidu: Secret Preview (free)", hf=None),      # free-only but no HF repo
    entry("cohere/command-a", "Cohere: Command A", hf="CohereForAI/c4ai-command-a", created=T_MAR),  # kept: '+' is identity
    # display twins — same normalized base, newest wins
    entry("vend/omega-9b-old", "Vendor C: Omega 9B", hf="vend/omega-old", created=T_MAR),
]

UNIFIED_ROWS = [
    {"name": "Alpha 2"},
    {"name": "Command A+"},
]

cards, meta = bs.collect_card_models(UNIFIED_ROWS, BENCHES, or_models=OR_CATALOG)
names = [r["name"] for r in cards]

check("unbenchmarked open models listed", "LongCat 2.0" in names and "Omega 9B" in names, str(names))
check("ranked twins excluded (matched id)", "Alpha 2" not in names)
check("'+' keeps identity (Command A stays, Command A+ ranked)", "Command A" in names)
check(":free twin of a priced listing excluded", not any(n == "Alpha 2 (free)" for n in names), str(names))
check("non-free variants excluded", not any("Thinky" in n for n in names), str(names))
check("stats-93 (B): free-only model admitted, '(free)' stripped from the row name",
      "ERNIE-5.5-Flash-Preview" in names and "Flint" in names, str(names))
check("stats-93 (B): free-only meta keeps the real listing id",
      meta.get("ERNIE-5.5-Flash-Preview", {}).get("or_id") == "baidu/ernie-5-5-flash-preview:free",
      str(meta.get("ERNIE-5.5-Flash-Preview", {}).get("or_id")))
check("free-only without an HF repo excluded (open-weight unverifiable)",
      not any("Secret" in n for n in names), str(names))
check("anon/cloaked entries excluded", not any("Silent" in n for n in names))
check("no-HF-repo entries excluded (open-weight unverifiable)", not any("Sealed" in n for n in names))
check("display twins deduped to one entry", sum(1 for n in names if "Omega" in n) == 1, str(names))

# newest twin wins: Omega 9B meta must carry vend/omega-9b (created=300)
omega = [n for n in names if "Omega" in n][0]
check("newest twin wins", meta[omega]["or_id"] == "vend/omega-9b", meta[omega]["or_id"])

# row shape (first OR-census row — the lane may sort ahead of it)
row = next(r for r in cards if not r.get("hf_only"))
check("row carries card flag + zero coverage",
      row.get("card") is True and row["num_benchmarks"] == 0 and row["cl"] == 0)
check("every benchmark cell ships null",
      all(row[b] is None for b in BENCHES) and row.get("Epoch ECI") is None)

# meta shape
m = meta[row["name"]]
check("card meta record built (match=card, HF id kept)",
      m.get("match") == "card" and m.get("hugging_face_id") is not None and m.get("or_id"))

# ordering: newest release first, undated sink, then name
dated = [meta[r["name"]]["created"] or "" for r in cards]
check("newest-first ordering", dated == sorted(dated, reverse=True), str(dated))

# noise-token twin of a ranked row folds out (same product, no new info),
# but a DATED twin stays distinct (variant discipline, stats-70)
NOISE_CATALOG = OR_CATALOG + [
    entry("vendor-a/alpha-2-thinking", "Vendor A: Alpha 2 Thinking", hf="vendor-a/alpha-2-thinking", created=T_NOV),
    entry("vend/omega-9b-0731", "Vendor B: Omega 9B 0731", hf="vend/omega-9b-0731", created=T_MAR),
]
cards2, _ = bs.collect_card_models(UNIFIED_ROWS, BENCHES, or_models=NOISE_CATALOG)
names2 = [r["name"] for r in cards2]
check("noise-token twin excluded via the symmetric fold",
      not any(n == "Alpha 2 Thinking" for n in names2), str(names2))
check("dated twin stays distinct (variant discipline)",
      any("0731" in n for n in names2), str(names2))

# empty catalog -> empty census (a failed fetch never fabricates rows)
cards3, meta3 = bs.collect_card_models(UNIFIED_ROWS, BENCHES, or_models=[])
check("empty catalog -> empty census", cards3 == [] and meta3 == {})

# ── stats-93 (C): curated HF-only lane ────────────────────────────────────
LANE_META = {
    "vend/HfOnly-7B": {"created": "2026-11-01", "downloads": 123, "likes": 5,
                       "pipeline_tag": "text-generation"},
    "meituan-longcat/LongCat-2.0": {"created": "2026-07-05", "downloads": 1,
                                    "likes": 2, "pipeline_tag": "text-generation"},
}
LANE_PARAMS = {"vend/HfOnly-7B": 7.6}
_orig_lane, _orig_fetch, _orig_params = (
    bs.CURATED_HF_LANE, bs._hf_lane_fetch_meta, bs.fetch_hf_param_counts)
bs._hf_lane_fetch_meta = lambda ids: {k: LANE_META.get(k) for k in ids}
bs.fetch_hf_param_counts = lambda ids: dict(LANE_PARAMS)
try:
    bs.CURATED_HF_LANE = [
        {"hf_id": "vend/HfOnly-7B", "added": "2026-11-20"},                # admitted
        {"hf_id": "meituan-longcat/LongCat-2.0", "added": "2026-11-20"},   # graduated (OR has meituan-longcat/longcat-2.0)
        {"hf_id": "vend/HfOnly-7B-GGUF", "added": "2026-11-20"},           # quant safety net
        {"hf_id": "vendor-a/Alpha-2", "added": "2026-11-20"},              # covered: ranked 'Alpha 2'
    ]
    cards4, meta4 = bs.collect_card_models(UNIFIED_ROWS, BENCHES, or_models=OR_CATALOG)
finally:
    bs.CURATED_HF_LANE, bs._hf_lane_fetch_meta, bs.fetch_hf_param_counts = (
        _orig_lane, _orig_fetch, _orig_params)
names4 = [r["name"] for r in cards4]

check("stats-93 (C): lane row admitted alongside the OR census",
      "HfOnly-7B" in names4 and "LongCat 2.0" in names4, str(names4))
check("stats-93 (C): graduated repo NOT duplicated",
      sum(1 for n in names4 if "LongCat" in n) == 1, str(names4))
check("stats-93 (C): quant-suffix repo skipped",
      not any("GGUF" in n for n in names4), str(names4))
check("stats-93 (C): covered-key twin skipped",
      not any("Alpha-2" in n or "Alpha 2 hf" in n.lower() for n in names4), str(names4))
row4 = next(r for r in cards4 if r["name"] == "HfOnly-7B")
check("stats-93 (C): lane row shape (card + hf_only + zero coverage)",
      row4.get("card") is True and row4.get("hf_only") is True
      and row4["num_benchmarks"] == 0 and row4["cl"] == 0
      and all(row4[b] is None for b in BENCHES))
m4 = meta4["HfOnly-7B"]
check("stats-93 (C): lane meta (match=curated-hf, hf_only, HF id, params)",
      m4.get("match") == "curated-hf" and m4.get("hf_only") is True
      and m4.get("hugging_face_id") == "vend/HfOnly-7B"
      and m4.get("total_params_b") == 7.6
      and m4.get("hf_lane_added") == "2026-11-20"
      and m4.get("or_id") is None, str({k: m4.get(k) for k in ("match", "hf_only", "total_params_b")}))
check("stats-93 (C): lane rows join the newest-first census sort",
      [meta4[n]["created"] or "" for n in names4]
      == sorted([meta4[n]["created"] or "" for n in names4], reverse=True),
      str([meta4[n]["created"] for n in names4]))

print()
if FAILS:
    print(f"{len(FAILS)} check(s) FAILED: {FAILS}")
    sys.exit(1)
print("all stats-87 card-model checks passed")
