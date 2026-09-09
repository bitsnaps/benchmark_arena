#!/usr/bin/env bash
# stats-29: unattended daily data refresh — the cron entrypoint.
#
# Full scrape -> full-document merge -> sanity guard -> prepush gate -> commit.
# The operator (cron agent) pushes afterwards; deploy = push to main.
# Recipe per scripts/DATA_PIPELINE.md "Running a refresh" (fresh-cells path).
#
# Failure contract: any step failing aborts the run with a non-zero exit and
# nothing is committed. The guard (daily_guard.py) blocks upstream-layout
# regressions and silent-miner output before they can reach main.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[daily] preflight"
[ -f scripts/bench_scraper.py ] || { echo "[daily] ABORT: run from repo scripts/, wrong layout"; exit 2; }
[ -d node_modules ] || { echo "[daily] ABORT: node_modules missing - rebuild env first (pnpm shim + install, see worklog)"; exit 2; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "[daily] ABORT: not a git repo"; exit 2; }

echo "[daily] 1/5 full scrape: 13 benchmark sources + catalogs + meta (~2.5 min)"
python3 scripts/bench_scraper.py

echo "[daily] 2/5 adopt the full document as base (fresh-cells path)"
python3 scripts/merge_full_scrape_into_public.py

echo "[daily] 3/5 data sanity guard vs git HEAD"
python3 scripts/daily_guard.py

echo "[daily] 4/5 prepush gate (unit + leak + build + e2e)"
bash scripts/prepush.sh

echo "[daily] 5/5 publish permissions + commit"
chmod 644 public/*.json
git -c core.fileMode=false add public/benchmark_results.json public/providers.json
if git -c core.fileMode=false diff --cached --quiet; then
  echo "[daily] no data changes vs HEAD - nothing to commit (upstream data identical)"
else
  git -c core.fileMode=false commit -m "daily data refresh $(date -u +%F)"
  echo "[daily] committed - ready to push (deploy)"
fi
echo "[daily] DONE"
