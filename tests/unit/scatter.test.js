// stats-31: Value map core — axis registry, scale/tick builders, honest
// point building and the Pareto value frontier. All pure functions from
// src/lib/scatter.js, tested with injected store accessors (no Vue).
import { describe, it, expect } from 'vitest';
import {
  AXES, X_AXIS_IDS, Y_AXIS_IDS, axisOptions, isAxisId,
  niceTicks, logTicks, linearDomain, logDomain, makeScale,
  buildScatterPoints, valueFrontier, frontierPath,
} from '../../src/lib/scatter.js';

// ── fake store accessors (the api the view injects) ────────────────────
const mkApi = (over = {}) => ({
  scoreFor: (r) => r._score ?? null,
  clFor: (r) => r._cl ?? 0,
  priceFor: (r) => r._price ?? null,
  valueFor: (r) => r._value ?? null,
  metaFor: (r) => r._meta ?? null,
  isOlder: (r) => !!r._older,
  releaseOf: (r) => r._created ?? null,
  isNew: (c) => !!c && c >= '2026-09-05',
  providerOf: (r) => ({ name: r._prov ?? 'Independent', color: '#4f6dff' }),
  ...over,
});
const row = (name, props = {}) => ({ name, ...props });

describe('axis registry', () => {
  it('exposes every metric with dropdown + axis metadata', () => {
    for (const id of [...X_AXIS_IDS, ...Y_AXIS_IDS]) {
      const m = AXES[id];
      expect(m, id).toBeTruthy();
      expect(m.label.length, id).toBeGreaterThan(0);
      expect(m.title.length, id).toBeGreaterThan(0);
      expect(['linear', 'log']).toContain(m.scale);
      expect(['high', 'low']).toContain(m.better);
      expect(typeof m.fmt(null)).toBe('string');
    }
  });

  it('defaults match the brief: X = Score, Y = Blended price', () => {
    expect(X_AXIS_IDS[0]).toBe('score');
    expect(Y_AXIS_IDS[0]).toBe('blend');
    expect(AXES.score.better).toBe('high');
    expect(AXES.blend.better).toBe('low');
    expect(AXES.blend.scale).toBe('log'); // prices span decades
  });

  it('dropdown options + id validation', () => {
    expect(axisOptions(['score'])).toEqual([{ id: 'score', label: 'Score' }]);
    expect(isAxisId('ttft')).toBe(true);
    expect(isAxisId('nope')).toBe(false);
  });

  it('accessors are null-safe on empty rows/meta', () => {
    const api = mkApi();
    for (const id of Object.keys(AXES)) {
      const v = AXES[id].get(row('x'), api, Date.now());
      if (id === 'cl') expect(v).toBe(0);        // CL of no evidence is a true 0%
      else expect(v, id).toBeNull();             // everything else stays an honest gap
    }
  });
});

describe('niceTicks (linear)', () => {
  it('uses 1/2/5 steps and covers the span', () => {
    expect(niceTicks(0, 100, 6)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(0, 5, 6)).toEqual([0, 1, 2, 3, 4, 5]);
    const t = niceTicks(3, 87, 6);
    expect(t[0]).toBeLessThanOrEqual(3);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(87);
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1]);
  });

  it('handles sub-unit price ranges without float dust', () => {
    const t = niceTicks(0.07, 0.9, 6);
    expect(t[0]).toBeLessThanOrEqual(0.07 + 1e-9);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(0.9 - 1e-9);
    for (const v of t) expect(String(v)).not.toContain('000000003');
  });

  it('is degenerate-safe', () => {
    expect(niceTicks(5, 5, 5)).toHaveLength(3);
    expect(niceTicks(NaN, 10, 5)).toHaveLength(3);
  });
});

describe('logTicks (decades)', () => {
  it('emits 1/2/5 decades across a wide price span', () => {
    const t = logTicks(0.07, 120);
    for (const v of [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100]) expect(t).toContain(v);
    expect(t[0]).toBeGreaterThanOrEqual(0.07 * 0.999);
    expect(t[t.length - 1]).toBeLessThanOrEqual(120 * 1.001);
  });

  it('fills narrow spans so a log axis is never bare', () => {
    const t = logTicks(55, 90);
    expect(t.length).toBeGreaterThanOrEqual(3);
    for (const v of t) expect(v).toBeGreaterThan(54.9);
  });

  it('refuses non-positive ranges', () => {
    expect(logTicks(0, 10)).toEqual([]);
    expect(logTicks(-1, 5)).toEqual([]);
  });
});

describe('domains + scales', () => {
  it('linear domain pads 6% and snaps out to nice ticks', () => {
    const [lo, hi] = linearDomain(10, 90, AXES.score);
    expect(lo).toBeLessThanOrEqual(10);
    expect(hi).toBeGreaterThanOrEqual(90);
  });

  it('zeroFloor metrics never dip below 0 (age, CL)', () => {
    for (const id of ['age', 'cl']) {
      const [lo] = linearDomain(0, 30, AXES[id]);
      expect(lo).toBeGreaterThanOrEqual(0);
    }
  });

  it('log domain pads multiplicatively', () => {
    const [lo, hi] = logDomain(0.5, 40);
    expect(lo).toBeCloseTo(0.3125, 6);
    expect(hi).toBeCloseTo(64, 6);
  });

  it('makeScale maps values into 0..1 and labels its ticks', () => {
    const s = makeScale(AXES.score, 40, 90, 'linear');
    // 6% padding: the data extremes sit strictly inside the domain
    expect(s.frac(40)).toBeGreaterThan(0);
    expect(s.frac(90)).toBeLessThan(1);
    expect(s.frac(65)).toBeGreaterThan(s.frac(40));
    expect(s.frac(65)).toBeLessThan(s.frac(90));
    expect(s.ticks.length).toBeGreaterThan(2);
    for (const t of s.ticks) expect(typeof t.label).toBe('string');

    const p = makeScale(AXES.blend, 0.1, 100); // default log
    expect(p.frac(0.1)).toBeLessThan(p.frac(1));
    expect(p.frac(1)).toBeLessThan(p.frac(10));
    expect(p.frac(10)).toBeLessThan(1);
    expect(p.ticks.map((t) => t.v)).toContain(1);
  });

  it('log scale clamps non-positive input instead of NaN-ing', () => {
    const p = makeScale(AXES.blend, 0.1, 100, 'log');
    expect(Number.isFinite(p.frac(0))).toBe(true);
  });
});

describe('buildScatterPoints (honest exclusions)', () => {
  const NOW = Date.parse('2026-09-10T12:00:00Z');
  const rows = [
    row('A', { _score: 80, _cl: 100, _price: { input: 1, output: 4, blend: 1.75 } }),
    row('B', { _score: 60, _cl: 50, _price: { input: 0.1, output: 0.3, blend: 0.15 } }),
    row('NoPrice', { _score: 70, _cl: 100 }),                       // no price at all
    row('ZeroPrice', { _score: 65, _cl: 100, _price: { input: 0, output: 0, blend: 0 } }), // free tier
    row('NoScore', { _cl: 0, _price: { input: 2, output: 8, blend: 3.5 } }),               // no benchmarks
    row('Old', { _score: 75, _cl: 100, _price: { input: 1, output: 2, blend: 1.25 }, _older: true }),
    row('Dated', { _score: 55, _cl: 100, _price: { input: 3, output: 3, blend: 3 }, _created: '2026-09-06' }),
  ];

  it('default axes = Score × Blended price, current generation only', () => {
    const { points, hidden, hiddenTotal } = buildScatterPoints(rows, 'score', 'blend', mkApi(), { now: NOW });
    expect(points.map((p) => p.name).sort()).toEqual(['A', 'B', 'Dated']);
    expect(hidden).toEqual({ x: 1, y: 2 }); // NoScore lacks x; NoPrice + ZeroPrice lack y (log)
    expect(hiddenTotal).toBe(3);
    const dated = points.find((p) => p.name === 'Dated');
    expect(dated.isNew).toBe(true);           // released within the NEW window
    expect(dated.provider.color).toBe('#4f6dff');
  });

  it('includeOlder brings stale generations back', () => {
    const { points } = buildScatterPoints(rows, 'score', 'blend', mkApi(), { includeOlder: true, now: NOW });
    expect(points.map((p) => p.name)).toContain('Old');
    expect(points.find((p) => p.name === 'Old').older).toBe(true);
  });

  it('zero price plots fine on a linear scale but not on log', () => {
    const lin = buildScatterPoints(rows, 'score', 'blend', mkApi(), { now: NOW, yScale: 'linear' });
    expect(lin.points.map((p) => p.name)).toContain('ZeroPrice');
    const log = buildScatterPoints(rows, 'score', 'blend', mkApi(), { now: NOW, yScale: 'log' });
    expect(log.points.map((p) => p.name)).not.toContain('ZeroPrice');
  });

  it('metric swaps re-filter honestly (TTFT axis drops meta-less rows)', () => {
    const { points, hiddenTotal } = buildScatterPoints(rows, 'score', 'ttft', mkApi(), { now: NOW });
    expect(points).toHaveLength(0); // none of the fixtures carry aa_ttft
    expect(hiddenTotal).toBe(6);    // 5 rows lack y; NoScore also lacks x; Old is older-gated (uncounted)
  });

  it('age metric reads days since release off the injected clock', () => {
    const { points } = buildScatterPoints(rows, 'age', 'blend', mkApi(), { now: NOW });
    const dated = points.find((p) => p.name === 'Dated');
    expect(dated.x).toBeCloseTo(4.5, 6); // 2026-09-06 → 4.5 days before the clock
    const aged = points.filter((p) => p.name === 'A' || p.name === 'B');
    expect(aged).toHaveLength(0);        // no release date → honest exclusion
  });
});

describe('valueFrontier (Pareto)', () => {
  const pt = (name, x, y) => ({ name, x, y });

  it('keeps models nothing else beats on both axes (score↑ / price↓)', () => {
    // Domished (60, $60) is dominated by everyone; Mid (65, $10) is beaten
    // by Budget king on BOTH axes (cheaper AND higher-scored)
    const pts = [pt('Flagship', 90, 50), pt('Budget king', 70, 2), pt('Mid', 65, 10), pt('Domished', 60, 60)];
    const f = valueFrontier(pts, 'high', 'low').map((p) => p.name).sort();
    expect(f).toEqual(['Budget king', 'Flagship']);
  });

  it('a point one notch cheaper but worse is NOT dominated', () => {
    const pts = [pt('A', 80, 10), pt('B', 79.9, 9)];
    expect(valueFrontier(pts, 'high', 'low').map((p) => p.name).sort()).toEqual(['A', 'B']);
  });

  it('exact duplicates both stay on the frontier', () => {
    const pts = [pt('A', 80, 10), pt('B', 80, 10), pt('C', 75, 10)];
    expect(valueFrontier(pts, 'high', 'low').map((p) => p.name).sort()).toEqual(['A', 'B']);
  });

  it('float dust cannot dominate (epsilon guard)', () => {
    const pts = [pt('A', 80.0000000001, 5), pt('B', 80, 5)];
    expect(valueFrontier(pts, 'high', 'low').map((p) => p.name).sort()).toEqual(['A', 'B']);
  });

  it('directions follow the metrics (ttft↓ / value↑ pairing)', () => {
    // Worst (5, 5): Fast is faster AND higher-value → dominates it
    const pts = [pt('Fast', 0.4, 10), pt('SlowSmart', 8, 100), pt('Worst', 5, 5)];
    expect(valueFrontier(pts, 'low', 'high').map((p) => p.name).sort()).toEqual(['Fast', 'SlowSmart']);
  });

  it('frontierPath orders left → right for the polyline', () => {
    const pts = [pt('R', 90, 5), pt('L', 40, 50), pt('M', 65, 12)];
    expect(frontierPath(pts).map((p) => p.name)).toEqual(['L', 'M', 'R']);
  });
});
