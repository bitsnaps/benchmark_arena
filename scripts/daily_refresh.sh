#!/usr/bin/env bash
# stats-29: unattended daily data refresh — the cron entrypoint.
#
# Full scrape -> full-document merge -> lane bakes -> sanity guard -> prepush
# gate -> commit. The operator (cron agent) pushes afterwards; deploy = push
# to main. Recipe per scripts/DATA_PIPELINE.md "Running a refresh"
# (fresh-cells path).
#
# stats-96 (2026-11-22): the stats-91/93 lane bakes joined the refresh. The
# merge's fresh-cells adoption rebuilds the doc from the raw scrape and does
# NOT carry lane state (vendor_scores, MaxxBench stamps/cells, census
# additions) — first seen 2026-11-21 when the post-stats-94 refresh dropped
# both lanes and compare/oronly e2e went red. The bakes restore them before
# the guard; each bake failing is a WARNING here and the guard's lane floors
# (stats-96 4e/4f) turn it into a hard abort — nothing ships without lanes.
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

echo "[daily] 1/8 full scrape: 14 benchmark stations + catalogs + meta (~2.5 min warm)"
python3 scripts/bench_scraper.py

echo "[daily] 2/8 adopt the full document as base (fresh-cells path)"
python3 scripts/merge_full_scrape_into_public.py

echo "[daily] 3/8 bake Poe seller listings into available_at (stats-59)"
if ! python3 scripts/bake_poe_available_at.py; then
  echo "[daily] WARNING: Poe bake failed - continuing with previous available_at"
fi

echo "[daily] 4/8 bake MaxxBench column + census growth (stats-93/96)"
if ! python3 scripts/bake_maxxbench.py --apply; then
  echo "[daily] WARNING: MaxxBench bake failed - guard floor 4e will abort"
fi

echo "[daily] 5/8 bake vendor scores, HF sha-diffed (stats-91/96 phase-2)"
if ! python3 scripts/bake_vendor_scores.py --apply; then
  echo "[daily] WARNING: vendor bake failed - guard floor 4f will abort"
fi

echo "[daily] 6/8 data sanity guard vs git HEAD"
python3 scripts/daily_guard.py

echo "[daily] 7/8 prepush gate (unit + leak + build + e2e)"
bash scripts/prepush.sh

echo "[daily] 8/8 publish permissions + commit"
chmod 644 public/*.json
git -c core.fileMode=false add public/benchmark_results.json public/providers.json
if git -c core.fileMode=false diff --cached --quiet; then
  echo "[daily] no data changes vs HEAD - nothing to commit (upstream data identical)"
else
  git -c core.fileMode=false commit -m "daily data refresh $(date -u +%F)"
  echo "[daily] committed - ready to push (deploy)"
fi
echo "[daily] DONE"
