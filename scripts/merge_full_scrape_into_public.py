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

    # stats-61 (2026-10-07, Ibrahim): sources started emitting cosmetic
    # renames ("GPT-5.4 mini" -> "GPT 5.4 Mini", dashes->spaces). Lowercase
    # join misses those, forking records (stale key kept as a registry row
    # + fresh key without history) and leaving AA/TTFT joins + superseded_by
    # chains dangling. normKey (the app's own identity: lowercase, drop org
    # prefix, strip non-alphanumerics) folds every observed rename pair with
    # zero collisions. Same-record test: unique normKey on BOTH sides.
    def normkey_index(d):
        idx = {}
        for k in d:
            nk = _norm_key(k)
            if nk:
                idx.setdefault(nk, []).append(k)
        return idx

    pub_n, dl_n = normkey_index(mp), normkey_index(md)
    lower_shared = set(pub_l) & set(dl_l)
    norm_shared = (set(pub_n) & set(dl_n)) - {
        nk for nk in set(pub_n) & set(dl_n)
        if len(pub_n[nk]) > 1 or len(dl_n[nk]) > 1
    }
    # Renamed pairs = normKey-shared but NOT already lowercase-shared.
    renamed = []
    seen_pk = set()
    for nk in sorted(norm_shared):
        pk, dk = pub_n[nk][0], dl_n[nk][0]
        if pk.lower() in lower_shared and dk.lower() in lower_shared:
            continue  # already joined by the case-insensitive path
        renamed.append((pk, dk))
        seen_pk.add(pk)
    if renamed:
        print(f"meta keys: {len(renamed)} renamed record(s) re-joined via normKey "
              f"(stats-61) — history follows the fresh name:")
        for pk, dk in renamed[:10]:
            print(f"  RENAME {pk} -> {dk}")
        if len(renamed) > 10:
            print(f"  ... and {len(renamed) - 10} more")

    shared_l = set(pub_l) & set(dl_l)
    dl_only = [k for k in md if k.lower() not in shared_l and _norm_key(k) not in norm_shared]
    pub_only = [k for k in mp if k.lower() not in shared_l
                and _norm_key(k) not in norm_shared]
    ambiguous = {kk for kk in shared_l if len(pub_l[kk]) > 1 or len(dl_l[kk]) > 1}
    recased = sum(1 for kk in shared_l - ambiguous
                  if dl_l[kk][0] != pub_l[kk][0])
    print(f"meta keys: shared={sum(len(dl_l[kk]) for kk in shared_l) + len(renamed)} "
          f"(case {sum(len(dl_l[kk]) for kk in shared_l)} + renamed {len(renamed)}) "
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
    # stats-61: renamed records carry their history onto the fresh key too.
    for pk, dk in renamed:
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

    # stats-61: re-point superseded_by chains that still name a pre-rename
    # variant. Identity = normKey; rewrite only when the target is NOT a
    # live unified row (the contract test resolves against rows) and the
    # normKey match is unique. Registry rows (kept above) are left alone
    # when no fresh twin exists — the monitor still sees them.
    row_names = {r.get("name") for r in dl.get("unified_closed", [])}
    row_names |= {r.get("name") for r in dl.get("unified_open", [])}
    row_nk = {}
    for nm in row_names:
        nk = _norm_key(nm)
        if nk:
            row_nk.setdefault(nk, []).append(nm)
    rewrites = 0
    for k, rec in md.items():
        tgt = rec.get("superseded_by")
        if not tgt or tgt in row_names:
            continue
        nk = _norm_key(tgt)
        cands = row_nk.get(nk) if nk else None
        if cands and len(cands) == 1:
            print(f"  CHAIN {k}: superseded_by {tgt} -> {cands[0]} (rename drift)")
            rec["superseded_by"] = cands[0]
            rewrites += 1
    if rewrites:
        print(f"superseded_by chains re-pointed: {rewrites}")

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
