#!/usr/bin/env python3
"""stats-30 dry run — display-casing canon against the PUBLISHED snapshot.

Loads the committed public/benchmark_results.json (git HEAD), builds the
vendor casing registry from its models_meta, and applies the canon pass to a
COPY. Prints the A/B for every affected name and asserts the safety contract:
  - renames preserve the lowercase identity (matching layers unaffected)
  - normKey and slugify are unchanged for every renamed row (joins + deep links)
  - meta key renames are collision-safe (no duplicate lowercase keys)
  - specific vendor-aligned expectations hold (probed explicitly)
"""
import json
import re
import subprocess
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bench_scraper as bs  # noqa: E402


def slugify(s):  # mirrors src/lib/format.js slugify
    return re.sub(r'^-+|-+$', '', re.sub(r'[^a-z0-9]+', '-', str(s).lower()))


def main():
    raw = subprocess.run(
        ["git", "show", "HEAD:public/benchmark_results.json"],
        capture_output=True, check=True, cwd=os.path.join(os.path.dirname(__file__), ".."),
    ).stdout
    doc = json.loads(raw)
    mm = doc["models_meta"]
    rows = list(doc["unified_closed"]) + list(doc["unified_open"])

    # pre-check: no duplicate lowercase meta keys today
    lowers = [k.lower() for k in mm]
    dupes = {k for k in lowers if lowers.count(k) > 1}
    assert not dupes, f"pre-existing duplicate lowercase meta keys: {dupes}"

    reg = bs._vendor_casing_registry(mm)
    canon = lambda n: bs.canonicalize_model_casing(n, reg)  # noqa: E731

    print("── unified row renames ──")
    n_row = 0
    for r in rows:
        old, new = r["name"], canon(r["name"])
        if old == new:
            continue
        n_row += 1
        assert new.lower() == old.lower(), f"identity broken: {old!r} -> {new!r}"
        assert slugify(new) == slugify(old), f"slug drift: {old!r} -> {new!r} (slug {slugify(new)})"
        assert bs.normalize_model_name(old) == bs.normalize_model_name(new), f"normKey drift: {old!r}"
        print(f"  {old!r} -> {new!r}")
    print(f"  rows renamed: {n_row}")

    print("── meta key renames ──")
    n_meta = 0
    new_mm = {}
    for k in mm:
        new = canon(k)
        assert new.lower() == k.lower(), f"identity broken: {k!r} -> {new!r}"
        if new != k:
            n_meta += 1
            assert new not in new_mm and new not in mm, f"collision: {k!r} -> {new!r}"
            print(f"  {k!r} -> {new!r}")
        new_mm[new] = mm[k]
    assert len(new_mm) == len(mm), "meta record count changed"
    print(f"  meta keys renamed: {n_meta} (total {len(new_mm)})")

    print("── superseded_by references (dry) ──")
    n_ref = 0
    renames = {k: canon(k) for k in mm if canon(k) != k}
    for k, rec in new_mm.items():
        tgt = rec.get("superseded_by")
        if tgt and tgt in renames:
            n_ref += 1
            print(f"  {k!r}: superseded_by {tgt!r} -> {renames[tgt]!r}")
    print(f"  references rewritten: {n_ref}")

    print("── per-benchmark rows renamed (count only) ──")
    n_pb = sum(1 for bd in doc["per_benchmark"].values() for cat in ("closed", "open")
               for n, _ in bd[cat] if canon(n) != n)
    print(f"  per-benchmark entries renamed: {n_pb}")

    print("── explicit expectations ──")
    expect = {
        "deepseek v4 flash": "DeepSeek V4 Flash",
        "DeepSeek V4 Pro": None,  # real row is mixed-case -> must be untouched
        "Claude Fable 5.1": None,  # mixed-case -> untouched
        "deepseek r1": "DeepSeek R1",
        "deepseek v3.2 exp thinking": "DeepSeek V3.2 Exp Thinking",
        "command a 03.2025": "Command A 03.2025",
        "gemini 2.5 flash": "Gemini 2.5 Flash",
        "gemma 3 4b it": "Gemma 3 4B it",           # HF "-it" suffix stays lowercase
        "gpt 5 nano": "GPT 5 Nano",
        "gpt-oss-120b": "gpt-oss-120b",             # vendor itself lowercases it
        "grok 4 fast chat": "Grok 4 Fast Chat",
        "grok-4.20-beta": "Grok-4.20-Beta",
        "llama 3.3 70b instruct": "Llama 3.3 70B Instruct",
        "o3 mini": "o3 Mini",                        # OpenAI keeps "o3" lowercase
        "solar pro4": "Solar Pro4",
        "gpt 4o mini 2024.07 18": "GPT 4o Mini 2024.07 18",
        "grok 3 mini": "Grok 3 Mini",
        "o1 mini": "o1 Mini",
        "o3 2025.04 16": "o3 2025.04 16",
    }
    bad = 0
    for old, want in expect.items():
        got = canon(old)
        if want is None:
            ok = got == old  # untouched
            tag = "untouched" if ok else f"WRONG (got {got!r}, expected untouched)"
        else:
            ok = got == want
            tag = got if ok else f"WRONG (got {got!r}, want {want!r})"
        if not ok:
            bad += 1
        print(f"  {'ok' if ok else 'FAIL'}: {old!r} -> {tag}")
    assert bad == 0, f"{bad} expectation(s) failed"

    print(f"\nDRY RUN OK — {n_row} rows, {n_meta} meta keys, {n_ref} refs, {n_pb} per-bench entries")


if __name__ == "__main__":
    main()
