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
- **Model Comparison** — select up to 5 models to compare side-by-side
- **Search** — filter models by name, synced to `?q=` for shareable views
- **Coverage Level (CL)** — shows what % of core benchmarks a model appears on

## Tech Stack

- Vue 3 + Vite
- vue-router (hash history — GitHub Pages friendly): views live in `src/views`, routes `#/`, `#/benchmarks/:slug?`, `#/model/:slug` (+ legacy `#/leaderboard/*` redirects)
- Uses Buefy for UI components (no PrimeVue, no Tailwind)
- Pure CSS with CSS custom properties

## Updating Data

Run the benchmark scraper and copy the output JSON to `public/benchmark_results.json`:

```bash
python3 bench_scraper.py
# copies to public/benchmark_results.json
```

## Dev

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
# Output in dist/
```
