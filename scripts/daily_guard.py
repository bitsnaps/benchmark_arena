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
    #    stats-68 (2026-10-30): meta records mostly FOLLOW rows (per-row
    #    matched + census records). When rows legitimately shrink inside the
    #    check-2 band, a fixed (n_old - 10) meta floor is tighter than the
    #    row band and fails on explained upstream data cuts (first seen:
    #    AA leaderboard redesign — index coverage 83 of 274 rows, ~60
    #    AA-only rows gone). Relax the floor by the observed row drop; a
    #    meta collapse with STABLE rows (the stats-28 miner-death class)
    #    still fails exactly as before.
    #    stats-69 (2026-11-01): the counts are normKey-set based. The meta
    #    layer's rename-follow (stats-61) reshelves records under the fresh
    #    source spelling ('MiniMax M2' -> 'MiniMax-M2') and duplicate-spelling
    #    keys collapse on join; a raw-key count misreads both as shrinkage.
    #    normKeys see through renames, so only true retirements count.
    mm, tt_new, cr_new, mod_new = meta_stats(doc)
    _, tt_old, cr_old, mod_old = meta_stats(head)
    def _nk_set(d):
        out = {}
        for k in d or {}:
            out.setdefault(_nk(k), k)
        return out
    ns_old, ns_new = _nk_set(head.get("models_meta")), _nk_set(mm)
    n_old = len(ns_old)
    row_drop = max(0, rows_of(head) - rows_of(doc))
    meta_floor = max(95, n_old - 10 - row_drop)
    if len(ns_new) < meta_floor:
        fail(f"models_meta shrank: {len(ns_new)} vs HEAD {n_old} (floor {meta_floor})")
    if row_drop and len(ns_new) < n_old - 10:
        print(
            f"GUARD NOTE models_meta {len(ns_new)} < HEAD {n_old}: floor relaxed by the "
            f"{row_drop}-row upstream drop ({rows_of(doc)} rows vs {rows_of(head)}) — "
            f"records follow rows (stats-68)"
        )
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

    # 4c. ECI column checks (stats-82, 2026-11-16): the Epoch Capabilities
    #     Index is an external composite (CC-BY 4.0, epoch.ai CSV). The join
    #     is strict normKey-only, so floors are conservative minimums and a
    #     dip means a join/upstream break worth a human look. The vintage
    #     stamp (eci_asof) makes a lagging epoch.ai fetch visible instead of
    #     silently freezing the column; retention keeps prior cells.
    def _eci_ranked(d):
        rows = (d.get("unified_closed") or []) + (d.get("unified_open") or [])
        return sum(1 for r in rows if not r.get("unranked") and r.get("Epoch ECI") is not None)

    eci_new, eci_old = _eci_ranked(doc), _eci_ranked(head)
    if eci_new < max(60, int(eci_old * 0.8)):
        fail(f"ECI coverage collapsed: {eci_new} ranked cells vs HEAD {eci_old} (join or upstream break?)")
    eci_asof = str(doc.get("eci_asof") or "")
    if eci_asof:
        try:
            eci_age = (datetime.now(timezone.utc)
                       - datetime.strptime(eci_asof, "%Y-%m-%d").replace(tzinfo=timezone.utc)).days
            if eci_age > 7:
                print(f"GUARD WARN ECI vintage is {eci_age}d old (asof {eci_asof}) — "
                      f"epoch.ai fetch may be failing; retention keeps prior cells")
        except ValueError:
            print(f"GUARD WARN ECI asof malformed: {eci_asof!r}")
    elif eci_old:
        print("GUARD WARN ECI column vanished from the fresh doc (no eci_asof) — "
              "fetch AND retention both offline?")

    # 4d. Arena column checks (stats-88, 2026-11-18): the merged column is
    #     Overall-primary with a quantile-equated text fill. Floors: total
    #     coverage must hold (text ladder outage class) and the measured
    #     Overall half must not silently vanish (agent fetch + recovery both
    #     failing ships a text-only column — loud, not fatal: the doc then
    #     lacks arena_overall_asof and every source stamp says so).
    def _arena_stats(d):
        rows = (d.get("unified_closed") or []) + (d.get("unified_open") or [])
        cov = sum(1 for r in rows if r.get("Arena") is not None)
        mm_ = d.get("models_meta") or {}
        srcs = {}
        for v in mm_.values():
            s = (v or {}).get("arena_source")
            if s:
                srcs[s] = srcs.get(s, 0) + 1
        return cov, srcs

    arena_new, srcs_new = _arena_stats(doc)
    arena_old, _ = _arena_stats(head)
    if arena_new < max(100, int(arena_old * 0.8)):
        fail(f"Arena coverage collapsed: {arena_new} cells vs HEAD {arena_old} "
             f"(text ladder + Overall fetch both degraded?)")
    if arena_old and not doc.get("arena_overall_asof") and head.get("arena_overall_asof"):
        print("GUARD WARN arena_overall_asof vanished — Overall source offline "
              "this run; column shipped text-only (disclosed per row)")
    print(f"GUARD NOTE Arena sources: "
          + ", ".join(f"{k}={v}" for k, v in sorted(srcs_new.items()))
          + f" | asof overall={doc.get('arena_overall_asof')} "
            f"text={doc.get('arena_text_publish_date')}")

    # 4e. MaxxBench lane checks (stats-96, 2026-11-22): the column is owned
    #     by the daily refresh since stats-93 (cells come off the BenchLM
    #     mirror via bake_maxxbench.py in the refresh). A collapse means the
    #     mirror parse broke or the bake step died; a vanished stamp means
    #     the bake step was skipped. Name drift shows up passively: the bake
    #     only writes exact normalize_model_name matches and prints every
    #     unmatched mirror name for review — a drift wave shrinks the cell
    #     count into this floor.
    def _mx_cells(d):
        rows = (d.get("unified_closed") or []) + (d.get("unified_open") or [])
        return sum(1 for r in rows if not r.get("unranked")
                   and r.get("MaxxBench") is not None)

    mx_new, mx_old = _mx_cells(doc), _mx_cells(head)
    if mx_old and mx_new < max(8, int(mx_old * 0.6)):
        fail(f"MaxxBench coverage collapsed: {mx_new} ranked cells vs HEAD {mx_old} "
             f"(mirror parse break or name-drift wave? bake prints the unmatched list)")
    if head.get("maxxbench_asof") and not doc.get("maxxbench_asof"):
        fail("maxxbench_asof vanished — bake_maxxbench step skipped or failed")
    mx_asof = str(doc.get("maxxbench_asof") or "")
    if mx_asof:
        try:
            mx_age = (datetime.now(timezone.utc)
                      - datetime.strptime(mx_asof, "%Y-%m-%d").replace(tzinfo=timezone.utc)).days
            if mx_age > 7:
                print(f"GUARD WARN MaxxBench vintage is {mx_age}d old (asof {mx_asof}) — "
                      f"BenchLM mirror may be stale/frozen")
        except ValueError:
            print(f"GUARD WARN MaxxBench asof malformed: {mx_asof!r}")

    # 4f. Vendor-lane checks (stats-96, 2026-11-22): creator-reported scores
    #     live ONLY on card_models rows (stats-91 red line, leak detector
    #     asserts too). The bake is sha-diffed against HF (phase-2); a floor
    #     of 2 scored cards matches the compare.e2e vendor-pair spec, so a
    #     dead bake or an extraction collapse blocks the refresh here —
    #     before anything can ship without the lane.
    def _vendor_cards(d):
        return sum(1 for r in (d.get("card_models") or [])
                   if isinstance(r.get("vendor_scores"), list) and r["vendor_scores"])

    vendor_new, vendor_old = _vendor_cards(doc), _vendor_cards(head)
    if vendor_old and vendor_new < 2:
        fail(f"vendor lane collapsed: {vendor_new} scored census cards vs HEAD "
             f"{vendor_old} (bake_vendor_scores failed or HF unreachable?)")
    card_new = len(doc.get("card_models") or [])
    card_old = len(head.get("card_models") or [])
    if card_old and card_new < max(40, int(card_old * 0.7)):
        fail(f"census shrank: card_models {card_new} vs HEAD {card_old} "
             f"(OpenRouter census rebuild break?)")
    if vendor_old and vendor_new < vendor_old:
        print(f"GUARD NOTE vendor lane {vendor_new} scored cards < HEAD {vendor_old} "
              f"(cards churned or extraction partial — non-fatal)")

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
        f"aa_ttft={tt_new} created={cr_new} modalities={mod_new} eci={eci_new} "
        f"arena={arena_new} card={len(doc.get('card_models') or [])} "
        f"mx={mx_new} vendor={vendor_new} "
        f"approx_new_7d={fresh} ts={ts}"
    )


if __name__ == "__main__":
    main()
