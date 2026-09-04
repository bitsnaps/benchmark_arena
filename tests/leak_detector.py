#!/usr/bin/env python3
"""Data-contract + stale-model leak guard for benchmark_arena.

Runs against the committed snapshot (public/benchmark_results.json) with NO
dependency on the scraper — an independent re-implementation of the freshness
rules, so implementation drift is caught too. Wire into CI before deploy and
run locally before every push:

    python3 tests/leak_detector.py public/benchmark_results.json

Exit code 0 = clean; 1 = contract violation or older-model leak.

Why this exists (2026-09 incident): "gpt 5.5 instant" ranked #3 and
"grok 4 fast chat" #8 of the default leaderboard while newer generations of
the same lines (GPT-5.6, Grok 4.6) sat right below them. Both were undated
and unmatched in OpenRouter, so the supersession/staleness passes had nothing
to act on. The frontend hid every flagged model correctly — the data layer
was missing flags, and no test noticed.

Rules encoded here (see README "Stale-generation rule"):
  1. Contract: every superseded_by target / flagged name exists in the rows;
     dates are ISO; coverage bounds sane.
  2. Same-line leak: a VISIBLE row whose (family, variant) sibling with a
     strictly newer version is also VISIBLE. Variant comparison happens
     AFTER stripping noise tokens (instant/fast/chat/preview/...), so
     "grok 4 fast chat" vs "Grok 4.6" is a leak but "Claude Opus 5" vs
     "Claude Sonnet 5" is not.
  3. Cross-generation leak: a VISIBLE row with an EMPTY variant (bare or
     edition-only name) whose family has a strictly newer VISIBLE release.
     This is direction-safe: "gpt 5.5 instant" is caught by "GPT-5.6 Sol",
     while "Gemini 3.5 Flash-Lite" (variant 'flash-lite') is NOT caught by
     "Gemini 3.8 Flash" — product lines never hide each other.
  4. Red line: MUST_STAY_VISIBLE models stay visible; MUST_BE_HIDDEN models
     (past regressions) are hidden.
"""
import json
import re
import sys

# Noise tokens: edition/distribution words that never define a product line.
NOISE = {
    "thinking", "reasoning", "reason", "chat", "beta", "exp", "experimental",
    "preview", "stable", "latest", "with", "fallback", "instant", "fast",
    "multimodal", "free", "high", "batch",
}
NOISE_SUFFIX = re.compile(r"-(latest|preview|free|reasoning|thinking|batch|high|exp.*)$")
CANON_DATE = re.compile(r"-\d{8}$")
DOTTED = re.compile(r"(\d+(?:\.\d+)+)")
SINGLE = re.compile(r"(?:^|-)(\d+)(?:-|$)")

# (family, parsed-from) models whose version parse is unreliable → skip.
SKIP_FAMILIES = set()

MUST_STAY_VISIBLE = {
    # the explicit product-line rule: none of these may hide another
    "Gemini 3.1 Pro", "Gemini 3.8 Flash", "Gemini 3.5 Flash-Lite",
}
MUST_BE_HIDDEN = {
    # 2026-09 regressions: undated old generations that shipped visible
    "gpt 5.5 instant", "grok 4 fast chat", "Phi-4 Multimodal", "Mistral",
}


def parse_series(or_id):
    """'openai/gpt-5.6-sol' -> ('gpt', 'sol', (5, 6)); None if unparseable."""
    if not or_id or "/" not in or_id:
        return None
    base = or_id.split("/", 1)[1].split(":", 1)[0]
    base = CANON_DATE.sub("", base)
    base = NOISE_SUFFIX.sub("", base)
    m = DOTTED.search(base) or SINGLE.search(base)
    if not m:
        return None
    ver = tuple(int(x) for x in m.group(1).split("."))
    fam = base[:m.start()].strip("-") or base[m.end():].strip("-")
    var = base[m.end():].strip("-") if m.start() > 0 else ""
    return (fam, var, ver)


def parse_display(name):
    """Display-name fallback: 'GPT-5.6 Sol' -> ('gpt', 'sol', (5, 6)).

    Lowercase + spaces->hyphens, then the same regexes as or_id parsing.
    """
    return parse_series(None) or parse_id(name.lower().replace(" ", "-"))


def parse_id(text):
    if not text:
        return None
    text = CANON_DATE.sub("", text)
    text = NOISE_SUFFIX.sub("", text)
    m = DOTTED.search(text) or SINGLE.search(text)
    if not m:
        return None
    ver = tuple(int(x) for x in m.group(1).split("."))
    fam = text[:m.start()].strip("-") or text[m.end():].strip("-")
    var = text[m.end():].strip("-") if m.start() > 0 else ""
    return (fam, var, ver)


def series_of(name, meta):
    """(family, variant_tokens, version) with noise tokens stripped."""
    s = parse_series((meta or {}).get("or_id"))
    if not s:
        s = parse_id(name.lower().replace(" ", "-"))
    if not s:
        return None
    fam, var, ver = s
    var_toks = [t for t in var.split("-") if t] if var else []
    var_toks = [t for t in var_toks if t not in NOISE]
    return (fam.lower(), var_toks, ver)


def iter_leaks(rows, meta):
    """Yield (old_name, new_name, reason) for every older-model leak."""
    info = {}
    for r in rows:
        s = series_of(r["name"], meta.get(r["name"]))
        if s:
            info[r["name"]] = s
    older = {
        n for n, m in meta.items()
        if m.get("superseded_by") or m.get("stale")
    }

    def visible(n):
        return n not in older

    names = list(info)
    for i, a in enumerate(names):
        if not visible(a):
            continue
        fa, va, vea = info[a]
        for b in names:
            if b == a or not visible(b):
                continue
            fb, vb, veb = info[b]
            if fb != fa or a in SKIP_FAMILIES:
                continue
            if not (vea < veb):
                continue
            if va == vb:
                yield (a, b, f"same line '{fa}/{'-'.join(va) or '-'}': "
                             f"v{vea} visible while v{veb} newer")
            elif not va:  # empty variant: edition/bare name; line-successor exists
                yield (a, b, f"bare/edition row of '{fa}' at v{vea} visible while "
                             f"'{fb}/{'-'.join(vb)}' v{veb} is newer")


def main(path):
    with open(path) as f:
        data = json.load(f)
    closed, open_ = data.get("unified_closed") or [], data.get("unified_open") or []
    rows, seen = [], set()
    for r in [*closed, *open_]:
        if r["name"] not in seen:
            seen.add(r["name"])
            rows.append(r)
    meta = data.get("models_meta") or {}
    row_names = {r["name"] for r in rows}
    flagged = {n for n, m in meta.items() if m.get("superseded_by") or m.get("stale")}
    visible = row_names - flagged

    problems = []

    # 1 ── contract
    for n, m in meta.items():
        if m.get("superseded_by") and m["superseded_by"] not in row_names:
            problems.append(f"contract: superseded_by target '{m['superseded_by']}' "
                            f"of '{n}' not in rows (successor link would 404)")
        c = m.get("created")
        if c and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", c):
            problems.append(f"contract: '{n}' created={c!r} is not ISO yyyy-mm-dd")
    for n in flagged - row_names:
        problems.append(f"contract: flagged model '{n}' missing from unified rows")
    for r in rows:
        cl = r.get("cl")
        if cl is None or not (0 <= cl <= 100):
            problems.append(f"contract: '{r['name']}' cl={cl} out of [0, 100]")
        # coverage level is core-benchmarks/8 → cl == num_benchmarks * 12.5,
        # and total scored benchmarks (all sources) can only be >= that
        nb = r.get("num_benchmarks")
        if nb != round((cl or 0) / 12.5):
            problems.append(f"contract: '{r['name']}' cl={cl} inconsistent "
                            f"with num_benchmarks={nb}")
        scored = sum(1 for k, v in r.items() if k not in ("name", "cl", "num_benchmarks") and v is not None)
        if nb is not None and nb > scored:
            problems.append(f"contract: '{r['name']}' num_benchmarks={nb} > "
                            f"{scored} non-null scores present")

    # 2 + 3 ── leaks
    for old, new, why in iter_leaks(rows, meta):
        problems.append(f"leak: '{old}' visible but {why} ('{new}')")

    # 4 ── curated red lines
    for n in MUST_BE_HIDDEN:
        if n in row_names and n not in flagged:
            problems.append(f"regression: '{n}' (known old generation) is visible again")
    for n in MUST_STAY_VISIBLE:
        if n in row_names and n in flagged:
            problems.append(f"red line: '{n}' must stay visible (distinct product line)")

    print(f"leak_detector: {len(rows)} rows, {len(flagged)} flagged older, "
          f"{len(visible)} visible, {len(meta)} meta entries")
    if problems:
        for p in problems:
            print("  " + p)
        print(f"FAILED: {len(problems)} problem(s)")
        return 1
    print("OK: no contract violations, no stale-model leaks, red lines hold")
    return 0


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "public/benchmark_results.json"
    sys.exit(main(target))
