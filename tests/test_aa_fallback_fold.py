#!/usr/bin/env python3
"""stats-80 self-test for the AA '(effort, Default Fallback)' naming fold in
scripts/bench_scraper.py. Plain-assert, no framework — run:

    python3 tests/test_aa_fallback_fold.py

Exits non-zero on any failure.

Background (2026-11-12, Ibrahim): AA renamed its per-effort rows from
'(Adaptive Reasoning, Max Effort, Default Fallback)' to the compact
'(Max, Default Fallback)' / '(Xhigh, Default Fallback)' / ... spelling.
normalize_model_name's effort-paren rule stripped bare '(max)' and
'(max with fallback)' but NOT the new comma-tail form, so every variant
row became a no-catalog census row (15 rows across the Claude
Fable 5.2 / Opus 5.5 / Sonnet 5.5 families on the 2026-11-12 doc) instead
of folding into the family base under the documented effort-variant
keep-best policy (stats-28). The regex now treats
'<effort>(,|with) [default] fallback' as ONE config marker.

The spelled-out '(Adaptive Reasoning, Max Effort, Default Fallback)' shape
STAYS unfolded here on purpose: it is handled by the AA pricing family
ladder (_aa_base_name) only, and row identity must never guess across a
multi-word variant block.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "scripts"))
from bench_scraper import (  # noqa: E402
    normalize_model_name,
    clean_display_name,
)

FAILS = []


def check(name, ok, detail=""):
    print(f"{'ok' if ok else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


# ── 1. The observed census spellings fold into the family base ───────────
for base, efforts in [
    ("Claude Fable 5.2", ["Max", "Xhigh", "High", "Medium", "Low"]),
    ("Claude Opus 5.5", ["Max", "Xhigh", "High", "Medium", "Low"]),
    ("Claude Sonnet 5.5", ["High", "Medium", "Low"]),
]:
    nb = normalize_model_name(base)
    for e in efforts:
        v = normalize_model_name(f"{base} ({e}, Default Fallback)")
        check(f"fold {base} ({e}, Default Fallback)", v == nb, f"{v!r}")

# ── 2. Pre-existing fold forms keep working (no regression) ──────────────
check("fold '(Max)' — the dataset display spelling",
      normalize_model_name("Claude Fable 5.2 (Max)")
      == normalize_model_name("Claude Fable 5.2"))
check("fold '(High)'", normalize_model_name("Gemini 4 Carbon (High)")
      == normalize_model_name("Gemini 4 Carbon"))
check("fold '(max with fallback)'",
      normalize_model_name("GPT-6.1 Sol (max with fallback)")
      == normalize_model_name("GPT-6.1 Sol"))
check("fold '(Non-reasoning)'",
      normalize_model_name("Claude Opus 4.5 (Non-reasoning)")
      == normalize_model_name("Claude Opus 4.5"))

# ── 3. Identity guards — never overfold ──────────────────────────────────
check("distinct versions stay distinct",
      normalize_model_name("Claude Fable 5.2 (Max, Default Fallback)")
      != normalize_model_name("Claude Fable 5.1"))
check("spelled-out AA pricing form stays unfolded (row identity)",
      normalize_model_name(
          "Claude Fable 5.2 (Adaptive Reasoning, Max Effort, Default Fallback)")
      != normalize_model_name("Claude Fable 5.2"))
check("dated snapshots stay distinct",
      normalize_model_name("DeepSeek V4 Pro (High) 20260813")
      != normalize_model_name("DeepSeek V4 Pro"))
check("effort still distinct from effort+version",
      normalize_model_name("GPT-5.2 (High, Default Fallback)")
      != normalize_model_name("GPT-5.2 High 20260813"))

# ── 4. Display layer agrees ──────────────────────────────────────────────
check("display strip removes the combined tail",
      clean_display_name("Claude Fable 5.2 (Max, Default Fallback)")
      == "Claude Fable 5.2",
      repr(clean_display_name("Claude Fable 5.2 (Max, Default Fallback)")))
check("display keeps meaningful variant words",
      clean_display_name("Kimi K3 Pro").lower().endswith("pro"))

if FAILS:
    print(f"\ntest_aa_fallback_fold: {len(FAILS)} FAILED")
    sys.exit(1)
print("\ntest_aa_fallback_fold: all passed")
