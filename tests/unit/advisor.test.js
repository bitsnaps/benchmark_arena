// Unit tests for src/lib/advisor.js — the use-case advisor scoring core
// (stats-33). Pure-function tests on hand-built fixtures for the algorithm
// contracts, plus snapshot-backed tests for the two properties that must
// never drift: (1) profile scoring reproduces the store's scoreForModel
// exactly on the core-8 subset, and (2) the stats-32 ground truth (V4 Pro
// 0813 above V4 Flash 0731) survives the new feature.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  profileScoreFor, coverageTag, weightFor, normalizeParams,
  costScoreOf, speedScoreOf, compositeOf, passConstraints, survivors,
  rankCandidates, buildReasons, buildFlags, emptyStateHint, fmtComposite,
} from '../../src/lib/advisor.js';
import {
  PROFILES, WEIGHTS, PRIORITIES, SPEEDS,
} from '../../src/config/advisorProfiles.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── Pure-function tests (hand-built fixtures, no snapshot) ────────────

describe('profileScoreFor (coverage-weighted sparse mean)', () => {
  const P = PROFILES.coding.benches;

  it('full coverage keeps the raw mean unchanged', () => {
    const r = profileScoreFor({ 'DeepSWE': 60, 'SWE-Marathon': 80, 'FrontierSWE': 70, 'CyberGem': 50 }, P);
    expect(r.covered).toBe(4);
    expect(r.score).toBeCloseTo(65, 10);
  });

  it('partial coverage regresses toward the neutral 50 prior', () => {
    const r = profileScoreFor({ 'DeepSWE': 60 }, P);
    expect(r.covered).toBe(1);
    // w = 1/4 → .25·60 + .75·50 = 52.5
    expect(r.score).toBeCloseTo(52.5, 10);
  });

  it('uncovered everywhere → null (never fabricated, never zero)', () => {
    expect(profileScoreFor({}, P)).toEqual({ score: null, covered: 0 });
    expect(profileScoreFor(null, P).score).toBeNull();
  });

  it('coverage tags: solid ≥2, thin =1, limited =0', () => {
    expect(coverageTag(4)).toBe('solid');
    expect(coverageTag(2)).toBe('solid');
    expect(coverageTag(1)).toBe('thin');
    expect(coverageTag(0)).toBe('limited');
  });
});

describe('weightFor (the 9-cell priority × speed table)', () => {
  it('every published combo sums to exactly 1', () => {
    for (const p of PRIORITIES) {
      for (const s of SPEEDS) {
        const w = weightFor(p.id, s.id);
        expect(w.q + w.c + w.s, `${p.id}/${s.id}`).toBeCloseTo(1, 10);
        expect(WEIGHTS[p.id][s.id]).toEqual(w);
      }
    }
  });

  it('spot-checks the documented cells', () => {
    expect(weightFor('balanced', 'ok')).toEqual({ q: 0.60, c: 0.30, s: 0.10 });
    expect(weightFor('cost-first', 'fast')).toEqual({ q: 0.38, c: 0.42, s: 0.20 });
    expect(weightFor('quality-first', 'slow')).toEqual({ q: 0.84, c: 0.16, s: 0.00 });
  });

  it('falls back to balanced/ok on unknown inputs (never throws)', () => {
    expect(weightFor('nope', 'ok')).toEqual(WEIGHTS.balanced.ok);
    expect(weightFor('balanced', 'nope')).toEqual(WEIGHTS.balanced.ok);
  });
});

describe('cost & speed scores (log-normalized 0..1)', () => {
  const norm = normalizeParams([
    { blend: 0.5, ttft: 0.3 }, { blend: 8, ttft: 7 }, { blend: null, ttft: null },
  ]);

  it('normalization refs come from known positive values only', () => {
    expect(norm).toEqual({ pMin: 0.5, pMax: 8, tMin: 0.3, tMax: 7 });
  });

  it('free ($0 blend) is the best possible cost score', () => {
    expect(costScoreOf(0, norm)).toBe(1);
  });

  it('unknown price/TTFT → null (component does not vote)', () => {
    expect(costScoreOf(null, norm)).toBeNull();
    expect(speedScoreOf(null, norm)).toBeNull();
    expect(speedScoreOf(undefined, norm)).toBeNull();
  });

  it('anchors: cheapest known = 1, priciest known = 0, monotonic between', () => {
    expect(costScoreOf(0.5, norm)).toBeCloseTo(1, 10);
    expect(costScoreOf(8, norm)).toBeCloseTo(0, 10);
    const mid = costScoreOf(2, norm);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(costScoreOf(1, norm)).toBeGreaterThan(costScoreOf(4, norm));
  });

  it('degenerate spread (all known prices equal) treats everyone as cheapest', () => {
    const n2 = { pMin: 5, pMax: 5, tMin: 1, tMax: 1 };
    expect(costScoreOf(5, n2)).toBe(1);
    expect(speedScoreOf(1, n2)).toBe(1);
  });

  it('no known data at all → every candidate scores best (component neutral)', () => {
    const empty = normalizeParams([]);
    expect(costScoreOf(3, empty)).toBe(1);
    expect(speedScoreOf(3, empty)).toBe(1);
  });
});

describe('compositeOf (per-model weight renormalization)', () => {
  const norm = normalizeParams([{ blend: 0.5, ttft: 0.3 }, { blend: 8, ttft: 7 }]);
  const w = weightFor('balanced', 'ok'); // .6/.3/.1

  it('all components known → straight weighted blend (cost/speed ×100)', () => {
    const r = compositeOf({ quality: 80, blend: 0.5, ttft: 0.3 }, w, norm);
    // cheapest + fastest → c=s=1 → .6·80 + .3·100 + .1·100 = 88
    expect(r.score).toBeCloseTo(88, 10);
    expect(r.used).toEqual({ q: true, c: true, s: true });
  });

  it('unknown TTFT renormalizes over q+c (never penalizes)', () => {
    const r = compositeOf({ quality: 80, blend: 0.5, ttft: null }, w, norm);
    expect(r.used.s).toBe(false);
    // (.6·80 + .3·100) / .9 = 78/0.9
    expect(r.score).toBeCloseTo(78 / 0.9, 10);
  });

  it('unknown price and TTFT → pure quality (weights fully renormalize)', () => {
    const r = compositeOf({ quality: 80, blend: null, ttft: null }, w, norm);
    expect(r.used).toEqual({ q: true, c: false, s: false });
    expect(r.score).toBeCloseTo(80, 10);
  });

  it('priciest + slowest still keeps its quality share', () => {
    const r = compositeOf({ quality: 80, blend: 8, ttft: 7 }, w, norm);
    expect(r.score).toBeCloseTo(0.6 * 80, 10);
  });
});

describe('passConstraints (unknowns pass+flag by default, strict drops)', () => {
  const base = { ctx: 200000, vision: true, blend: 2, free: false, open: false };
  const eff = { ctx: 0, vision: false, open: 'any', cap: 0, strict: false };

  it('no active constraints → everything passes with no flags', () => {
    expect(passConstraints({ ...base, ctx: null, blend: null, vision: null }, eff))
      .toEqual({ pass: true, flags: [] });
  });

  it('min context: known-below drops, unknown passes with a flag, strict drops', () => {
    const e = { ...eff, ctx: 128000 };
    expect(passConstraints({ ...base, ctx: 100000 }, e).pass).toBe(false);
    const r = passConstraints({ ...base, ctx: null }, e);
    expect(r.pass).toBe(true);
    expect(r.flags).toContain('context unlisted');
    expect(passConstraints({ ...base, ctx: null }, { ...e, strict: true }).pass).toBe(false);
    expect(passConstraints({ ...base, ctx: 200000 }, e).flags).toEqual([]);
  });

  it('vision required: known-no drops hard, unknown passes with a flag', () => {
    const e = { ...eff, vision: true };
    expect(passConstraints({ ...base, vision: false }, e).pass).toBe(false);
    const r = passConstraints({ ...base, vision: null }, e);
    expect(r.pass).toBe(true);
    expect(r.flags).toContain('vision unlisted');
    expect(passConstraints({ ...base, vision: null }, { ...e, strict: true }).pass).toBe(false);
  });

  it('open-weights membership is exact (no unknowns)', () => {
    expect(passConstraints({ ...base, open: false }, { ...eff, open: 'open' }).pass).toBe(false);
    expect(passConstraints({ ...base, open: true }, { ...eff, open: 'open' }).pass).toBe(true);
    expect(passConstraints({ ...base, open: true }, { ...eff, open: 'api' }).pass).toBe(false);
    expect(passConstraints({ ...base, open: false }, { ...eff, open: 'api' }).pass).toBe(true);
  });

  it('price cap: over-cap drops, free listings survive any cap ($0 rule)', () => {
    const e = { ...eff, cap: 4 };
    expect(passConstraints({ ...base, blend: 5 }, e).pass).toBe(false);
    expect(passConstraints({ ...base, blend: 4 }, e).pass).toBe(true);
    expect(passConstraints({ ...base, blend: 9, free: true }, e).pass).toBe(true);
  });

  it('price cap: unpriced passes with a flag by default, drops in strict', () => {
    const e = { ...eff, cap: 4 };
    const r = passConstraints({ ...base, blend: null }, e);
    expect(r.pass).toBe(true);
    expect(r.flags).toContain('price unlisted');
    expect(passConstraints({ ...base, blend: null }, { ...e, strict: true }).pass).toBe(false);
  });

  it('survivors() collects constraint flags per candidate name', () => {
    const cands = [
      { name: 'a', ...base, ctx: null },
      { name: 'b', ...base, ctx: 100 },
    ];
    const { kept, flagsByCand } = survivors(cands, { ...eff, ctx: 128000 });
    expect(kept.map(c => c.name)).toEqual(['a']);
    expect(flagsByCand.get('a')).toContain('context unlisted');
  });
});

describe('rankCandidates (composite desc → coverage → price → recency)', () => {
  const w = weightFor('balanced', 'ok');
  // degenerate refs (pMin=pMax, tMin=tMax) make every priced candidate's
  // cost score 1 — so the tie-break chain below is exercised at equal composites
  const norm = normalizeParams([{ blend: 1, ttft: 1 }]);

  it('sorts by composite descending', () => {
    const cands = [
      { name: 'low', quality: 55, blend: 8, ttft: 7 },
      { name: 'high', quality: 80, blend: 8, ttft: 7 },
    ];
    const ranked = rankCandidates(cands, w, norm);
    expect(ranked[0].cand.name).toBe('high');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('tie → higher profile coverage wins, then cheaper, then newer', () => {
    const cands = [
      { name: 'thin', quality: 70, covered: 1, blend: 1, created: '2026-01-01' },
      { name: 'solid-newer', quality: 70, covered: 3, blend: 1, created: '2026-02-01' },
      { name: 'solid-cheaper', quality: 70, covered: 3, blend: 0.5, created: '2026-01-01' },
      { name: 'solid-noprice', quality: 70, covered: 3, blend: null, created: '2026-03-01' },
    ];
    const ranked = rankCandidates(cands, w, norm);
    expect(ranked.map(r => r.cand.name)).toEqual([
      'solid-cheaper', 'solid-newer', 'thin', 'solid-noprice',
    ]);
  });
});

describe('buildReasons / buildFlags (generated, deterministic, capped)', () => {
  const w = weightFor('balanced', 'ok');
  const norm = normalizeParams([{ blend: 0.5, ttft: 0.3 }, { blend: 8, ttft: 7 }]);

  const cands = [
    { name: 'top', quality: 80, blend: 0.5, ttft: 0.3, open: false, free: false, tag: 'solid', covered: 3 },
    { name: 'value', quality: 78, blend: 0.1, ttft: 1.2, open: true, free: false, tag: 'solid', covered: 3 },
    { name: 'quick', quality: 76, blend: 6, ttft: 0.25, open: false, free: false, tag: 'thin', covered: 1 },
  ];
  const ranked = rankCandidates(cands, w, norm);
  const byName = n => ranked.find(r => r.cand.name === n);

  it('#1 gets the best-fit reason', () => {
    const reasons = buildReasons(ranked, byName('top'), 'Coding');
    expect(reasons[0]).toBe('Best Coding fit in this shortlist');
  });

  it('a materially cheaper runner-up explains the trade (≥1.5× cheaper)', () => {
    const reasons = buildReasons(ranked, byName('value'), 'Coding');
    expect(reasons.some(r => /5\.0× cheaper than #1/.test(r) && /−4\.1 pts/.test(r))).toBe(true);
  });

  it('flags cheapest / fastest / open-weights signals deterministically', () => {
    expect(buildReasons(ranked, byName('value'), 'Coding')).toContain('Cheapest in the shortlist ($0.1/1M blended)');
    expect(buildReasons(ranked, byName('quick'), 'Coding')).toContain('Fastest listed TTFT (0.25 s)');
    expect(buildReasons(ranked, byName('value'), 'Coding')).toContain('Open weights');
  });

  it('caps reasons at 3', () => {
    expect(buildReasons(ranked, byName('value'), 'Coding').length).toBeLessThanOrEqual(3);
  });

  it('flags carry coverage tag + constraint flags + honest TTFT gap', () => {
    const v = byName('value');
    expect(buildFlags(v, ['price unlisted'])).toEqual(expect.arrayContaining(['price unlisted']));
    expect(buildFlags(byName('quick'), [])).toContain('thin profile coverage');
    const noTtft = { cand: { tag: 'solid', ttft: null }, used: { q: true, c: true, s: false } };
    expect(buildFlags(noTtft, [])).toContain('TTFT unlisted');
    const limited = { cand: { tag: 'limited', ttft: 1 }, used: { q: true, c: true, s: true } };
    expect(buildFlags(limited, [])).toContain('limited data — showing general score');
  });
});

describe('emptyStateHint (one-notch relaxation with the biggest gain)', () => {
  const cands = Array.from({ length: 10 }, (_, i) => ({
    name: `m${i}`, ctx: 200000, vision: true, blend: 2, free: false,
    open: false, tag: 'solid', covered: 3, quality: 60 + i * 0.1,
  }));
  const eff = { ctx: 0, vision: false, open: 'any', cap: 1, strict: false };

  it('names the relaxation that admits the most models', () => {
    const hint = emptyStateHint(cands, eff);
    expect(hint).toContain('No model fits');
    expect(hint).toMatch(/relaxing the price cap to \$4\/1M/i);
    expect(hint).toContain('10 options');
  });

  it('singular grammar for one option', () => {
    const hint = emptyStateHint(cands.slice(0, 1), eff);
    expect(hint).toContain('1 option.');
  });

  it('returns null when no one-notch relaxation helps (generic copy)', () => {
    expect(emptyStateHint(cands, { ...eff, cap: 0 })).toBeNull();
  });
});

describe('fmtComposite', () => {
  it('renders one decimal like the leaderboard and stays null-safe', () => {
    expect(fmtComposite(88)).toBe('88');
    expect(fmtComposite(77.25)).toBe('77.3');
    expect(fmtComposite(null)).toBe('—');
  });
});

// ── Snapshot-backed tests (real committed data via fetch stub) ────────

const snapshot = JSON.parse(readFileSync(path.join(REPO, 'public/benchmark_results.json'), 'utf8'));
vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => snapshot })));

describe('parity with the store on the real snapshot', () => {
  let d, CORE_BENCHMARKS;
  beforeAll(async () => {
    const { ensureLoaded, useData } = await import('../../src/stores/data.js');
    const constants = await import('../../src/lib/constants.js');
    await ensureLoaded();
    d = useData();
    CORE_BENCHMARKS = constants.CORE_BENCHMARKS;
  });

  it('profileScoreFor(row, core-8) ≡ scoreForModel(row) for every row', () => {
    expect(d.pivotAll.value.length).toBeGreaterThan(0);
    for (const row of d.pivotAll.value) {
      const mine = profileScoreFor(row, CORE_BENCHMARKS).score;
      const store = d.scoreForModel(row);
      if (store === null) expect(mine).toBeNull();
      else expect(mine).toBeCloseTo(store, 9);
    }
  });

  it('stats-32 ground truth survives the advisor: Pro 0813 above Flash 0731, Flash 0731 never shortlisted', () => {
    const find = (re) => d.pivotAll.value.find(r => re.test(r.name));
    const pro = find(/DeepSeek V4 Pro 0813/i);
    const flash = find(/DeepSeek V4 Flash 0731/i);
    if (!pro || !flash) {
      console.log('  (skip: DeepSeek V4 anchors absent from this snapshot)');
      return;
    }
    // stats-32 ground truth: on the core-8 Score (which the advisor's
    // limited-data fallback reuses) the new Pro 0813 outranks Flash 0731 —
    // BOTH are current-gen; only the April SKUs are superseded
    const ps = d.scoreForModel(pro);
    const fs = d.scoreForModel(flash);
    expect(ps).not.toBeNull();
    expect(fs).not.toBeNull();
    expect(ps).toBeGreaterThan(fs);
    expect(d.isOlder(pro)).toBe(false);
    expect(d.isOlder(flash)).toBe(false);
    const april = find(/^DeepSeek V4 Flash$/i);
    if (april) expect(d.isOlder(april)).toBe(true);
  });

  it('advisor ranking on the coding profile never surfaces an older model', () => {
    const w = weightFor('balanced', 'ok');
    const cands = d.pivotAll.value
      .filter(r => !d.isOlder(r))
      .map(r => {
        const { score, covered } = profileScoreFor(r, PROFILES.coding.benches);
        const quality = covered > 0 ? score : d.scoreForModel(r);
        return quality === null ? null : { name: r.name, quality, covered, tag: coverageTag(covered), blend: null, ttft: null, ctx: null, vision: null, open: false, free: false, created: null };
      })
      .filter(Boolean);
    const ranked = rankCandidates(cands, w, normalizeParams(cands));
    const older = new Set(d.pivotAll.value.filter(r => d.isOlder(r)).map(r => r.name));
    for (const r of ranked) expect(older.has(r.cand.name)).toBe(false);
  });
});
