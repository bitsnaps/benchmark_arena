# Benchmark Arena

LLM model performance aggregator — scores from 11 public leaderboards, unified into one view.

**Live demo:** [benchmark_arena on GitHub Pages](https://bitsnaps.github.io/benchmark_arena/)

## Benchmarks Covered

| # | Benchmark | Type |
|---|-----------|------|
| 1 | Artificial Analysis | General
| 2 | BenchLM.ai | General |
| 3 | Arena.ai Text | ELO Chatbot
| 4 | SimpleBench.com | Coding/Reasoning |
| 5 | ARC Prize | Reasoning |
| 6 | Design Arena | Design/VLM |
| 7 | DeepSWE | SWE (non-core) |
| 8 | VendingBench | SWE (non-core) |
| 9 | SWE-Marathon | SWE |
| 10 | FrontierSWE | SWE |
| 11 | CyberGem | Security (non-core) |

## Features

- **Leaderboard-first home** — the full pivot table is the landing page
- **Pivot Table** — models as rows, benchmarks as columns with heat-colored scores
- **Tier tabs** — All models (one merged ranking to spot the overall top LLM), Closed-source, Open-weight — deep-linkable via `?tier=`
- **Model pages** — every model has a score card at `#/model/<slug>`: Avg, coverage, rank-in-benchmark bars, "leads" badges
- **Benchmark deep links** — the explorer is addressable at `#/benchmarks/<slug>` (e.g. `#/benchmarks/arc-agi-2`)
- **Model Comparison** — select up to 5 models on the leaderboard, or open the dedicated comparison page at `#/compare?models=<slug>,<slug,…>` — shareable, with a spec matrix (params, MoE active params, context, modalities, reasoning, tokenizer, release date), USD pricing per 1M tokens with blended 3:1 price and a score-per-dollar value metric, plus the full 11-leaderboard score matrix with best-in-row highlighting
- **Search** — filter models by name, synced to `?q=` for shareable views
- **Coverage Level (CL)** — shows what % of core benchmarks a model appears on
- **Coverage opacity tiers** — leaderboard rows fade with benchmark coverage (full opacity at ≥7/8 core evals; hover solidifies) so thin data is visible at a glance without hiding anything
- **Min-CL slider** — hide models below a chosen coverage threshold (step = 1/8 of the core set)
- **Supersession (auto, no manual "deprecated" flags)** — the scraper groups models into product lines via their OpenRouter id (`family + variant + version`), orders siblings by release date (`created`), and flags every older version with `superseded_by`. Older versions are hidden from the default ranking behind an "Older versions" toggle, listed dimmed with no rank, and their model pages carry a banner linking to the successor. Variant-aware: Gemini *Pro* and *Flash* lines never supersede each other
- **Stale-generation rule** — old releases with no successor in the data (e.g. Llama 4, gpt-oss-120b) are flagged `stale` when their release date is 9+ months before the newest snapshot release; they hide behind the same toggle. Known same-line pairs the date pass can't reach (undated models like `gemini 3 pro`) are covered by explicit overrides in the scraper. The "Older versions" toggle lives on both the leaderboard and every benchmark explorer page

## Tech Stack

- Vue 3 + Vite
- vue-router (hash history — GitHub Pages friendly): views live in `src/views`, routes `#/`, `#/benchmarks/:slug?`, `#/model/:slug`, `#/compare` (+ legacy `#/leaderboard/*` redirects)
- Uses Buefy for UI components (no PrimeVue, no Tailwind)
- Pure CSS with CSS custom properties

## Updating Data

Run the benchmark scraper and copy the output JSON to `public/benchmark_results.json`:

```bash
python3 bench_scraper.py
# copies to public/benchmark_results.json
```

The output includes a `models_meta` section: per-model catalog metadata
(parameters, active params, modalities, context window, USD pricing per 1M
tokens, reasoning config, tokenizer, knowledge cutoff) matched from
OpenRouter's public model catalog (`https://openrouter.ai/api/v1/models`),
with HuggingFace safetensors totals as a fallback for open-weight parameter
counts. Every older version in a product line also gets a `superseded_by`
field (derived from release dates — see Supersession under Features), and
successor-less generations released 9+ months before the newest snapshot
model get a `stale` flag.
Useful for in-depth side-by-side model comparisons.

## Dev

```bash
npm install
npm run dev
```

## Testing

Three layers guard the freshness rules (older-generation models staying
hidden, product lines never hiding each other). **Nothing deploys unless all
three pass** — CI runs the same gate in `.github/workflows/deploy.yml` before
the Pages upload. Run it locally before every push:

```bash
bash scripts/prepush.sh          # the whole gate
# or layer by layer:
pnpm run test                    # 1. unit (vitest): store freshness/ranking logic
pnpm run test:leak               # 2. data leak guard (python, no deps)
pnpm run test:e2e                # 3. browser e2e (vite preview + playwright)
```

1. **Unit — `tests/unit/`** — exercises `src/stores/data.js` against the real
   committed snapshot: rank/leader lists exclude older models, successors
   resolve, the 2026-09 regression names stay flagged, and the red-line
   product pairs (`Gemini 3.1 Pro` / `3.8 Flash` / `3.5 Flash-Lite`) stay
   visible.
2. **Data leak guard — `tests/leak_detector.py`** — an independent
   re-implementation of the freshness rules that audits
   `public/benchmark_results.json` itself: no *visible* row may have a
   same-line sibling with a newer version, and a bare/edition-named row
   (`gpt 5.5 instant`, `grok 4 fast chat`) may not outlive a newer release of
   its family. Also checks JSON contract sanity (superseded_by targets exist,
   CL ↔ num_benchmarks consistency). This is the layer that catches bad data
   *before* the UI ever renders it.
3. **Browser e2e — `tests/e2e/*.e2e.mjs`** — Playwright against a
   `vite preview` build (`tests/run-e2e.mjs` starts/stops the server):
   leaderboard tiers, benchmark explorers and compare presets must show zero
   flagged models by default; the Older-versions toggle reveals exactly the
   flagged set and hides it again; plus the home/compare interaction suites.
   All expectations are derived from the snapshot via
   `tests/helpers/snapshot.mjs` — no hardcoded counts.

## Build

```bash
npm run build
# Output in dist/
```
