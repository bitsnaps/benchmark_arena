// ── stats-35: per-benchmark scale harmonization (shared scoring core) ──
// Benchmarks arrive on incomparable distributions even though every cell is
// nominally 0-100: after the pipeline's range-rescale, Arena.ai Text has a
// median around 83 while the AA Intelligence Index median sits near 26 and
// FrontierSWE near 26. Averaging raw cells therefore measures WHICH
// benchmarks a model covered as much as how strong it is, and the CL
// blend's "neutral 50" prior for missing cells is not neutral on a mixed
// scale — a 2-of-8 chat-only model kept too much of its inflated average
// (72 catalog-wide ranking inversions in the 2026-09-13 recon).
//
// benchScale z-normalizes each benchmark across every shipped row
// (unified_closed + unified_open): z = 50 + 15·(x−μ)/σ, clipped to [0,100].
// On this scale 50 means "median model on that benchmark", so the neutral
// prior is finally neutral and sparse averages compare like with like.
// With the supersession/staleness fixes this cuts the ranking inversions
// 72 → 29 while keeping the top of the board in the same order.
//
// Consumers: stores/data.js scoreForModel (leaderboard) and
// lib/advisor.js profileScoreFor (advisor) — both MUST use these stats so
// the two scores stay parity-equal (tests/unit/advisor.test.js).

// Sample mean/sd (ddof=1) per benchmark over the rows that report it.
// Benchmarks with fewer than 2 data points get no entry — their values
// pass through unharmonized (harmonize() falls back to the raw value).
export function computeBenchStats(rows, benches) {
  const stats = {};
  for (const b of benches) {
    let sum = 0;
    let n = 0;
    for (const r of rows || []) {
      const raw = r?.[b];
      if (raw === null || raw === undefined) continue;
      const v = Number(raw);
      if (Number.isNaN(v)) continue;
      sum += v;
      n++;
    }
    if (n < 2) continue;
    const mu = sum / n;
    let ss = 0;
    for (const r of rows || []) {
      const raw = r?.[b];
      if (raw === null || raw === undefined) continue;
      const v = Number(raw);
      if (Number.isNaN(v)) continue;
      ss += (v - mu) * (v - mu);
    }
    const sd = Math.sqrt(ss / (n - 1));
    stats[b] = { mu, sd: sd > 1e-9 ? sd : 1 };
  }
  return stats;
}

// Map a raw benchmark cell onto the harmonized 0-100 scale. Missing stats
// (bench unknown to the stats table) pass the raw value through so a stale
// stats table can never zero out a column.
export function harmonize(bench, value, stats) {
  if (value === null || value === undefined) return null;
  const st = stats?.[bench];
  if (!st) return value;
  const z = 50 + (15 * (value - st.mu)) / st.sd;
  return Math.max(0, Math.min(100, z));
}
