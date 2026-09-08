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
| `bench_scraper.py` | The 13-site benchmark scraper + meta miner. Playwright-driven; also builds `providers.json` (with `kind` taxonomy) and mines `models_meta` (AA pricing layer, `aa_ttft_seconds`, `available_at`, supersession/stale flags, HF ids). |
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

## Workspace-path assumption

The scripts carry absolute workspace paths (`/home/z/my-project/...`) for the
download/ snapshot area, the public JSONs they write and the `/tmp` scrape
cache. They run as-is inside the workspace that hosts this repo. If the repo
moves to another machine, adjust `PROVIDERS_JSON_PATH`, `PROVIDERS_PUBLIC_PATH`
and the download paths at the top of each script's I/O section — or introduce
env overrides then.

## Deploy contract (see `prepush.sh`)

After any pipeline run, `public/*.json` must be `chmod 644` before commit (the
scraper writes them 600). Both copies (download/ + public/) are written by the
merges so future meta-only bases agree with the deployed artifact. CI builds
the bundle; the deploy is a push to `main` followed by polling for the new
bundle hash on GitHub Pages.
