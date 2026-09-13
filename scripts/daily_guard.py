#!/usr/bin/env python3
"""stats-29 daily-refresh sanity guard — unattended-run protection.

Compares the freshly merged public/*.json against git HEAD before anything
gets committed. Catches the known unattended failure modes:
  - merge that silently kept a stale document (timestamp age)
  - mass row loss from an upstream layout change (the stats-28 AA incident class)
  - the AA pricing/TTFT miner matching nothing (silent -> dark latency layer)

Exit 0 = safe to commit. Exit 1 = ABORT (nothing committed), reason printed.
Run from the repo root (daily_refresh.sh does this).
"""
import json
import subprocess
import sys
from datetime import datetime, timezone

PUB = "public/benchmark_results.json"
PROV = "public/providers.json"
STAMP_FMT = "%Y-%m-%d %H:%M"


def fail(msg):
    print(f"GUARD FAIL {msg}")
    sys.exit(1)


def head_json(path):
    raw = subprocess.run(
        ["git", "show", f"HEAD:{path}"], capture_output=True, check=True
    )
    return json.loads(raw.stdout)


def rows_of(doc):
    return len(doc.get("unified_closed") or []) + len(doc.get("unified_open") or [])


def meta_stats(doc):
    mm = doc.get("models_meta") or {}
    ttft = sum(1 for v in mm.values() if v.get("aa_ttft_seconds"))
    created = sum(1 for v in mm.values() if v.get("created"))
    mods = sum(1 for v in mm.values() if v.get("input_modalities"))
    return mm, ttft, created, mods


def main():
    try:
        doc = json.load(open(PUB))
    except Exception as e:  # noqa: BLE001
        fail(f"public/benchmark_results.json unreadable: {e}")
    head = head_json(PUB)

    # 1. freshness — the merge must have adopted a document scraped just now
    ts = str(doc.get("timestamp", ""))
    try:
        tsv = datetime.strptime(ts, STAMP_FMT).replace(tzinfo=timezone.utc)
    except ValueError:
        fail(f"timestamp malformed: {ts!r} (expected YYYY-MM-DD HH:MM)")
    age_h = (datetime.now(timezone.utc) - tsv).total_seconds() / 3600
    if age_h > 6:
        fail(f"timestamp {ts} is {age_h:.1f}h old - merge did not adopt a fresh scrape")

    # 2. row-count band vs HEAD (collapse = upstream layout change; explosion = dedup broken)
    r_new, r_old = rows_of(doc), rows_of(head)
    if r_new < max(90, int(r_old * 0.85)):
        fail(f"row count collapsed: {r_new} vs HEAD {r_old} (upstream layout change?)")
    if r_new > int(r_old * 1.3) + 10:
        fail(f"row count exploded: {r_new} vs HEAD {r_old} (dedup broken?)")

    # 3. meta layer — absolute floor + gentle shrink allowance (archivals happen)
    mm, tt_new, cr_new, mod_new = meta_stats(doc)
    _, tt_old, cr_old, mod_old = meta_stats(head)
    n_old = len(head.get("models_meta") or {})
    if len(mm) < max(95, n_old - 10):
        fail(f"models_meta shrank: {len(mm)} vs HEAD {n_old}")
    if tt_new < max(40, int(tt_old * 0.6)):
        fail(
            f"AA TTFT coverage collapsed: {tt_new} vs HEAD {tt_old} "
            "- miner likely matched nothing (see stats-28 AA payload incident)"
        )
    if cr_new < cr_old - 10:
        fail(f"created coverage shrank: {cr_new} vs HEAD {cr_old}")

    # 3b. stats-34: modality coverage — the enrichment ladder only ever adds
    # coverage, so a collapse means the OR modality miner itself broke.
    # Enrichment sources (HF/AA) degrading to the OR baseline alone is a
    # non-fatal GUARD NOTE, not a failed refresh.
    if mod_new < max(85, mod_old - 15):
        fail(f"modality coverage collapsed: {mod_new} vs HEAD {mod_old}")
    if mod_new < mod_old:
        print(f"GUARD NOTE modality coverage {mod_new} < HEAD {mod_old} "
              f"(HF/AA enrichment partial today — non-fatal)")

    # 4. providers.json sanity (rebuilt by the same scraper run)
    try:
        prov = json.load(open(PROV))
        prov_head = head_json(PROV)

        def n_entities(x):
            if isinstance(x, list):
                return len(x)
            if isinstance(x, dict):
                return len(x.get("providers") or x)
            return 0

        if n_entities(prov) < max(5, int(n_entities(prov_head) * 0.8)):
            fail(
                f"providers.json shrank: {n_entities(prov)} vs HEAD {n_entities(prov_head)}"
            )
    except (FileNotFoundError, subprocess.CalledProcessError):
        pass  # not tracked at HEAD yet / optional on this run

    # 5. report summary (agent pastes this into the Discord update)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    fresh = 0
    for v in mm.values():
        c = v.get("created")
        if not c:
            continue
        try:
            age_d = (now - datetime.strptime(c[:10], "%Y-%m-%d")).days
            if age_d <= 7:
                fresh += 1
        except ValueError:
            continue
    print(
        f"GUARD OK rows={r_new} (HEAD {r_old}) meta={len(mm)} "
        f"aa_ttft={tt_new} created={cr_new} modalities={mod_new} approx_new_7d={fresh} ts={ts}"
    )


if __name__ == "__main__":
    main()
