// Unit tests for src/lib/benchScale.js — the stats-35 per-benchmark
// harmonization core shared by the leaderboard score (stores/data.js) and
// the advisor profile score (lib/advisor.js). Pure-function tests on
// hand-built fixtures; the snapshot-backed parity contracts live in
// data.store.test.js (independent mirror) and advisor.test.js (store parity).
import { describe, it, expect } from 'vitest';
import { computeBenchStats, harmonize } from '../../src/lib/benchScale.js';

describe('computeBenchStats', () => {
  it('computes sample mean and sd (ddof=1) over rows that report the bench', () => {
    const rows = [
      { A: 10 }, { A: 20 }, { A: 30 }, { B: 5 },
    ];
    const st = computeBenchStats(rows, ['A', 'B']);
    expect(st.A.mu).toBeCloseTo(20, 12);
    // sample sd (ddof=1) of [10,20,30] = sqrt(200/2) = 10
    expect(st.A.sd).toBeCloseTo(10, 12);
    // single data point → no stats entry (pass-through territory)
    expect(st.B).toBeUndefined();
  });

  it('ignores null/undefined/non-numeric cells instead of coercing them', () => {
    const rows = [{ A: 10 }, { A: null }, { A: undefined }, { A: 'oops' }, { A: 20 }];
    const st = computeBenchStats(rows, ['A']);
    expect(st.A.mu).toBeCloseTo(15, 12);
    expect(st.A.sd).toBeCloseTo(Math.sqrt(50), 12);
  });

  it('empty input → empty stats (nothing harmonized)', () => {
    expect(computeBenchStats([], ['A'])).toEqual({});
    expect(computeBenchStats(null, ['A'])).toEqual({});
  });

  it('zero-variance column gets a guard sd of 1 (no division blowup)', () => {
    const st = computeBenchStats([{ A: 70 }, { A: 70 }, { A: 70 }], ['A']);
    expect(st.A.sd).toBe(1);
    // z of the (only) value = 50 + 15·0/1 = 50
    expect(harmonize('A', 70, st)).toBe(50);
  });
});

describe('harmonize', () => {
  const st = computeBenchStats(
    Array.from({ length: 9 }, (_, i) => ({ A: i * 10 })), // 0..80, μ=40, sd≈25.82
    ['A']);

  it('maps the mean to 50 and scales by 15 per sd', () => {
    expect(harmonize('A', 40, st)).toBeCloseTo(50, 12);
    expect(harmonize('A', st.A.mu + st.A.sd, st)).toBeCloseTo(65, 12);
    expect(harmonize('A', st.A.mu - st.A.sd, st)).toBeCloseTo(35, 12);
  });

  it('clips to 0-100 so outliers cannot dominate a sparse average', () => {
    expect(harmonize('A', 1000, st)).toBe(100);
    expect(harmonize('A', -1000, st)).toBe(0);
  });

  it('missing value → null; unknown bench → raw pass-through (stale stats table can never zero a column)', () => {
    expect(harmonize('A', null, st)).toBeNull();
    expect(harmonize('A', undefined, st)).toBeNull();
    expect(harmonize('Not-A-Bench', 73.5, st)).toBe(73.5);
    expect(harmonize('A', 42, {})).toBe(42);
    expect(harmonize('A', 42, null)).toBe(42);
  });
});
