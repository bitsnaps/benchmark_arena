# Data Pipeline — how the public JSONs are produced

Everything that turns the live web into `public/benchmark_results.json` and
`public/providers.json` lives in this directory. The repo copies are the
**canonical** versions going forward — changes to the scrapers/merges should be
committed here so the pipeline's evolution is tracked alongside the frontend
that renders its output. (Snapshots, caches and one-off probe scripts stay out
of the repo on purpose: they are either multi-MB artifacts or transient
diagnostics against temp files.)

## Scripts

| Script | Role |
|--------|------|
| `bench_scraper.py` | The 14-station benchmark scraper + meta miner (stats-88 added the Arena.ai Overall station — LMArena's agent config on the official HF leaderboard-dataset). Playwright-driven; also builds `providers.json` (with `kind` taxonomy) and mines `models_meta` (AA pricing layer, `aa_ttft_seconds`, `available_at`, supersession/stale flags, HF ids, Arena provenance `arena_source`/`arena_raw`). |
| `merge_aa_into_public.py` | Meta-only overlay: merges the AA fields (`pricing_aa_usd_per_1m`, `price_source`, `aa_ttft_seconds`) + fresher OpenRouter fields (`pricing_usd_per_1m`, `max_output_tokens`) from a `--meta-only` scrape onto the LIVE public meta, preserving the hand-baked `available_at` layer. Public-only curated records are never regressed. |
| `merge_full_scrape_into_public.py` | Full-scrape adoption (opposite direction of truth): a complete fresh `/bench` document is the BASE (fresh cells, tables, timestamp); curated `available_at` is restored on shared keys and public-only records whose cells vanished upstream are DROPPED (values printed, nothing silently lost — leak contract). |

## Running a refresh

```bash
# 1. Full scrape (all 13 benchmark sources + catalogs + meta). ~2.5 min.
python3 scripts/bench_scraper.py

# 2a. Fresh-cells day: adopt the full document
python3 scripts/merge_full_scrape_into_public.py

# 2b. Pricing-only day: overlay AA/OR meta onto live public (cheap, no cells move)
python3 scripts/bench_scraper.py --meta-only
python3 scripts/merge_aa_into_public.py
```

Useful flags / env:

- `--meta-only` — skip benchmarks, refresh catalogs + meta only.
- `--providers-only` — rebuild `providers.json` without touching benchmark sources.
- `BENCH_CACHE_TTL=<seconds>` — per-site cache freshness window (default 300 s;
  raise when orchestrating multiple runs in one day to reuse the same-day cache).

## The Arena column (stats-88, 2026-11-18)

One shipped column named `Arena` (renamed from `Arena.ai Text` — the merge
migration renames the key on the public base doc, once, idempotently). Two
sources inside it:

1. **Overall (primary)** — HF dataset `agent` config, category `overall`
   (`_arena_fetch_agent_dataset`): task-outcome deltas from agent work,
   rescaled on the fixed `(-30, +30)` ladder (50 = the agent baseline).
   Vintage ships as `arena_overall_asof`.
2. **Text fill** — models the Overall board does not list yet keep their
   Text presence, quantile-equated onto the Overall delta distribution
   (`merge_arena_columns`: text percentile -> Overall quantile). Monotone
   in Elo, bounded to the Overall board's observed range. Provenance ships
   per row (`models_meta.arena_source` = `overall` | `text-calibrated` |
   `text-only`, `arena_raw` = raw delta / Elo) and the UI marks filled
   cells with a `†` + tooltip.

The `Arena.ai Overall` station ladder: HF datasets-server -> prior-public
recovery (raw deltas from `meta.arena_raw`). If BOTH fail, the run ships a
text-only Arena column (source stamp `text-only`, guard prints a loud NOTE
— disclosed, never silently mixed). The dual-cohort fill error is printed
every run for review (`fill-vs-measured median |err|`).

## Paths

The pipeline scripts (`bench_scraper.py`, `merge_full_scrape_into_public.py`,
`merge_aa_into_public.py`) resolve `public/` from their own location, so the
repo can live anywhere. The `download/` snapshot area defaults to a sibling of
the repo (`<repo>/../download`); override it with `BENCH_DOWNLOAD_DIR=<dir>`.
The scrape cache stays in `/tmp`. The one-off `apply_*` / `dryrun_*` scripts
still carry the historical absolute workspace paths.

## Deploy contract (see `prepush.sh`)

After any pipeline run, `public/*.json` must be `chmod 644` before commit (the
scraper writes them 600). Both copies (download/ + public/) are written by the
merges so future meta-only bases agree with the deployed artifact. CI builds
the bundle; the deploy is a push to `main` followed by polling for the new
bundle hash on GitHub Pages.
