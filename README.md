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

- **Pivot Table** — models as rows, benchmarks as columns with heat-colored scores
- **Per-Benchmark** — expandable accordion showing top models per leaderboard
- **Model Comparison** — select up to 5 models to compare side-by-side
- **Search** — filter models by name instantly
- **Coverage Level (CL)** — shows what % of core benchmarks a model appears on
- **Closed/Open tabs** — toggle between closed-source and open-weight models

## Tech Stack

- Vue 3 + Vite
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
