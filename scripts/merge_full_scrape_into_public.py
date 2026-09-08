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
    shared = set(mp) & set(md)
    dl_only = set(md) - set(mp)
    pub_only = set(mp) - set(md)
    print(f"meta keys: shared={len(shared)} new-from-scrape={len(dl_only)} public-only-kept={len(pub_only)}")
    if dl_only:
        print("  adding:", ", ".join(sorted(dl_only)[:8]) + (" ..." if len(dl_only) > 8 else ""))
    if pub_only:
        print("  dropping (cells gone upstream):", ", ".join(sorted(pub_only)[:8]) + (" ..." if len(pub_only) > 8 else ""))

    restored = 0
    for k in shared:
        old = mp[k].get("available_at")
        if old:
            md[k]["available_at"] = old
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
