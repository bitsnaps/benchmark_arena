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
import re
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


def ranked_rows_of(doc):
    """stats-65: unranked rows (1-benchmark admissions) live in the same
    tables but must not count toward the collapse/explosion band — the
    feature itself adds ~90 of them on its first run (a false explosion).
    The band watches the RANKED population; unranked counts are reported."""
    return sum(
        1 for r in (doc.get("unified_closed") or []) + (doc.get("unified_open") or [])
        if not r.get("unranked")
    )


def meta_stats(doc):
    mm = doc.get("models_meta") or {}
    ttft = sum(1 for v in mm.values() if v.get("aa_ttft_seconds"))
    created = sum(1 for v in mm.values() if v.get("created"))
    mods = sum(1 for v in mm.values() if v.get("input_modalities"))
    return mm, ttft, created, mods


def _nk(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


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
    #    stats-65: band runs on RANKED rows only — the unranked section is
    #    new-size-free and reported in the summary line instead.
    r_new, r_old = ranked_rows_of(doc), ranked_rows_of(head)
    n_unranked = rows_of(doc) - r_new
    if r_new < max(90, int(r_old * 0.85)):
        fail(f"ranked row count collapsed: {r_new} vs HEAD {r_old} (upstream layout change?)")
    if r_new > int(r_old * 1.3) + 10:
        fail(f"ranked row count exploded: {r_new} vs HEAD {r_old} (dedup broken?)")
    if n_unranked > 450:
        # stats-65 reality check: the AA census payload ships ~350 single-source
        # no-catalog stubs on top of the ~65 matched rows — 360+ unranked rows
        # is the EXPECTED first-run size (2026-10-24), not an admission bug.
        fail(f"unranked section exploded: {n_unranked} rows (admission broken?)")

    # 3. meta layer — absolute floor + gentle shrink allowance (archivals happen)
    mm, tt_new, cr_new, mod_new = meta_stats(doc)
    _, tt_old, cr_old, mod_old = meta_stats(head)
    n_old = len(head.get("models_meta") or {})
    if len(mm) < max(95, n_old - 10):
        fail(f"models_meta shrank: {len(mm)} vs HEAD {n_old}")
    # 3a. AA TTFT floor — deprecation-aware (stats-62, 2026-10-18): AA
    # retires the payload latency/price records of models its census stubs
    # flag deprecated, so a coverage drop explained by vendor deprecation
    # (aa_deprecated set on the merged record) is a GUARD NOTE, while an
    # unexplained collapse still fails (the stats-28 miner-death class).
    mm_n = {}
    for k, v in mm.items():
        mm_n.setdefault(_nk(k), (k, v))
    lost_tt = []
    for k, v in (head.get("models_meta") or {}).items():
        if not (isinstance(v, dict) and v.get("aa_ttft_seconds")):
            continue
        hit = mm_n.get(_nk(k))
        if not hit or not (isinstance(hit[1], dict) and hit[1].get("aa_ttft_seconds")):
            lost_tt.append(k)
    dep_lost = [k for k in lost_tt
                if isinstance(mm_n.get(_nk(k)), tuple)
                and (mm_n[_nk(k)][1] or {}).get("aa_deprecated")]
    unexpl = [k for k in lost_tt if _nk(k) not in {_nk(x) for x in dep_lost}]
    if tt_new < max(40, int(tt_old * 0.6)):
        if tt_new < 20 or len(unexpl) > 10:
            fail(
                f"AA TTFT coverage collapsed: {tt_new} vs HEAD {tt_old} "
                f"({len(unexpl)} losses NOT explained by aa_deprecated "
                "- miner breakage? see stats-28)"
            )
        print(
            f"GUARD NOTE AA TTFT {tt_new} < HEAD {tt_old}: {len(dep_lost)} losses "
            f"are vendor-deprecated (stats-62 stub census), {len(unexpl)} unexplained "
            "- non-fatal"
        )
    if cr_new < cr_old - 10:
        fail(f"created coverage shrank: {cr_new} vs HEAD {cr_old}")

    # 3b. stats-62: census completeness — every RANKED unified row must have a
    # meta record, and no live row may carry the registry-only
    # no_bench_coverage flag (the cells-vs-registry contradiction that
    # mis-shipped on 10-18). stats-65: unranked rows are exempt from the
    # meta floor — a not-yet-cataloged new model (no OpenRouter match, e.g.
    # a launch-day AA-only row) is exactly the case the unranked section
    # exists for; it gets a GUARD NOTE for visibility instead.
    all_rows = (doc.get("unified_closed") or []) + (doc.get("unified_open") or [])
    row_names = {r.get("name") for r in all_rows}
    row_names.discard(None)
    unranked_names = {r.get("name") for r in all_rows if r.get("unranked")}
    no_meta = sorted(n for n in row_names if n not in mm)
    no_meta_ranked = sorted(n for n in no_meta if n not in unranked_names)
    if len(no_meta_ranked) > 3:
        fail(
            f"{len(no_meta_ranked)} ranked unified rows lost their meta records (OR-retirement "
            f"class, stats-62): {no_meta_ranked[:6]}"
        )
    if no_meta_ranked:
        print(f"GUARD NOTE {len(no_meta_ranked)} ranked row(s) without meta record: {no_meta_ranked[:4]}")
    if no_meta:
        print(f"GUARD NOTE {len(no_meta)} unranked row(s) without meta record "
              f"(expected for launch-day rows not yet in the provider catalog): {no_meta[:4]}")
    false_reg = sorted(
        n for n in row_names
        if isinstance(mm.get(n), dict) and mm[n].get("no_bench_coverage")
    )
    if false_reg:
        fail(
            f"{len(false_reg)} live row(s) flagged no_bench_coverage — "
            f"cells-vs-registry contradiction (stats-62): {false_reg[:6]}"
        )

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
        f"GUARD OK rows={r_new} ranked (+{n_unranked} unranked) (HEAD {r_old}) meta={len(mm)} "
        f"aa_ttft={tt_new} created={cr_new} modalities={mod_new} approx_new_7d={fresh} ts={ts}"
    )


if __name__ == "__main__":
    main()
