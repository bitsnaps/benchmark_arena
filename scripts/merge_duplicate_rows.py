#!/usr/bin/env python3
"""stats-70: fold unified rows that are one model under two spellings.

build_unified_table() joins sources on normalize_model_name(), but rows that
reach public/ through other paths (prior-public carry-over, older snapshots)
can predate a normalize fix and sit side by side — "o3 2025.04 16" next to
"o3 (2025-04-16)", "Qwen3 235B-A22B" next to "Qwen3-235B-A22B". This pass
groups closed+open rows by the CURRENT normalize key and merges each group:

  keeper   = row with the most filled cells, then a name without scrape
             debris like "(120K, )", then the shorter name
             (build_unified_table's shortest-display rule)
  cells    = best score per benchmark (same keep-best as the scraper)
  derived  = num_benchmarks / cl / unranked recomputed from avg_benchmarks
  meta     = keeper's record, gaps filled from the absorbed records;
             absorbed records are dropped with their rows

stats-74: a second pass folds VENDOR-PREFIXED twins — AA shows "Tencent Hy4"
while other catalogs list the same id as plain "Hy4". Vendor prefixes change
the normalize key, so the stats-70 pass can never see them. Identity is the
catalog id, never the name shape: fold only when both records carry
models_meta with the SAME non-empty or_id, the prefix equals the record's
provider, and stripping it lands exactly on the twin's name. Keeper = the
vendor-prefixed display (the fuller name); same cell/meta merge discipline.

Usage: python3 scripts/merge_duplicate_rows.py [path] [--dry-run]
Self-test: python3 tests/test_merge_vendor_prefix.py
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bench_scraper import normalize_model_name  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB = os.path.join(REPO_ROOT, "public", "benchmark_results.json")


_DEBRIS = re.compile(r"\(\s*,|,\s*\)|\(\s*\)")


def _or_nk(raw):
    """Catalog-id norm key for stats-78 identity checks: lowercase, last
    '/' segment, non-alphanumerics dropped ('qwen/qwen-2.5-coder-32b-instruct'
    -> 'qwen25coder32binstruct'). None when empty."""
    if not raw:
        return None
    s = str(raw).lower().strip()
    i = s.rfind("/")
    if i != -1:
        s = s[i + 1:]
    s = re.sub(r"[^a-z0-9]", "", s)
    return s or None


def _filled(row, benches):
    return sum(1 for b in benches if row.get(b) is not None)


def _strip_vendor_prefix(name, provider):
    """'Tencent Hy4' -> 'Hy4' when name starts with '<provider> ' or
    '<provider>: ' (case-insensitive); None when it doesn't."""
    if not provider:
        return None
    for sep in (": ", " "):
        p = provider + sep
        if len(name) > len(p) and name.lower().startswith(p.lower()):
            return name[len(p):].strip()
    return None


def _rederive_group_scores(keeper, benches, avg):
    """Shared post-merge recompute: num_benchmarks / cl / unranked."""
    n_core = sum(1 for b in avg if keeper.get(b) is not None)
    keeper["num_benchmarks"] = n_core
    keeper["cl"] = round(n_core / len(avg) * 100, 1) if avg else 0
    if n_core >= 2:
        keeper.pop("unranked", None)
    else:
        keeper["unranked"] = True


def _gap_fill_meta(keeper_name, absorbed_names, meta):
    """meta[keeper_name] keeps its record; gaps filled from absorbed records
    (or_name stays the keeper's own display identity). Absorbed records are
    popped — they never render again. Control/triage fields (stats-78) never
    propagate: a registry-kept duplicate's no_bench_coverage describes the
    ABSORBED record's fate (cells gone upstream) and must not bless the
    keeper, whose own live cells would then trip the stats-62 guard; match /
    or_catalog_retired / superseded_by describe the variant's catalog fate
    or chain, equally non-transferable."""
    rec = meta.get(keeper_name)
    if rec is None:
        rec = meta[keeper_name] = {}
    for name in absorbed_names:
        other = meta.pop(name, None) or {}
        for k, v in other.items():
            if k in ("or_name", "no_bench_coverage", "match",
                     "or_catalog_retired", "superseded_by"):
                continue
            if rec.get(k) in (None, [], "") and v not in (None, [], ""):
                rec[k] = v
    return rec


def _drop_rows(doc, absorbed_rows):
    gone = {id(r) for _, r in absorbed_rows}
    for table in ("unified_closed", "unified_open"):
        doc[table] = [r for r in doc.get(table, []) if id(r) not in gone]
    return gone


def _formatting_folds(doc, log=print):
    """stats-78 (2026-11-12): fold rows that differ ONLY by formatting and
    carry the same catalog identity. Phase 1 groups by normalize_model_name,
    but the size-strip asymmetry can split ONE model into two keys: space-
    separated parameter sizes strip anywhere (\s+\d+B\b), while hyphenated
    catalog tails never matched that pattern — so 'Qwen2.5 Coder 32B
    Instruct' -> family key while 'Qwen2.5-Coder-32B-Instruct' kept its size
    and the unranked census admitted BOTH as rows (store invariant: 'no
    model appears twice under formatting-only spellings'). Never guess by
    name shape — the generic [a-z0-9] key also collides real variants
    ('Command R' vs 'Command R+'): fold only when BOTH records' models_meta
    agree on the same non-empty or_id norm key, exactly the stats-74
    discipline. Keeper = phase-1's own ordering (coverage desc, debris,
    shorter name, alphabetical); cells merge keep-best; derived fields
    recompute; meta gap-fills; absorbed rows + metas drop. Every fold is
    printed (leak contract). Tiers below (chain rewrite) re-point
    superseded_by AFTER folding, so targets resolve against final rows."""
    benches = doc.get("benchmarks") or []
    avg = doc.get("avg_benchmarks") or []
    meta = doc.setdefault("models_meta", {})
    rows = [(t, r) for t in ("unified_closed", "unified_open") for r in doc.get(t, [])]
    groups = {}
    for t, r in rows:
        k = re.sub(r"[^a-z0-9]", "", r["name"].lower())
        if k:
            groups.setdefault(k, []).append((t, r))
    merges = []
    done = set()
    for k in sorted(groups):
        members = [(t, r) for t, r in groups[k]
                   if id(r) not in done and r["name"] in meta]
        if len(members) < 2:
            continue
        orks = {_or_nk((meta[r["name"]] or {}).get("or_id")) for _, r in members
                if (meta.get(r["name"]) or {}).get("or_id")}
        if not orks or len(orks) > 1:
            log(f"  [Dedup-stats78] formatting-collision left unfolded "
                f"(missing/conflicting or_id {sorted(x for x in orks if x)}): "
                f"{[r['name'] for _, r in members]}")
            continue
        members.sort(key=lambda tr: (-_filled(tr[1], benches), bool(_DEBRIS.search(tr[1]["name"])),
                                     len(tr[1]["name"]), tr[1]["name"]))
        k_table, keeper = members[0]
        absorbed = [r for _, r in members[1:]]
        for r in absorbed:
            for b in benches:
                s = r.get(b)
                if s is not None and (keeper.get(b) is None or s > keeper[b]):
                    keeper[b] = s
        _rederive_group_scores(keeper, benches, avg)
        _gap_fill_meta(keeper["name"], [r["name"] for r in absorbed], meta)
        _drop_rows(doc, [(None, r) for r in absorbed])
        done |= {id(r) for r in absorbed}
        names = [r["name"] for r in absorbed]
        merges.append((keeper["name"], names))
        log(f"  [Dedup-stats78] {keeper['name']!r} ({k_table}) <- {names} "
            f"(same or_id {next(iter(orks))})")
    return merges


def merge_duplicate_rows(doc, log=print):
    """Mutates doc in place; returns [(keeper_name, [absorbed names])].
    Phase 1 (stats-70): same normalize-key spellings. Phase 1.5 (stats-78):
    formatting-variant twins with catalog-id-confirmed identity. Phase 2
    (stats-74): vendor-prefixed twins with catalog-id-confirmed identity."""
    benches = doc.get("benchmarks") or []
    avg = doc.get("avg_benchmarks") or []
    meta = doc.setdefault("models_meta", {})
    groups = {}
    for table in ("unified_closed", "unified_open"):
        for row in doc.get(table, []):
            groups.setdefault(normalize_model_name(row["name"]), []).append((table, row))

    merges = []
    for members in groups.values():
        if len(members) < 2:
            continue
        members.sort(key=lambda tr: (-_filled(tr[1], benches), bool(_DEBRIS.search(tr[1]["name"])),
                                     len(tr[1]["name"]), tr[1]["name"]))
        k_table, keeper = members[0]
        absorbed = [r for _, r in members[1:]]
        for r in absorbed:
            for b in benches:
                s = r.get(b)
                if s is not None and (keeper.get(b) is None or s > keeper[b]):
                    keeper[b] = s
        _rederive_group_scores(keeper, benches, avg)
        _gap_fill_meta(keeper["name"], [r["name"] for r in absorbed], meta)
        _drop_rows(doc, [(None, r) for r in absorbed])
        names = [r["name"] for r in absorbed]
        merges.append((keeper["name"], names))
        log(f"  [Dedup] {keeper['name']!r} ({k_table}) <- {names}")

    merges += _formatting_folds(doc, log=log)
    merges += _vendor_prefix_folds(doc, log=log)
    return merges


def _vendor_prefix_folds(doc, log=print):
    """stats-74: fold vendor-prefixed twins — AA shows 'Tencent Hy4' while
    other catalogs list the same id as plain 'Hy4'. A vendor prefix changes
    the normalize key, so the stats-70 pass never sees these. Identity is
    the CATALOG ID, never the name shape — fold only when ALL hold:
      - the prefixed row starts with '<provider> ' or '<provider>: '
        (case-insensitive), provider from its own meta record;
      - stripping the prefix lands exactly on another live row's name;
      - BOTH records carry models_meta with the SAME non-empty or_id.
    Any miss (no provider, no or_id, or_id mismatch, ambiguous base) is
    skipped — never guessed. Keeper = the vendor-prefixed display (the
    fuller name, e.g. 'Tencent Hy4'); cells merge keep-best; derived
    fields recompute; meta gap-fills; absorbed rows + their metas drop
    (printed — leak contract). Returns [(keeper_name, [absorbed names])]."""
    benches = doc.get("benchmarks") or []
    avg = doc.get("avg_benchmarks") or []
    meta = doc.setdefault("models_meta", {})
    rows = [(t, r) for t in ("unified_closed", "unified_open") for r in doc.get(t, [])]
    by_name = {}
    for t, r in rows:
        by_name.setdefault(r["name"].casefold(), []).append((t, r))

    merges = []
    done = set()  # ids of absorbed rows — never absorb or keep twice
    for t, p in rows:
        if id(p) in done:
            continue
        mp = meta.get(p["name"]) or {}
        provider = (mp.get("provider") or "").strip()
        base = _strip_vendor_prefix(p["name"], provider)
        oid = (mp.get("or_id") or "").strip()
        if not base or not oid:
            continue
        fold = []
        for t2, r2 in by_name.get(base.casefold(), []):
            if r2 is p or id(r2) in done:
                continue
            m2 = meta.get(r2["name"]) or {}
            if (m2.get("or_id") or "").strip() == oid:
                fold.append((t2, r2))
        if not fold:
            continue
        for b in benches:
            for _, r2 in fold:
                s = r2.get(b)
                if s is not None and (p.get(b) is None or s > p[b]):
                    p[b] = s
        _rederive_group_scores(p, benches, avg)
        _gap_fill_meta(p["name"], [r2["name"] for _, r2 in fold], meta)
        _drop_rows(doc, fold)
        done |= {id(r2) for _, r2 in fold}
        names = [r2["name"] for _, r2 in fold]
        merges.append((p["name"], names))
        log(f"  [Dedup-vendor] {p['name']!r} ({t}) <- {names} (same or_id {oid})")
    return merges


def main(argv):
    dry = "--dry-run" in argv
    paths = [a for a in argv if not a.startswith("--")] or [PUB]
    for path in paths:
        with open(path) as f:
            doc = json.load(f)
        merges = merge_duplicate_rows(doc)
        print(f"{path}: {len(merges)} duplicate group(s){' (dry run)' if dry else ''}")
        if merges and not dry:
            with open(path, "w") as f:
                json.dump(doc, f, indent=2, ensure_ascii=False)


if __name__ == "__main__":
    main(sys.argv[1:])
