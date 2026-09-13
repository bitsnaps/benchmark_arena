#!/usr/bin/env python3
"""stats-35 one-shot backfill: re-derive the older-model annotations in the
published JSON snapshots using the PATCHED bench_scraper chain:

  fill_created_from_names   (stats-35: name-embedded dates -> created)
  annotate_supersession     (stats-35: letter-rule parse_series, M3/K3 join)
  apply_supersede_overrides (unchanged; fills empty only)
  annotate_stale_by_age     (now also ages the name-dated rows)
  annotate_legacy_bare_names(unchanged)
  annotate_aa_deprecation   (stats-35: vendor deprecated/deprecatedTo flag)

Why one-shot: every input is already in the snapshot (or_id, created,
display names) plus the AA deprecation cache mined at /tmp — no network,
no re-scrape. Tomorrow's daily full scrape reproduces the same flags
end-to-end through the patched scraper (dryrun_stats35_repo_chain.py
verified on the shipped snapshot BEFORE this backfill).

Clean-derivation discipline: derived flags (superseded_by, stale,
aa_deprecated, aa_deprecated_to) are cleared first, then the SAME chain as
the scraper's meta build runs fresh in the scraper's own call order —
never a patch on a patch. Raw fields (created, or_id, ...) are untouched.
"""
import json
import sys

sys.path.insert(0, "/home/z/my-project/benchmark_arena/scripts")
from bench_scraper import (
    fill_created_from_names,
    annotate_supersession,
    apply_supersede_overrides,
    annotate_stale_by_age,
    annotate_legacy_bare_names,
    annotate_aa_deprecation,
)

PATHS = [
    "/home/z/my-project/benchmark_arena/public/benchmark_results.json",
    "/home/z/my-project/download/benchmark_results.json",
]

DERIVED = ("superseded_by", "stale", "aa_deprecated", "aa_deprecated_to")


def older_of(meta, name):
    r = meta.get(name) or {}
    return bool(r.get("superseded_by") or r.get("stale"))


def main():
    for path in PATHS:
        with open(path) as f:
            doc = json.load(f)
        meta = doc["models_meta"]
        row_names = [r["name"] for r in doc.get("unified_closed", [])] + \
                    [r["name"] for r in doc.get("unified_open", [])]

        shipped_older = {n: older_of(meta, n) for n in row_names}
        shipped_sup = {k: m.get("superseded_by") for k, m in meta.items()
                       if m.get("superseded_by")}
        shipped_stale = {k for k, m in meta.items() if m.get("stale")}

        for m in meta.values():
            for k in DERIVED:
                m.pop(k, None)

        n_fill = fill_created_from_names(meta, set(row_names))
        n_sup = annotate_supersession(meta)
        n_ov = apply_supersede_overrides(meta, row_names)
        n_stale = annotate_stale_by_age(meta, row_names)
        n_bare = annotate_legacy_bare_names(meta, row_names)
        n_dep, n_tgt, n_agree = annotate_aa_deprecation(meta, row_names)

        after_sup = {k: m.get("superseded_by") for k, m in meta.items()
                     if m.get("superseded_by")}
        after_stale = {k for k, m in meta.items() if m.get("stale")}
        after_older = {n: older_of(meta, n) for n in row_names}

        newly = sorted(n for n in row_names
                       if after_older[n] and not shipped_older.get(n))
        unhidden = sorted(n for n in row_names
                          if not after_older[n] and shipped_older.get(n))

        print(f"== {path}")
        print(f"   chain: fill={n_fill} sup={n_sup} ov={n_ov} stale={n_stale} "
              f"bare={n_bare} aa_dep={n_dep} (targeted={n_tgt}, agree={n_agree})")
        print(f"   sup links: {len(shipped_sup)} -> {len(after_sup)}; "
              f"stale rows: {len(shipped_stale)} -> {len(after_stale)}")
        print(f"   newly OLDER ({len(newly)}): {newly}")
        print(f"   UN-hidden ({len(unhidden)}): {unhidden or 'NONE'}")
        for n in newly:
            r = meta.get(n) or {}
            print(f"      {n:30s} sup={r.get('superseded_by')!r} "
                  f"stale={r.get('stale')} aa_dep={r.get('aa_deprecated')} "
                  f"created={r.get('created')}")

        # ── hard expectations from the approved dry-run (2026-09-13) ──
        assert not unhidden, f"REGRESSION: hidden rows became current: {unhidden}"
        assert n_fill == 2, f"expected 2 name-date backfills, got {n_fill}"
        for k, v in {"GPT 4o Mini 2024.07 18": "2024-07-18",
                     "o3 2025.04 16": "2025-04-16"}.items():
            assert (meta.get(k) or {}).get("created") == v, f"created backfill {k}"
        expected_sup_changes = {
            "MiniMax M2.7": ("MiniMax-M3", shipped_sup.get("MiniMax M2.7")),
            "MiniMax M2.5": ("MiniMax-M3", "MiniMax M2.7"),
            "Kimi K2.5": ("Kimi K3", "Kimi K2.6"),
            "Kimi K2.6": ("Kimi K3", "Kimi K2.7 Code"),
        }
        for k, (new, old) in expected_sup_changes.items():
            assert after_sup.get(k) == new, \
                f"sup expectation {k!r}: {after_sup.get(k)!r} != {new!r}"
            if old is not None:
                assert shipped_sup.get(k) == old, \
                    f"shipped sup drift {k!r}: {shipped_sup.get(k)!r} != {old!r}"
        extra_sup = {k: v for k, v in after_sup.items()
                     if shipped_sup.get(k) != v and k not in expected_sup_changes}
        assert not extra_sup, f"unexpected sup changes: {extra_sup}"
        expected_newly_stale = {"GPT 4o Mini 2024.07 18", "o3 2025.04 16",
                                "GPT-5.4 nano", "MiMo-V2-Flash"}
        extra_stale = after_stale - shipped_stale
        assert extra_stale == expected_newly_stale, \
            f"stale diff: extra={extra_stale} expected={expected_newly_stale}"
        assert set(newly) == (expected_newly_stale | {"MiniMax M2.7"}), \
            f"newly-older set drifted: {newly}"

        with open(path, "w") as f:
            json.dump(doc, f, indent=2, ensure_ascii=False)
        print("   written")

    print("\nSTATS-35 BACKFILL OK")


if __name__ == "__main__":
    main()
