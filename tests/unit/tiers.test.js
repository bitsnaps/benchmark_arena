// stats-60: model grades (S/A/B/C/D) — the grading core (lib/tiers.js) and
// its honesty rules, plus a snapshot-wide block that re-derives grades from
// the REAL committed document via the store (parity with scoreForModel, the
// metric the leaderboard ranks by).
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const snapshot = JSON.parse(readFileSync(path.join(REPO, 'public/benchmark_results.json'), 'utf8'));

// localStorage is unavailable in the node test env — the singleton must
// degrade gracefully (same convention as lib/newFlag.js).
vi.stubGlobal('localStorage', {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
});

import {
  GRADE_LETTERS, GRADE_UNRATED, MIN_COVERED_FOR_GRADE, TIERS_BOUNDARY_GRID,
  TIERS_MODES, TIERS_MODE_DEFAULT, TIERS_STORAGE_KEY,
  tiersMode, setTiersMode, applyTiersParam,
  kmeans1d, gradeBounds, gradeIndexOf, computeGradeMaps,
  gradeTitle, valueGradeTitle, SPEED_TIER_TITLE, TIERS_METHOD_NOTE,
} from '../../src/lib/tiers.js';

// ── Snapshot-wide block: grades over the REAL committed document ────────
// The store stub (fetch → committed snapshot) re-derives everything; the
// assertions are invariants, never pinned names — a data refresh cannot
// break the gate, but a grading regression cannot slip through either.
vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => snapshot })));
const { ensureLoaded, useData } = await import('../../src/stores/data.js');

describe('kmeans1d (deterministic 1-D clustering)', () => {
  it('returns sorted centers and never depends on input order', () => {
    const a = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const c1 = kmeans1d(a, 3);
    const c2 = kmeans1d([...a].reverse(), 3);
    expect(c1).toEqual(c2);
    expect([...c1]).toEqual([...c1].sort((x, y) => x - y));
  });

  it('caps k at the distinct value count (never zero-width clusters)', () => {
    expect(kmeans1d([1, 2], 5).length).toBe(2);
    expect(kmeans1d([42], 3).length).toBe(1);
    const c = kmeans1d([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 5);
    expect(new Set(c).size).toBe(c.length); // distinct seeds → distinct centers
  });

  it('degrades on empty / single-value input', () => {
    expect(kmeans1d([], 5)).toEqual([]);
    expect(kmeans1d([42], 3)).toEqual([42]);
  });
});

describe('gradeBounds + gradeIndexOf (snapping + tie integrity)', () => {
  it('snaps midpoints to the 0.5 grid', () => {
    const b = gradeBounds([40.3, 51.7, 63.1]);
    expect(b).toEqual([46, 57.5]); // 46.0 (46.0 exactly on grid), 57.5 (57.4 → 57.5)
  });

  it('is monotone: higher score never gets a worse grade', () => {
    const bounds = [46.5, 51.5, 57.5, 65];
    const scores = [30, 40, 46.5, 46.6, 51.4, 51.6, 57.4, 60, 65, 70, 90];
    const grades = scores.map(s => gradeIndexOf(s, bounds));
    for (let i = 1; i < grades.length; i++) {
      expect(grades[i]).toBeGreaterThanOrEqual(grades[i - 1]);
    }
  });

  it('equal scores never split across a boundary (strict >)', () => {
    const bounds = [46.5, 51.5, 57.5, 65];
    const g = gradeIndexOf(51.5, bounds); // exactly ON a boundary
    expect(g).toBe(gradeIndexOf(51.4, bounds)); // same side as just-below
    expect(g).toBeLessThan(gradeIndexOf(51.6, bounds)); // above moves up
  });

  it('a score sitting exactly on a boundary takes the LOWER grade', () => {
    expect(gradeIndexOf(51.5, [51.5])).toBe(0);
  });
});

describe('computeGradeMaps (the honesty rules)', () => {
  const rows = [
    { name: 'Alpha', score: 80, cov: 8 },
    { name: 'Beta', score: 70, cov: 8 },
    { name: 'Gamma', score: 55, cov: 6 },
    { name: 'Delta', score: 45, cov: 5 },
    { name: 'Sparse', score: 85, cov: 2 },  // under the coverage gate
    { name: 'NoScore', score: null, cov: 8 }, // nothing to grade
  ];
  const maps = computeGradeMaps({
    rows,
    scoreOf: (r) => r.score,
    valueOf: (r) => r.score,
    coverageOf: (r) => r.cov,
  });

  it('grades only rated rows and respects the coverage gate', () => {
    expect(maps.overall.letters.has('Alpha')).toBe(true);
    expect(maps.overall.letters.has('Sparse')).toBe(false); // cov 2 < 3
    expect(maps.overall.letters.has('NoScore')).toBe(false);
  });

  it('labels are S/A/B/C/D with S reserved for the top cluster', () => {
    for (const letter of maps.overall.letters.values()) {
      expect(GRADE_LETTERS).toContain(letter);
    }
    expect(maps.overall.letters.get('Alpha')).toBe('S');
  });

  it('is monotone over rated rows (grade order matches score order)', () => {
    const pairs = rows
      .filter(r => maps.overall.letters.has(r.name))
      .map(r => [r.score, GRADE_LETTERS.indexOf(maps.overall.letters.get(r.name))]);
    for (const [sa, ga] of pairs) {
      for (const [sb, gb] of pairs) {
        if (sa > sb) expect(ga).toBeLessThanOrEqual(gb);
      }
    }
  });

  it('dedupes duplicate row entries (first wins)', () => {
    const m = computeGradeMaps({
      rows: [{ name: 'X', score: 60, cov: 4 }, { name: 'X', score: 10, cov: 4 }, { name: 'Y', score: 20, cov: 4 }],
      scoreOf: (r) => r.score, valueOf: () => null, coverageOf: (r) => r.cov,
    });
    // first occurrence (60) wins; the duplicate never re-grades the key
    expect([...m.overall.letters.keys()].filter(k => k === 'X').length).toBe(1);
    // two separable clusters → the board spans the TOP two letters: S/A
    expect(m.overall.letters.get('X')).toBe('S'); // 60 > 20 — best of two
    expect(m.overall.letters.get('Y')).toBe('A');
  });

  it('produces no grades when fewer than 2 distinct scores exist', () => {
    const m = computeGradeMaps({
      rows: [{ name: 'A', score: 50, cov: 4 }, { name: 'B', score: 50, cov: 4 }],
      scoreOf: (r) => r.score, valueOf: () => null, coverageOf: (r) => r.cov,
    });
    expect(m.overall.bounds).toBeNull();
    expect(m.overall.letters.size).toBe(0);
  });

  it('caps k at the distinct count (never more grades than separable)', () => {
    const m = computeGradeMaps({
      rows: [
        { name: 'A', score: 10, cov: 4 },
        { name: 'B', score: 10.1, cov: 4 },
        { name: 'C', score: 10.2, cov: 4 },
      ],
      scoreOf: (r) => r.score, valueOf: () => null, coverageOf: (r) => r.cov,
    });
    expect([...m.overall.letters.values()].every(l => GRADE_LETTERS.includes(l))).toBe(true);
  });
});

describe('mode singleton (persistence + deep link)', () => {
  it('defaults to Overall grade', () => {
    expect(TIERS_MODE_DEFAULT).toBe('overall');
    expect(TIERS_MODES.map(m => m.id)).toEqual(['overall', 'axis', 'off']);
  });

  it('setTiersMode accepts only known modes and persists', () => {
    setTiersMode('axis');
    expect(tiersMode.value).toBe('axis');
    setTiersMode('bogus');
    expect(tiersMode.value).toBe('overall'); // invalid → default
    setTiersMode('off');
    expect(tiersMode.value).toBe('off');
    setTiersMode('overall');
  });

  it('applyTiersParam: valid ids apply (returns true), unknown ignored (false)', () => {
    expect(applyTiersParam('axis')).toBe(true);
    expect(tiersMode.value).toBe('axis');
    expect(applyTiersParam('nonsense')).toBe(false);
    expect(tiersMode.value).toBe('axis'); // untouched by the bad param
    expect(applyTiersParam(null)).toBe(false);
    expect(applyTiersParam('')).toBe(false);
    setTiersMode('overall');
  });
});

describe('wording (single source, tooltip copy)', () => {
  it('explains the method, the gate and the boundary rule', () => {
    expect(TIERS_METHOD_NOTE).toContain('k-means');
    expect(TIERS_METHOD_NOTE).toContain('0.5');
    expect(TIERS_METHOD_NOTE).toContain('Unrated');
    expect(gradeTitle('Unrated', [])).toContain(`fewer than ${MIN_COVERED_FOR_GRADE}`);
    expect(gradeTitle('S', [46.5, 51.5, 57.5, 65])).toContain('Grade S');
    expect(gradeTitle('S', [])).toContain('lower grade');
    expect(valueGradeTitle('B', [1.5])).toContain('value lens');
    expect(SPEED_TIER_TITLE).toContain('TTFT');
  });

  it('keeps the shipped grid constant', () => {
    expect(TIERS_BOUNDARY_GRID).toBe(0.5);
  });
});

// ── Snapshot-wide block: grades over the REAL committed document ────────
// (store imported at module level above, fetch stubbed to the snapshot)
describe('grades on the live snapshot (via the store)', () => {
  let d;
  beforeAll(async () => {
    await ensureLoaded();
    d = useData();
  });

  it('grades exist, are S/A/B/C/D and follow the ranked composite', () => {
    const rows = d.pivotAll.value.filter(r => d.gradeFor(r));
    expect(rows.length).toBeGreaterThan(5);
    const scoreOf = (r) => d.scoreForModel(r);
    for (const a of rows) {
      for (const b of rows) {
        if (scoreOf(a) > scoreOf(b)) {
          expect(GRADE_LETTERS.indexOf(d.gradeFor(a)))
            .toBeLessThanOrEqual(GRADE_LETTERS.indexOf(d.gradeFor(b)));
        }
      }
    }
  });

  it('honors the coverage gate against the current avg set', () => {
    for (const r of d.pivotAll.value) {
      const letter = d.gradeFor(r);
      if (letter === null) continue;
      expect(d.coveredCountForModel(r)).toBeGreaterThanOrEqual(MIN_COVERED_FOR_GRADE);
    }
  });

  it('unrated rows are exactly those without a grade letter', () => {
    let rated = 0;
    let unrated = 0;
    for (const r of d.pivotAll.value) {
      if (d.gradeFor(r)) rated++;
      else unrated++;
    }
    expect(rated).toBeGreaterThan(0);
    expect(unrated).toBeGreaterThan(0); // the gate must exclude somebody
  });

  it('value grades only exist where a value score exists', () => {
    for (const r of d.pivotAll.value) {
      const vg = d.gradeValueFor(r);
      if (vg === null) continue;
      expect(d.valueFor(r)).not.toBeNull();
      expect(GRADE_LETTERS).toContain(vg);
    }
  });

  it('speed tiers reuse the shipped TTFT ladder', () => {
    let seen = 0;
    for (const r of d.pivotAll.value) {
      const s = d.gradeSpeedFor(r);
      if (s === null) continue;
      seen++;
      expect(['fast', 'ok', 'slow']).toContain(s);
    }
    expect(seen).toBeGreaterThan(0);
  });
});
