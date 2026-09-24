#!/usr/bin/env python3
"""stats-22: adopt a FULL fresh /bench scrape into public/.

Unlike merge_aa_into_public.py (meta-only overlay), a full scrape produces a
complete new document — fresh benchmark cells, unified tables, timestamp —
so the fresh download document is the BASE. The curated layers are then
reconciled:
  models_meta.available_at   restored on shared keys (hand-baked, db3ea19)
  public-only meta records   RETIRED — stats-43 oracle (Ibrahim, 2026-09-24):
                             "does anyone still sell it at a price?" beats
                             "did OpenRouter drop it?". OR keeps legacy
                             snapshots indefinitely (GPT-4o-Mini-2024-07-18
                             is still listed first-party + OR + Azure while
                             bench coverage moved on), and identity-only
                             models can live entirely off-OR (MiMo-V2-Flash
                             on Novita). So: a record whose cells vanished
                             from every fresh source is archived ONLY if no
                             gateway in the fresh providers.json still lists
                             it at a price (exact normKey join, no fuzzy
                             matching). Kept records are flagged
                             no_bench_coverage=true — meta-only registry
                             rows (no unified row => never render in the
                             leaderboard); they preserve curated pins
                             (available_at, created, hf id) so a future
                             re-adoption continues history instead of
                             forking a fresh record. Drops are printed so
                             the worklog archives them (nothing silently
                             lost).
Result written to BOTH copies so the deployed artifact and future
--meta-only bases agree.
"""
import json
import re

PUB = "/home/z/my-project/benchmark_arena/public/benchmark_results.json"
DL = "/home/z/my-project/download/benchmark_results.json"
PROV = "/home/z/my-project/benchmark_arena/public/providers.json"


def _norm_key(raw):
    """Twin of src/lib/pivot.js normKey() / bench_scraper._prov_norm_key():
    lowercase -> drop the org prefix (last '/' segment) -> strip every
    non-alphanumeric char. Exact-match join discipline, never fuzzy."""
    if not raw:
        return None
    s = str(raw).lower().strip()
    i = s.rfind("/")
    if i != -1:
        s = s[i + 1:]
    s = re.sub(r"[^a-z0-9]", "", s)
    return s or None


def _priced_listing_index():
    """normKey -> human-readable evidence, for every fresh providers.json
    listing that carries a numeric price (in and/or out). $0 counts (:free
    twins are real purchase options); null-priced catalog stubs (NIM,
    OpenCode Zen bare rows) do not. Free twins also index their base id —
    the unsuffixed listing the join discipline prefers."""
    prov = json.load(open(PROV))
    idx = {}
    for p in prov.get("providers") or []:
        seller = p.get("name") or p.get("slug") or "?"
        for m in p.get("models") or []:
            inn, out = m.get("in"), m.get("out")
            if not (isinstance(inn, (int, float)) or isinstance(out, (int, float))):
                continue
            srcs = [m.get("id")]
            if m.get("free") and m.get("base"):
                srcs.append(m.get("base"))
            for src in srcs:
                k = _norm_key(src)
                if k and k not in idx:
                    idx[k] = f"{m.get('id')} @ {seller} (in={inn} out={out})"
    return idx


def _listed_evidence(rec, meta_key, idx):
    """Evidence string if this record is priced somewhere, else None.
    Join ladder (both exact): or_id normKey first (the canonical OpenRouter
    id), then the display-name normKey (identity-only rows)."""
    for cand in (_norm_key(rec.get("or_id")), _norm_key(meta_key)):
        if cand and cand in idx:
            return f"{cand} -> {idx[cand]}"
    return None


def main():
    pub = json.load(open(PUB))
    dl = json.load(open(DL))
    mp, md = pub["models_meta"], dl["models_meta"]

    # stats-30: case-insensitive key join. The scrape doc owns key casing now
    # (display-casing canon in bench_scraper.py), so casing-only drift between
    # the fresh doc and the public meta must not fork a record into two
    # (stale lowercase key + fresh canon key). available_at follows the record.
    def lower_index(d):
        idx = {}
        for k in d:
            idx.setdefault(k.lower(), []).append(k)
        return idx

    pub_l, dl_l = lower_index(mp), lower_index(md)
    shared_l = set(pub_l) & set(dl_l)
    dl_only = [k for k in md if k.lower() not in shared_l]
    pub_only = [k for k in mp if k.lower() not in shared_l]
    ambiguous = {kk for kk in shared_l if len(pub_l[kk]) > 1 or len(dl_l[kk]) > 1}
    recased = sum(1 for kk in shared_l - ambiguous
                  if dl_l[kk][0] != pub_l[kk][0])
    print(f"meta keys: shared={sum(len(dl_l[kk]) for kk in shared_l)} "
          f"new-from-scrape={len(dl_only)} public-only-kept={len(pub_only)} "
          f"recased-on-adopt={recased}")
    if dl_only:
        print("  adding:", ", ".join(sorted(dl_only)[:8]) + (" ..." if len(dl_only) > 8 else ""))
    if pub_only:
        print("  dropping (cells gone upstream):", ", ".join(sorted(pub_only)[:8]) + (" ..." if len(pub_only) > 8 else ""))
    if ambiguous:
        print(f"  WARNING: {len(ambiguous)} case-ambiguous key group(s) — exact-match only")

    restored = 0
    for kk in shared_l - ambiguous:
        pk, dk = pub_l[kk][0], dl_l[kk][0]
        old = mp[pk].get("available_at")
        if old:
            md[dk]["available_at"] = old
            restored += 1
    priced_idx = _priced_listing_index() if pub_only else {}
    n_kept = 0
    for k in pub_only:
        rec = mp[k]
        evidence = _listed_evidence(rec, k, priced_idx)
        if evidence:
            rec["no_bench_coverage"] = True
            md[k] = rec
            n_kept += 1
            print(f"  KEEP {k}: cells gone from every fresh source, but still "
                  f"priced somewhere — kept as no_bench_coverage registry row:")
            print(f"    {evidence}")
        else:
            print(f"  DROP {k}: cells gone from every fresh source and no priced "
                  f"listing anywhere — archiving:")
            print(f"    or_id={rec.get('or_id')} pricing={rec.get('pricing_usd_per_1m')} "
                  f"available_at={json.dumps(rec.get('available_at'))}")
    dl["models_meta"] = md

    for path, obj in ((PUB, dl), (DL, dl)):
        with open(path, "w") as f:
            json.dump(obj, f, indent=2, ensure_ascii=False)
        print(f"wrote {path}")

    avail = sum(1 for v in md.values() if v.get("available_at"))
    aa = sum(1 for v in md.values() if v.get("pricing_aa_usd_per_1m"))
    orp = sum(1 for v in md.values() if (v.get("pricing_usd_per_1m") or {}).get("input") is not None)
    ttft = sum(1 for v in md.values() if v.get("aa_ttft_seconds") is not None)
    print(f"available_at restored on shared keys: {restored} (total records with sellers: {avail})")
    print(f"AA-priced: {aa} | OR-priced: {orp} | AA ttft stored: {ttft} | "
          f"meta total: {len(md)} (kept no-coverage registry rows: {n_kept})")
    print(f"timestamp: {dl.get('timestamp')} (was {pub.get('timestamp')})")


if __name__ == "__main__":
    main()
