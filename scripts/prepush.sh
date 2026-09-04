#!/usr/bin/env bash
# Pre-push gate for benchmark_arena — run this before every `git push`.
# Mirrors exactly what CI runs before deploying (see .github/workflows/deploy.yml).
#   1. unit tests (vitest)          — store freshness/ranking logic
#   2. data leak guard (python)     — committed JSON has no visible old generations
#   3. build + browser e2e (playwright) — UI hides older models everywhere
set -euo pipefail
cd "$(dirname "$0")/.."

echo "── 1/3  unit tests ──────────────────────────────────────────"
pnpm run test

echo "── 2/3  data leak guard ─────────────────────────────────────"
pnpm run test:leak

echo "── 3/3  build + e2e ─────────────────────────────────────────"
pnpm run build
pnpm run test:e2e

echo ""
echo "PREPUSH GATE PASSED — safe to push."
