#!/usr/bin/env python3
"""stats-32 one-shot backfill: re-derive models_meta.superseded_by in the
published JSON snapshots using the PATCHED bench_scraper.parse_series
(MMDD snapshot tails + v-prefixed versions).

Why one-shot: the fix is pure meta re-derivation from or_id/created — no
network, no re-scrape, no drift risk. Tomorrow's daily run reproduces the
same links through the patched scraper end-to-end (dry-run verified:
exactly 2 new links, 0 removed).

Clean-derivation discipline: every existing superseded_by is cleared first,
then the SAME pipeline as the scraper's meta build runs fresh —
annotate_supersession() + apply_supersede_overrides() in the scraper's own
call order (stale-by-age is left untouched: it is a pure function of
created dates and is unaffected by this fix) — never a patch on a patch.
"""
import json
import sys

sys.path.insert(0, "/home/z/my-project/benchmark_arena/scripts")
from bench_scraper import annotate_supersession, apply_supersede_overrides

PATHS = [
    "/home/z/my-project/benchmark_arena/public/benchmark_results.json",
    "/home/z/my-project/download/benchmark_results.json",
]


def main():
    for path in PATHS:
        with open(path) as f:
            doc = json.load(f)
        meta = doc["models_meta"]

        before = {k: m.get("superseded_by") for k, m in meta.items()
                  if m.get("superseded_by")}
        for m in meta.values():
            m.pop("superseded_by", None)
        row_names = [r["name"] for r in doc.get("unified_closed", [])] + \
                    [r["name"] for r in doc.get("unified_open", [])]
        n = annotate_supersession(meta)
        n_ov = apply_supersede_overrides(meta, row_names)
        after = {k: m.get("superseded_by") for k, m in meta.items()
                 if m.get("superseded_by")}

        added = {k: v for k, v in after.items() if before.get(k) != v}
        removed = {k: v for k, v in before.items() if after.get(k) != v}

        print(f"== {path}")
        print(f"   superseded_by links: {len(before)} -> {len(after)} "
              f"(auto {n}, overrides {n_ov})")
        print(f"   -- added/changed ({len(added)}):")
        for k in sorted(added):
            print(f"      {k!r:<44} -> {added[k]!r}")
        print(f"   -- removed/changed-away ({len(removed)}):")
        for k in sorted(removed):
            print(f"      {k!r:<44} (was: {removed[k]!r})")

        # hard expectations — refuse to write anything unexpected
        expect = {
            "DeepSeek V4 Flash": "DeepSeek V4 Flash 0731",
            "DeepSeek V4 Pro": "DeepSeek V4 Pro 0813",
        }
        for k, v in expect.items():
            assert after.get(k) == v, f"expectation violated: {k!r} -> {after.get(k)!r}"
        assert set(added) == set(expect), f"unexpected extra links: {sorted(added)}"
        assert not removed, f"unexpected removals: {removed}"

        with open(path, "w") as f:
            json.dump(doc, f, indent=2, ensure_ascii=False)
        print("   written (indent=2, ensure_ascii=False, no trailing newline)")

    print("\nBACKFILL OK")


if __name__ == "__main__":
    main()
