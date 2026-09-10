#!/usr/bin/env python3
"""stats-22: adopt a FULL fresh /bench scrape into public/.

Unlike merge_aa_into_public.py (meta-only overlay), a full scrape produces a
complete new document — fresh benchmark cells, unified tables, timestamp —
so the fresh download document is the BASE. The curated layers are then
reconciled:
  models_meta.available_at   restored on shared keys (hand-baked, db3ea19)
  public-only meta records   DROPPED — their benchmark cells vanished from
                             every source, so no row renders and the leak
                             contract (flagged meta <=> unified rows) would
                             fail; the dropped values are printed so the
                             worklog archives them (nothing silently lost)
Result written to BOTH copies so the deployed artifact and future
--meta-only bases agree.
"""
import json

PUB = "/home/z/my-project/benchmark_arena/public/benchmark_results.json"
DL = "/home/z/my-project/download/benchmark_results.json"


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
    for k in pub_only:
        rec = mp[k]
        print(f"  DROP {k}: cells gone from every fresh source — archiving:")
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
    print(f"AA-priced: {aa} | OR-priced: {orp} | AA ttft stored: {ttft} | meta total: {len(md)}")
    print(f"timestamp: {dl.get('timestamp')} (was {pub.get('timestamp')})")


if __name__ == "__main__":
    main()
