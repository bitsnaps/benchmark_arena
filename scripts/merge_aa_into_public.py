#!/usr/bin/env python3
"""stats-19 (extended stats-22): merge the AA pricing layer + fresher OR
fields from the latest scrape in download/ onto the LIVE public meta (which
carries the hand-baked available_at layer no scraper rebuild can produce).

Direction of truth per field:
  pricing_aa_usd_per_1m / price_source / aa_ttft_seconds  <- download (fresh AA mine)
  pricing_usd_per_1m / max_output_tokens                  <- download (fresher OR fetch)
  everything else (available_at, or_id, hf, supersession, stale...) <- public

Key drift (stats-22: full /bench re-scrape): model universes can differ.
  shared keys        -> overlay the fields above (available_at preserved)
  download-only keys -> ADDED verbatim (brand-new models need their meta)
  public-only keys   -> KEPT untouched (curated rows; never regress)
Result written to BOTH copies so the deployed artifact and future
--meta-only bases agree.
"""
import json

PUB = "/home/z/my-project/benchmark_arena/public/benchmark_results.json"
DL = "/home/z/my-project/download/benchmark_results.json"

AA_FIELDS = ("pricing_aa_usd_per_1m", "price_source", "aa_ttft_seconds")
OR_FIELDS = ("pricing_usd_per_1m", "max_output_tokens")


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
        print("  keeping (curated):", ", ".join(sorted(pub_only)[:8]) + (" ..." if len(pub_only) > 8 else ""))

    n_aa = n_or = n_rows_touched = 0
    for k in shared:
        rec, src = mp[k], md[k]
        touched = False
        for f in AA_FIELDS:
            v = src.get(f)
            if v != rec.get(f):
                rec[f] = v
                touched = True
                if f == "pricing_aa_usd_per_1m" and v:
                    n_aa += 1
        for f in OR_FIELDS:
            v = src.get(f)
            if v is not None and v != rec.get(f):
                rec[f] = v
                touched = True
                if f == "pricing_usd_per_1m":
                    n_or += 1
        if touched:
            n_rows_touched += 1
    for k in dl_only:
        mp[k] = md[k]

    pub["models_meta"] = mp
    for path, obj in ((PUB, pub), (DL, pub)):
        with open(path, "w") as f:
            json.dump(obj, f, indent=2, ensure_ascii=False)
        print(f"wrote {path}")

    aa_total = sum(1 for v in mp.values() if v.get("pricing_aa_usd_per_1m"))
    aa_src = sum(1 for v in mp.values() if v.get("price_source") == "artificialanalysis")
    avail = sum(1 for v in mp.values() if v.get("available_at"))
    orp = sum(1 for v in mp.values() if (v.get("pricing_usd_per_1m") or {}).get("input") is not None)
    print(f"AA attached now: {aa_total} (price_source=artificialanalysis: {aa_src})")
    print(f"available_at preserved: {avail} | OR-priced records: {orp}")
    print(f"merged OR price updates: {n_or} | rows touched: {n_rows_touched} | meta total: {len(mp)}")


if __name__ == "__main__":
    main()
