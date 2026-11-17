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
  · :free/:thinking/:extended variants and anon/cloaked entries are out
  · open-weight evidence = the catalog's hugging_face_id (no repo → out)
  · display-name twins dedupe, newest release wins
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


BENCHES = ["Artificial Analysis", "BenchLM.ai", "Arena.ai Text"]

# ── fixture universe ──────────────────────────────────────────────────────
# Ranked rows already matched: 'Vendor A: Alpha 2' + 'Cohere: Command A+'.
OR_CATALOG = [
    entry("vendor-a/alpha-2", "Vendor A: Alpha 2", hf="vendor-a/alpha-2", created=T_NOV),
    entry("cohere/command-a-plus", "Cohere: Command A+", hf="CohereForAI/c4ai-command-a-plus", created=T_NOV),
    # genuinely unbenchmarked open models
    entry("meituan-longcat/longcat-2.0", "Meituan: LongCat 2.0", hf="meituan-longcat/LongCat-2.0", created=T_NOV),
    entry("vend/omega-9b", "Vendor B: Omega 9B", hf="vend/omega-9b", created=T_MAY),
    # must be EXCLUDED:
    entry("vend/alpha-2:free", "Vendor A: Alpha 2 (free)", hf="vendor-a/alpha-2"),  # :free variant
    entry("anon/silent-1", "OpenRouter: Silent 1", hf="anon/silent-1", created=T_NOV),  # anon org
    entry("closed-vendor/sealed-70b", "ClosedCorp: Sealed 70B", hf=None),             # no HF repo
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
check(":free variants excluded", not any(":free" in n.lower() or "free" in n.lower() for n in names))
check("anon/cloaked entries excluded", not any("Silent" in n for n in names))
check("no-HF-repo entries excluded (open-weight unverifiable)", not any("Sealed" in n for n in names))
check("display twins deduped to one entry", sum(1 for n in names if "Omega" in n) == 1, str(names))

# newest twin wins: Omega 9B meta must carry vend/omega-9b (created=300)
omega = [n for n in names if "Omega" in n][0]
check("newest twin wins", meta[omega]["or_id"] == "vend/omega-9b", meta[omega]["or_id"])

# row shape
row = cards[0]
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
      not any("Thinking" in n for n in names2), str(names2))
check("dated twin stays distinct (variant discipline)",
      any("0731" in n for n in names2), str(names2))

# empty catalog -> empty census (a failed fetch never fabricates rows)
cards3, meta3 = bs.collect_card_models(UNIFIED_ROWS, BENCHES, or_models=[])
check("empty catalog -> empty census", cards3 == [] and meta3 == {})

print()
if FAILS:
    print(f"{len(FAILS)} check(s) FAILED: {FAILS}")
    sys.exit(1)
print("all stats-87 card-model checks passed")
