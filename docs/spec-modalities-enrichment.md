# stats-34 — Modality enrichment: `input_modalities` / `output_modalities` beyond OpenRouter

Approved by Ibrahim 2026-09-13 (msg 1548593075872600226): fill-gaps-only per the
main-agent recommendation, **plus** a leaderboard "Modalities" filter, **plus**
`output_modalities` processed through the same ladder with output-side adjustments.
HF `any-to-any` maps to text+image+audio+video (mirroring OR's omni convention).

## 1. Summary

Today every modality field comes from a single source: OpenRouter's
`architecture` object (89/108 rows). The 19 rows without modalities are exactly
the models not listed on OpenRouter. This feature fills those gaps from
independent sources (HuggingFace model tags, Artificial Analysis model pages, a
tiny curated map for first-party stragglers), records which source produced
each row's modalities, and exposes the data in the UI: chips on the model
card, an input→output row already present in Compare (lights up automatically),
and a new "Modalities" filter on the leaderboard.

## 2. Goals / Non-goals

Goals
- Fill `input_modalities` / `output_modalities` for rows that lack them; never
  overwrite OpenRouter-sourced values (fill-gaps-only, v1 policy).
- Record provenance per row in `modalities_source`.
- Leaderboard filter by input modality (image / audio / video) with URL
  mirroring; model-card chips with a provenance tooltip.
- Extend the daily guard so modality coverage cannot silently regress.

Non-goals
- No override of OR rows where vendor sources disagree (disagreements are a
  v2 concern once AA page coverage extends to OR rows).
- No scoring / leaderboard math changes; no advisor behavior change (the
  Vision & media profile keeps the Design-Arena proxy until coverage matures).
- No output-modality *filter* (output data is surfaced, not filterable, in v1).

## 3. Current state (2026-09-13 snapshot, rows=116 / meta=108)

- `input_modalities` 89/108, all OR-sourced (bench_scraper.py
  `collect_model_metadata`, from `architecture.input_modalities`).
- `modality` compact string ("text+image->text") rides along from OR.
- `output_modalities` 89/89 all `["text"]`.
- Token counts: image 62, video 20, file 42, audio 15, text 89; unknown 19.
- The 19 unknowns are exactly the not-on-OR rows (all 19 lack `or_id`).
  15 have `hugging_face_id`, 10 are AA-priced, 4 have neither HF nor AA
  (first-party-only: Gemini 3 Pro, Qwen3.5 Plus, Grok 4 Fast Chat, Command A+).

Source evidence (scripts/probe_modality_sources.py, read-only probes):
- AA leaderboard flight payload (1.48 MB): **zero** modality keys — the
  existing pricing/TTFT mine cannot be extended for modalities.
- AA model detail pages (`/models/{slug}`): structured JSON-LD FAQ —
  *"What input modalities does X support?" → "…supports text and image
  input."* (+ the output-modalities question). Slugs ride free in the
  existing payload records (`"slug":"…","shortName":"…"` adjacency).
- HF API `pipeline_tag`: `image-text-to-text`, `any-to-any`,
  `text-generation`… maps cleanly; gated repos return nothing (partial).
- Arena.ai: leaderboard + outbound vendor links only — not a source.

## 4. Data design

Canonical input tokens: `text · image · audio · video · file` (OR's
vocabulary; `file` = documents/PDF. Secondary sources never synthesize
`file`.) Output tokens: `text · image · audio · video`.

New/changed meta fields:
- `input_modalities` / `output_modalities` — filled for gap rows only.
- `modality` — compact string recomputed for filled rows, OR format
  (`"text+image->text"`), so every row stays internally consistent.
- `modalities_source` (new, every row): `openrouter` | `huggingface` |
  `artificialanalysis` | `curated`. UI shows it as a tooltip; the contract is
  "every number traceable to its source", same ethos as pricing layers.

## 5. Enrichment pipeline (inside bench_scraper.py)

New pass `enrich_modalities(models_meta)`, called right after
`apply_aa_pricing()` in **both** paths (full main() and --meta-only). Runs
per model with empty `input_modalities` only (fill-gaps invariant):
1. **HuggingFace** (`huggingface.co/api/models/{hf_id}`, urllib, ≤19 calls):
   `pipeline_tag` → tokens via a pinned map:
   | pipeline_tag | input | output |
   |---|---|---|
   | text-generation | text | text |
   | image-text-to-text | text+image | text |
   | audio-text-to-text | text+audio | text |
   | video-text-to-text | text+video | text |
   | image-text-to-image | text+image | text+image |
   | audio-text-to-audio | text+audio | text+audio |
   | any-to-any | text+image+audio+video | text+image+audio+video |
   Unknown/gated/no tag → no claim, falls through.
2. **Artificial Analysis model page** for models HF could not fill that have
   an AA record: slug captured free from the existing leaderboard payload
   (extended mine stores `slug` per `shortName`; name join ladder = exact,
   then paren-stripped family, same as pricing). Page mined via
   `load_and_eval` reading JSON-LD FAQ answers; tokens parsed from the
   answer sentence. Negative results cached 7 days (`/tmp/aa_modalities.json`)
   so unattended runs stay fast (worst case +3–5 min on a cold day).
3. **Curated map** (last resort, tiny, commented, defensible):
   Gemini 3 Pro → text+image+audio+video in; Qwen3.5 Plus → text+image in;
   Grok 4 Fast Chat → text+image in. Anything uncertain (e.g. Command A+)
   stays honestly unknown.
Rows already carrying `input_modalities` (the OR 89) get only
`modalities_source: 'openrouter'` stamped — values never touched.
Non-fatal by design: any source failing leaves the row unknown.

Merge behavior needs **no changes**: the full merge adopts the fresh
document wholesale; `merge_aa_into_public.py` overlays only pricing fields
and cannot regress modalities.

`daily_guard.py` gains a modality coverage stat: `modalities=N` in the GUARD
line; hard-fail floor `max(85, HEAD − 15)` (catastrophic-loss detector),
non-fatal warn when below HEAD (HF API flake ≠ failed refresh).

## 6. UI

- **Leaderboard (HomeView)**: "Modalities" select next to "At seller" —
  Any · Image input · Audio input · Video input. Filters rows whose
  `input_modalities` include the token; rows with unknown modalities hide
  while a filter is on (same honesty rule as the price cap hiding unpriced
  rows); tooltip states this. URL mirror `?mod=image` (shareable, validated,
  stale values dropped like `?seller=`).
- **Model card (ModelDetailView)**: modality chips row under the header tags
  (font-awesome icons via the existing `modalityIcon` helper): Input chips
  always when known; Output chips only when output goes beyond plain text.
  Provenance tooltip on the row label (source + what it means).
- **Compare**: the input→output modality cell already ships — it lights up
  automatically for enriched rows; no change.

## 7. File plan

- `scripts/bench_scraper.py` — slug capture in the AA mine, HF map, AA page
  miner + 7-day cache, curated map, `enrich_modalities()`, two call sites.
- `scripts/daily_guard.py` — modalities stat + floors.
- `scripts/dryrun_stats34_modalities.py` — offline goldens: pipeline-tag map,
  FAQ answer parser, fill-gaps invariant on the live meta, ladder precedence,
  curated entries.
- `src/stores/leaderboard.js` — `modFilter` state (module singleton, same
  pattern as the other filters).
- `src/views/HomeView.vue` — select + filter line + `?mod=` mirror + tooltip.
- `src/views/ModelDetailView.vue` — chips row + provenance tooltip.
- `tests/e2e/modalities.e2e.mjs` — snapshot-derived: filter semantics,
  URL mirror, unknown-rows-hidden, card chips, output-beyond-text rule.
- `scripts/verify_prod_stats34.mjs` — prod checks derived from the live JSON.

## 8. Testing

- Dry-run goldens (Python, offline): every pipeline-tag mapping; FAQ answer
  parsing ("supports text and image input." → [text, image]; "supports text
  input." → [text]); fill-gaps invariant — replaying enrichment on the live
  public meta changes zero already-covered rows; HF-first-then-AA ladder;
  curated rows exactly as pinned; `modality` string consistency.
- E2E (snapshot-derived, no pinned names): filter count matches JSON-derived
  expectation; every visible row under `?mod=image` has image input; unknown
  rows hidden; card chips for a multimodal model; text-only model shows no
  output chips; console clean.
- Full prepush gate + existing suites must stay green (Compare cell, advisor,
  home navbar pins unaffected).

## 9. Future

- v2: extend AA page mining to OR rows → disagreement report (router support
  vs vendor spec) → possible precedence flip.
- Advisor Vision & media profile switches from the Design-Arena proxy to the
  real image-input filter once coverage matures; audio/video profiles unlock.
- `file` (document) input may deserve its own filter once secondary sources
  can speak it.
