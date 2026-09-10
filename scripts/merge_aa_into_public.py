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

    # stats-30: case-insensitive key join + casing adoption. Public meta stays
    # the base (hand-baked available_at layer), but where the fresh scrape
    # spells a shared key differently and the public key is all-lowercase,
    # the scraper's canonical casing is adopted (key renamed, record kept).
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
    print(f"meta keys: shared={sum(len(dl_l[kk]) for kk in shared_l)} "
          f"new-from-scrape={len(dl_only)} public-only-kept={len(pub_only)}")
    if dl_only:
        print("  adding:", ", ".join(sorted(dl_only)[:8]) + (" ..." if len(dl_only) > 8 else ""))
    if pub_only:
        print("  keeping (curated):", ", ".join(sorted(pub_only)[:8]) + (" ..." if len(pub_only) > 8 else ""))
    if ambiguous:
        print(f"  WARNING: {len(ambiguous)} case-ambiguous key group(s) — exact-match only")

    # adopt scraper key casing on 1:1 shared pairs where the public key is
    # all-lowercase (stats-30 display-casing canon)
    key_moves = {}
    for kk in shared_l - ambiguous:
        pk, dk = pub_l[kk][0], dl_l[kk][0]
        if pk != dk and pk == pk.lower():
            if dk in mp:
                print(f"  [Casing] SKIP key rename {pk!r} -> {dk!r} (collision)")
                continue
            key_moves[pk] = dk
    for old, new in key_moves.items():
        mp[new] = mp.pop(old)
    if key_moves:
        print(f"  [Casing] adopted scraper casing on {len(key_moves)} meta key(s): "
              + ", ".join(f"{o!r}->{n!r}" for o, n in sorted(key_moves.items())[:6])
              + (" ..." if len(key_moves) > 6 else ""))

    n_aa = n_or = n_rows_touched = 0
    for kk in shared_l - ambiguous:
        pk, dk = pub_l[kk][0], dl_l[kk][0]
        rec, src = mp[key_moves.get(pk, pk)], md[dk]
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
