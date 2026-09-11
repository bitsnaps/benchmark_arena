#!/usr/bin/env python3
"""stats-32 dry run: patched parse_series vs current — catalog-wide diff.

Patched rules (proposed for bench_scraper.parse_series):
  1. Strip an MMDD-looking 4-digit tail (-0731, -0813, -0613, -0528 …) before
     family parsing, so dated snapshots group with their base product line.
     (Only calendar-plausible MMDD: month 01-12, day 01-31 — "minimax-m1-6402"
     or "-2026" style years must NOT be stripped.)
  2. Allow a "v" prefix on the single-version segment (deepseek-v4-pro …).
  3. Fall back to the raw base when the MMDD-stripped base is unparseable, so
     today's parses never regress.

Prints: parse changes + supersession map diff over the LIVE public JSON meta.
NO writes — review only.
"""
import json
import re
import sys
from collections import defaultdict

sys.path.insert(0, "/home/z/my-project/benchmark_arena/scripts")
from bench_scraper import parse_series as parse_series_old, annotate_supersession as annotate_old

JSON_PATH = "/home/z/my-project/benchmark_arena/public/benchmark_results.json"

# ── candidate patched regexes/logic (mirror of proposed scraper patch) ──
_SERIES_CANON_DATE = re.compile(r"-\d{8}$")
_MMDD_TAIL = re.compile(r"-(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$")
_SERIES_NOISE_SUFFIX = re.compile(
    r"-(latest|preview|free|reasoning|thinking|batch|high|exp.*)$")
_SERIES_DOTTED_VER = re.compile(r"(\d+(?:\.\d+)+)")
_SERIES_SINGLE_VER = re.compile(r"(?:^|-)v?(\d+)(?:-|$)")


def parse_series_new(or_id):
    """Clean version (the one above had a placeholder bug)."""
    if not or_id or "/" not in or_id:
        return None
    base = or_id.split("/", 1)[1].split(":", 1)[0]
    base = _SERIES_CANON_DATE.sub("", base)
    stripped = _MMDD_TAIL.sub("", base)
    for s in (stripped, base):
        s2 = _SERIES_NOISE_SUFFIX.sub("", s)
        m = _SERIES_DOTTED_VER.search(s2) or _SERIES_SINGLE_VER.search(s2)
        if m:
            ver = tuple(int(x) for x in m.group(1).split("."))
            fam = s2[:m.start()].strip("-") or s2[m.end():].strip("-")
            var = s2[m.end():].strip("-") if m.start() > 0 else ""
            return (fam, var, ver)
    return None


def supersede_map(meta, parse_fn):
    groups = defaultdict(list)
    for name, m in meta.items():
        s = parse_fn(m.get("or_id"))
        if s:
            groups.setdefault((s[0], s[1]), []).append(
                (m.get("created") or "", s[2], name))
    out = {}
    for members in groups.values():
        if len(members) < 2:
            continue
        members.sort(reverse=True)
        newest = members[0][2]
        for _, _, name in members[1:]:
            out[name] = newest
    return out


def main():
    meta = json.load(open(JSON_PATH))["models_meta"]
    # sanity: candidate parse must reproduce current behavior on already-parsing ids
    bad = 0
    for name, m in meta.items():
        oid = m.get("or_id")
        old = parse_series_old(oid)
        new = parse_series_new(oid)
        if old is not None and new != old:
            print(f"  !! REGRESSION {name!r} or_id={oid!r}: {old} -> {new}")
            bad += 1
    print(f"parse regression check: {bad} ids changed among previously-parsing ones")

    old_map = supersede_map(meta, parse_series_old)
    new_map = supersede_map(meta, parse_series_new)

    added = {k: v for k, v in new_map.items() if old_map.get(k) != v}
    removed = {k: v for k, v in old_map.items() if new_map.get(k) != v}
    print(f"\nsupersession links: current={len(old_map)} patched={len(new_map)}")
    print(f"\n-- NEW / CHANGED links ({len(added)}) --")
    for k in sorted(added):
        print(f"  {k!r:<44} superseded_by {added[k]!r}")
    print(f"\n-- REMOVED / CHANGED-away links ({len(removed)}) --")
    for k in sorted(removed):
        print(f"  {k!r:<44} (was: {removed[k]!r})")

    # focus: DeepSeek family parse table
    print("\n-- DeepSeek family parses (old -> new) --")
    for name, m in sorted(meta.items()):
        if "deepseek" in name.lower():
            oid = m.get("or_id")
            print(f"  {name!r:<28} {oid!r:<40} {parse_series_old(oid)} -> {parse_series_new(oid)}")


if __name__ == "__main__":
    main()
