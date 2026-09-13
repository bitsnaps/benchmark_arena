#!/usr/bin/env python3
"""stats-34 dry run: offline goldens for the modality enrichment ladder.

Run: python3 scripts/dryrun_stats34_modalities.py   (repo root, read-only)

Covers (spec §8):
  1. HF pipeline_tag -> (input, output) mapping table, every row.
  2. AA FAQ answer parser goldens (input + output sides, negatives, 'file').
  3. enrich_modalities() on synthetic meta with injected fetchers:
     OR rows untouched (fill-gaps invariant), ladder precedence HF > AA >
     curated, modality compact-string consistency, unknowns stay unknown.
  4. Live-meta replay invariant: enrichment with no-op fetchers changes zero
     already-covered rows in the committed public snapshot.
"""
import json
import os
import sys

sys.path.insert(0, "/home/z/my-project/benchmark_arena/scripts")
import bench_scraper as bs

FAILED = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ok: {name}")
    else:
        FAILED.append(name)
        print(f"  FAIL: {name} {detail}")


def section(t):
    print(f"\n== {t} ==")


def main():
    section("1. HF pipeline_tag mapping table")
    expect = {
        "text-generation": (["text"], ["text"]),
        "image-text-to-text": (["text", "image"], ["text"]),
        "audio-text-to-text": (["text", "audio"], ["text"]),
        "video-text-to-text": (["text", "video"], ["text"]),
        "image-text-to-image": (["text", "image"], ["text", "image"]),
        "audio-text-to-audio": (["text", "audio"], ["text", "audio"]),
        "any-to-any": (["text", "image", "audio", "video"],
                       ["text", "image", "audio", "video"]),
    }
    for tag, pair in expect.items():
        check(f"{tag}", bs.HF_PIPELINE_MODALITIES.get(tag) == pair,
              f"got {bs.HF_PIPELINE_MODALITIES.get(tag)}")
    check("unknown tag -> no claim", bs.HF_PIPELINE_MODALITIES.get("feature-extraction") is None)
    check("any-to-any mirrors OR omni convention (Ibrahim's call)",
          bs.HF_PIPELINE_MODALITIES["any-to-any"][0] == ["text", "image", "audio", "video"])

    section("2. AA FAQ answer parser")
    check("text and image input",
          bs.parse_aa_modality_answer("GLM-4.5V (Non-reasoning) supports text and image input.", "input")
          == ["text", "image"])
    check("text only input",
          bs.parse_aa_modality_answer("GPT-5.5 Pro (xhigh) supports text input.", "input")
          == ["text"])
    check("comma + and list",
          bs.parse_aa_modality_answer("X supports text, image, and audio input.", "input")
          == ["text", "image", "audio"])
    check("full multimodal",
          bs.parse_aa_modality_answer("X supports text, image, audio, and video input.", "input")
          == ["text", "image", "audio", "video"])
    check("output side reads only the output sentence",
          bs.parse_aa_modality_answer("X supports text and image input. Y supports text output.", "output")
          == ["text"])
    check("negative sentence yields nothing",
          bs.parse_aa_modality_answer("X does not support image input.", "input") == [])
    check("empty text yields nothing", bs.parse_aa_modality_answer("", "input") == [])
    check("file never synthesized from secondary sources",
          "file" not in bs.parse_aa_modality_answer("X supports text and file input.", "input"))
    check("canonical order enforced",
          bs.parse_aa_modality_answer("X supports video, audio, image, and text input.", "input")
          == ["text", "image", "audio", "video"])
    check("slug join: exact hit", bs._aa_slug_for("AA Only 9B", {"AA Only 9B": "s1"}) == "s1")
    check("slug join: agreeing variant family",
          bs._aa_slug_for("Some Model", {"Some Model (fast)": "s1", "Some Model (precise)": "s1"}) == "s1")
    check("slug join: disagreeing family never guessed",
          bs._aa_slug_for("Some Model", {"Some Model (fast)": "s1", "Some Model (precise)": "s2"}) is None)
    check("slug join: no paren family -> miss",
          bs._aa_slug_for("Plain Model", {"Other Model": "s1"}) is None)
    check("slug join: case-insensitive exact (casing canon runs after enrichment)",
          bs._aa_slug_for("grok 4 fast chat", {"Grok 4 Fast Chat": "s1"}) == "s1")

    section("3. enrich_modalities on synthetic meta (injected fetchers)")
    # never read/write the real AA page cache from a test
    bs.AA_MODALITIES_CACHE = "/tmp/aa_modalities_dryrun_section3.json"
    if os.path.exists(bs.AA_MODALITIES_CACHE):
        os.unlink(bs.AA_MODALITIES_CACHE)
    bs._AA_SLUGS_LAST = {"HF Gated 7B": "gated-7b", "AA Only 9B": "lfm2-5-8b"}
    synthetic = {
        "OR Covered": {"input_modalities": ["text", "image"], "output_modalities": ["text"],
                       "modality": "text+image->text"},
        "HF Vision 8B": {"hugging_face_id": "org/hf-vision-8b"},
        "HF Omni 30B": {"hugging_face_id": "org/hf-omni-30b"},
        "HF Gated 7B": {"hugging_face_id": "org/gated"},
        "AA Only 9B": {},
        "Curated Model": {},
        "lowercase curated": {},
        "Unknown Model": {},
    }
    hf_calls, aa_calls = [], []

    def fake_hf(hf_id):
        hf_calls.append(hf_id)
        return {"org/hf-vision-8b": (["text", "image"], ["text"]),
                "org/hf-omni-30b": (["text", "image", "audio", "video"],
                                    ["text", "image", "audio", "video"])}.get(hf_id, (None, None))

    def fake_aa(slug):
        aa_calls.append(slug)
        return (["text", "image"], ["text"]) if slug in ("lfm2-5-8b", "gated-7b") else (None, None)

    real_hf, real_aa_page = bs.hf_modalities_for, bs.aa_page_modalities
    bs.hf_modalities_for = fake_hf
    bs.aa_page_modalities = fake_aa
    bs.CURATED_MODALITIES_BACKUP = dict(bs.CURATED_MODALITIES)
    bs.CURATED_MODALITIES.clear()
    bs.CURATED_MODALITIES.update({"Curated Model": (["text", "image"], ["text"]),
                                  "Lowercase Curated": (["text"], ["text"])})
    try:
        bs.enrich_modalities(synthetic)
    finally:
        bs.hf_modalities_for = real_hf
        bs.aa_page_modalities = real_aa_page
        bs.CURATED_MODALITIES.clear()
        bs.CURATED_MODALITIES.update(bs.CURATED_MODALITIES_BACKUP)
        bs._AA_SLUGS_LAST = None

    check("fill-gaps invariant: OR row values untouched",
          synthetic["OR Covered"]["input_modalities"] == ["text", "image"]
          and synthetic["OR Covered"]["modality"] == "text+image->text")
    check("OR row stamped openrouter",
          synthetic["OR Covered"]["modalities_source"] == "openrouter")
    check("HF vision row filled",
          synthetic["HF Vision 8B"]["input_modalities"] == ["text", "image"]
          and synthetic["HF Vision 8B"]["modalities_source"] == "huggingface")
    check("HF any-to-any row filled with full omni set",
          synthetic["HF Omni 30B"]["input_modalities"] == ["text", "image", "audio", "video"])
    check("ladder: gated HF falls through to AA page",
          synthetic["HF Gated 7B"]["input_modalities"] == ["text", "image"]
          and synthetic["HF Gated 7B"]["modalities_source"] == "artificialanalysis"
          and aa_calls == ["gated-7b", "lfm2-5-8b"])
    check("AA-only row filled via slug map",
          synthetic["AA Only 9B"]["input_modalities"] == ["text", "image"]
          and synthetic["AA Only 9B"]["modality"] == "text+image->text")
    check("curated row filled last",
          synthetic["Curated Model"]["modalities_source"] == "curated")
    check("curated join is case-insensitive (lowercase fresh row)",
          synthetic["lowercase curated"].get("modalities_source") == "curated")
    check("unknown stays unknown (honest)",
          "input_modalities" not in synthetic["Unknown Model"]
          and "modalities_source" not in synthetic["Unknown Model"])
    check("compact string format mirrors OR",
          synthetic["HF Omni 30B"]["modality"] == "text+image+audio+video->text+image+audio+video")
    check("output defaults to text when side unknown",
          synthetic["AA Only 9B"]["output_modalities"] == ["text"])

    section("4. Live-meta replay invariant (no-op fetchers)")
    pub = json.load(open("/home/z/my-project/benchmark_arena/public/benchmark_results.json"))
    meta = json.loads(json.dumps(pub["models_meta"]))
    before = {k: (v.get("input_modalities"), v.get("output_modalities"), v.get("modality"))
              for k, v in meta.items()}
    bs.hf_modalities_for = lambda hf_id: (None, None)
    bs.aa_page_modalities = lambda slug: (None, None)
    bs._AA_SLUGS_LAST = None
    bs.AA_MODALITIES_CACHE = "/tmp/aa_modalities_dryrun_should_not_exist.json"
    try:
        bs.enrich_modalities(meta)
    finally:
        bs.hf_modalities_for = real_hf
        bs.aa_page_modalities = real_aa_page
    covered = {k for k, v in before.items() if v[0]}
    unchanged = all(meta[k].get("input_modalities") == before[k][0]
                    and meta[k].get("modality") == before[k][2] for k in covered)
    check(f"all {len(covered)} covered rows byte-identical after replay", unchanged)
    newly = [k for k, v in meta.items() if not before[k][0] and v.get("modalities_source") == "curated"]
    check(f"curated fills applied on replay: {newly}",
          set(newly) <= set(bs.CURATED_MODALITIES_BACKUP))
    n_unknown = sum(1 for v in meta.values() if not v.get("input_modalities"))
    print(f"  info: unknown rows with no-op fetchers = {n_unknown} (HF+AA supply the rest live)")

    print()
    if FAILED:
        print(f"DRYRUN FAILED ({len(FAILED)}): {FAILED}")
        sys.exit(1)
    print("DRYRUN OK — all stats-34 goldens green")


if __name__ == "__main__":
    main()
