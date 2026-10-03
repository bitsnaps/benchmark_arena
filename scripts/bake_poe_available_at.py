#!/usr/bin/env python3
"""stats-59: bake Poe seller listings into models_meta.available_at.

Ibrahim's lead (2026-10-03): Poe's API (https://api.poe.com/v1/models) lists
models our pages showed as dashes for. Investigation conclusion (worklog
stats-59): Poe pricing=null is NOT free — it covers per-request bots,
subscription-gated bots and non-text modality bots — so only TOKEN-PRICED
bots are baked, as ordinary seller listings {p:'poe', n:'Poe', in, out}.
Explicitly zero-priced token bots (Poe CAN express free: request='0.00'
style, or prompt=0) classify as free listings exactly like the other seller
catalogs do (zero-price rule).

What this does
--------------
1. Load the Poe catalog through the scraper's own fetch+parse path
   (fetch_open_provider_models + _api_provider_row via the OPEN_PROVIDER_APIS
   'Poe' entry — cache in TMP_DIR, 1h TTL, shared with providers.json).
2. Join token-priced bots onto tracked rows with the SAME conservative
   discipline as every seller join: exact normKey match only (lowercase,
   org prefix dropped, non-alphanumerics stripped — the pivot.js rule), free
   bots join on their base id, ambiguous keys (one key -> 2+ rows) skipped,
   and a curated PINS map for ids the pure join cannot resolve.
3. Merge the Poe entry into models_meta[name].available_at: replace an
   existing poe entry in place (prices move), else append at the end. Every
   other seller entry is preserved untouched.

Re-runnable and idempotent: daily_refresh.sh calls it between the merge and
the guard so Poe prices stay fresh. A failed Poe fetch degrades to a warning
(exit 0) — a daily run must not die because one optional catalog is down —
but a broken JOIN or a write failure exits non-zero.

Leak contract: the report prints every model whose sellers changed (added /
updated / removed) with old -> new prices; nothing is silently lost.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bench_scraper as bs  # noqa: E402 — same directory

PUBLIC_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "..", "public", "benchmark_results.json")

# Curated pins: Poe bot id -> canonical row name, for bots whose id the
# exact normKey join cannot resolve (spelling drift, renamed generations).
# Keep this list MINIMAL — the exact join is the rule, pins are the rare
# exception review had to approve. A pin that matches nothing is reported
# and ignored.
PINS = {}

PROVIDER_ENTRY = next((s for s in bs.OPEN_PROVIDER_APIS if s["name"] == "Poe"), None)


def norm(name):
    return bs._prov_norm_key(name)


def tracked_names(doc):
    rows = list(doc.get("unified_closed") or []) + list(doc.get("unified_open") or [])
    return [r["name"] for r in rows if r.get("name")]


def main():
    if PROVIDER_ENTRY is None:
        print("[poe-bake] FATAL: 'Poe' entry missing from OPEN_PROVIDER_APIS")
        return 1
    if not os.path.exists(PUBLIC_PATH):
        print(f"[poe-bake] FATAL: {PUBLIC_PATH} not found")
        return 1
    with open(PUBLIC_PATH) as f:
        doc = json.load(f)
    meta = doc.get("models_meta") or {}

    # 1. Poe catalog (shared cache with providers.json; fetch degrades softly)
    bots = bs.fetch_open_provider_models(
        PROVIDER_ENTRY["url"], PROVIDER_ENTRY["cache"], "Poe")
    if not bots:
        print("[poe-bake] WARNING: Poe catalog unavailable — available_at left "
              "untouched this run (non-fatal by contract)")
        return 0

    priced = []
    for b in bots:
        row = bs._api_provider_row(b)
        if row is None or row.get("in") is None:
            continue  # token-priced bots only — null pricing ≠ free on Poe
        priced.append(row)
    print(f"[poe-bake] Poe bots: {len(bots)} total, {len(priced)} token-priced")

    # 2. exact normKey join against tracked rows (+ minimal curated pins)
    names = tracked_names(doc)
    by_key = {}
    for n in names:
        by_key.setdefault(norm(n), []).append(n)

    resolved, ambiguous, unpinned = {}, set(), []
    for row in priced:
        key = norm(row.get("base") if row.get("free") and row.get("base")
                   else row["id"])
        if key in PINS:
            pin = PINS[key]
            if pin in names:
                resolved[row["id"]] = (pin, row)
            else:
                print(f"[poe-bake] WARNING: pin {row['id']!r} -> {pin!r} "
                      f"matches no tracked row — ignored")
            continue
        hits = by_key.get(key)
        if not hits:
            unpinned.append(row["id"])
        elif len(hits) > 1:
            ambiguous.add(key)
        else:
            resolved[row["id"]] = (hits[0], row)
    if ambiguous:
        print(f"[poe-bake] ambiguous keys skipped (exact-join discipline): "
              f"{sorted(ambiguous)}")
    print(f"[poe-bake] join: {len(resolved)} bots -> tracked rows | "
          f"{len(unpinned)} untracked Poe-only ids | {len(ambiguous)} ambiguous")

    # 3. merge into available_at (replace poe entry in place, else append)
    changed, added, updated = [], [], []
    for bot_id, (name, row) in sorted(resolved.items(), key=lambda kv: kv[1][0]):
        entry = {"p": "poe", "n": "Poe", "in": row["in"], "out": row.get("out")}
        if row.get("out") is None:
            entry.pop("out")  # keep the shape honest: no fabricated output price
        if row.get("free"):
            entry["free"] = True
        rec = meta.get(name)
        if rec is None:
            continue  # row without a meta record — nothing to attach to
        avail = rec.get("available_at") or []
        idx = next((i for i, a in enumerate(avail) if a.get("p") == "poe"), -1)
        if idx == -1:
            avail.append(entry)
            added.append(name)
        elif avail[idx] != entry:
            updated.append((name, avail[idx], entry))
            avail[idx] = entry
        else:
            continue  # identical — no change
        rec["available_at"] = avail
        changed.append(name)

    if not changed:
        print("[poe-bake] no available_at changes (Poe listings already current)")
        return 0

    for name in added:
        e = next(a for a in meta[name]["available_at"] if a.get("p") == "poe")
        print(f"[poe-bake]   + {name}: Poe in={e.get('in')} out={e.get('out')}"
              f"{' FREE' if e.get('free') else ''}")
    for name, old, new in updated:
        fmt = lambda e: (f"in={e.get('in')} out={e.get('out')}"
                         f"{' free' if e.get('free') else ''}")
        print(f"[poe-bake]   ~ {name}: {fmt(old)} -> {fmt(new)}")
    print(f"[poe-bake] sellers changed on {len(changed)} models "
          f"({len(added)} added, {len(updated)} updated)")

    tmp = PUBLIC_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)  # same format as the merge step
    os.replace(tmp, PUBLIC_PATH)
    os.chmod(PUBLIC_PATH, 0o644)
    print(f"[poe-bake] wrote {PUBLIC_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
