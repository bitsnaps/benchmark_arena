// Unit tests for src/stores/data.js — the freshness/ranking core.
// Runs in plain node (vitest): fetch is stubbed to serve the real committed
// snapshot, so store logic is exercised end-to-end without a browser.
// These tests fail fast when the data pipeline or the store drift apart.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const snapshot = JSON.parse(readFileSync(path.join(REPO, 'public/benchmark_results.json'), 'utf8'));

// stub fetch BEFORE importing the store (it fetches lazily on ensureLoaded)
vi.stubGlobal('fetch', vi.fn(async () => ({
  ok: true,
  json: async () => snapshot,
})));

const { ensureLoaded, useData } = await import('../../src/stores/data.js');
const { AVG_PRESETS } = await import('../../src/lib/constants.js');
const MIRROR_MOD = await import('../helpers/snapshot.mjs');
const MIRROR = MIRROR_MOD.makeMirror(snapshot);
const { META, current, byAvg, byScore } = MIRROR;
const MIRROR_CORE = MIRROR_MOD.CORE_BENCHMARKS;
const legacyScore = MIRROR_MOD.scoreForModel; // independent legacy formula

let d;
beforeAll(async () => {
  await ensureLoaded();
  d = useData();
});
const rowOf = (name) => d.pivotAll.value.find(r => r.name === name);

describe('snapshot contract (what the store consumes)', () => {
  it('loads the committed snapshot via fetch', () => {
    expect(d.loading.value).toBe(false);
    expect(d.error.value).toBeNull();
    expect(d.rawData.value).toBeTruthy();
  });

  it('every superseded_by successor resolves to a real row', () => {
    const names = new Set(d.pivotAll.value.map(r => r.name));
    for (const [name, meta] of Object.entries(META)) {
      if (meta.superseded_by) {
        expect(names, `successor of "${name}"`).toContain(meta.superseded_by);
      }
    }
  });

  it('CL tag stays consistent with num_benchmarks (cl = nb * 12.5)', () => {
    for (const r of d.pivotAll.value) {
      expect(r.cl, `"${r.name}" cl`).toBe(r.num_benchmarks * 12.5);
    }
  });
});

describe('freshness filtering (older models hidden by default)', () => {
  it('isOlder flags exactly the superseded + stale set', () => {
    const flagged = d.pivotAll.value.filter(r => d.isOlder(r));
    expect(flagged.length).toBe(MIRROR.olderRows().length);
    expect(flagged.length).toBeGreaterThan(0);
  });

  it('default top ranking contains no older model, for every tier', () => {
    for (const [tier, top] of [['all', d.topOverall], ['closed', d.topClosed], ['open', d.topOpen]]) {
      const list = tier === 'closed' ? d.pivotClosed.value : tier === 'open' ? d.pivotOpen.value : d.pivotAll.value;
      const expected = [...current(list)].sort(byScore)[0]?.name ?? null;
      expect(top.value?.name, `${tier} #1`).toBe(expected);
      expect(d.isOlder(top.value), `${tier} #1 must be current`).toBe(false);
    }
  });

  it('rankMaps never assigns a rank to an older model', () => {
    for (const tier of ['all', 'closed', 'open']) {
      const map = d.rankMaps.value[tier];
      for (const [name] of map) {
        expect(d.isOlder(rowOf(name)), `"${name}" ranked in ${tier}`).toBe(false);
      }
    }
  });

  it('nothing is deleted: older models remain in the pivot data', () => {
    // user ruling: "I agree to not delete any data" — hidden, not removed
    const older = MIRROR.olderRows();
    expect(older.length).toBeGreaterThan(0);
    for (const r of older) {
      expect(d.pivotAll.value.map(x => x.name)).toContain(r.name);
    }
  });

  it('REGRESSION: 2026-09 visible-old-model bug stays fixed', () => {
    for (const name of ['gpt 5.5 instant', 'grok 4 fast chat', 'Phi-4 Multimodal', 'Mistral']) {
      const row = rowOf(name);
      if (!row) continue; // absent from snapshot → nothing to assert
      expect(d.isOlder(row), `"${name}" must be flagged older`).toBe(true);
      expect(d.rankMaps.value.all.has(name), `"${name}" must carry no rank`).toBe(false);
      expect(d.topOverall.value.name, 'top overall').not.toBe(name);
    }
  });

  it('RED LINE: Pro/Flash/Lite product lines never hide each other', () => {
    for (const name of ['Gemini 3.1 Pro', 'Gemini 3.8 Flash', 'Gemini 3.5 Flash-Lite']) {
      const row = rowOf(name);
      if (!row) continue;
      expect(d.isOlder(row), `"${name}" must stay visible`).toBe(false);
    }
  });
});

describe('model metadata joins', () => {
  it('supersededBy returns the successor name for overridden pairs', () => {
    const row = rowOf('gemini 3 pro');
    if (!row) return;
    expect(d.supersededBy(row)).toBe('Gemini 3.1 Pro');
  });

  it('releaseDateOf serves ISO dates where meta exists', () => {
    const row = rowOf('Gemini 3.8 Flash');
    if (!row) return;
    expect(d.releaseDateOf(row)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('CL-weighted global score (selection-bias fix, 2026-09)', () => {
  // score = w*rawAvg + (1-w)*50, w = cl/100 — full coverage keeps the raw avg
  it('full-coverage models keep their raw average', () => {
    for (const r of d.pivotAll.value) {
      if ((r.cl ?? 0) === 100 && d.avgForModel(r) !== null) {
        expect(d.scoreForModel(r)).toBeCloseTo(d.avgForModel(r), 6);
      }
    }
  });

  it('partial-coverage models are pulled toward the neutral 50 baseline', () => {
    for (const r of d.pivotAll.value) {
      const raw = d.avgForModel(r);
      if (raw === null || !r.cl) continue;
      if ((r.cl ?? 0) >= 100) continue; // full coverage: score === raw (covered above)
      if (raw > 50) expect(d.scoreForModel(r)).toBeLessThan(raw);
      if (raw < 50) expect(d.scoreForModel(r)).toBeGreaterThan(raw);
    }
  });

  it('rank order matches the weighted metric, not the raw sparse avg', () => {
    const expected = [...current(d.pivotAll.value)].sort(byScore).map(r => r.name);
    const ranked = [...d.rankMaps.value.all.keys()];
    expect(ranked).toEqual(expected);
  });

  it('REGRESSION: GLM-5.3-Flash no longer outranks GLM-5.3 / Kimi K3', () => {
    const flash = d.rankMaps.value.all.get('GLM-5.3-Flash');
    const full = d.rankMaps.value.all.get('GLM-5.3');
    const kimi = d.rankMaps.value.all.get('Kimi K3');
    if (flash == null || full == null) return; // absent from snapshot
    expect(flash, 'GLM-5.3-Flash must rank below GLM-5.3').toBeGreaterThan(full);
    if (kimi == null) return;
    expect(flash, 'GLM-5.3-Flash must rank below Kimi K3').toBeGreaterThan(kimi);
  });

  it('REGRESSION: BenchLM.ai column is populated for the board leaders', () => {
    // scraper drift (org-name rows) left this column almost empty once
    for (const name of ['Kimi K3', 'GLM-5.3', 'GLM-5.3-Flash']) {
      const row = rowOf(name);
      if (!row) continue;
      expect(row['BenchLM.ai'], `BenchLM.ai score of "${name}"`).not.toBeNull();
    }
  });
});

describe('user-selectable average (commit B)', () => {
  it('PARITY: default selection reproduces the shipped cl + legacy score exactly', () => {
    // Run FIRST in this describe — later tests mutate the selection.
    for (const r of d.pivotAll.value) {
      expect(d.clForModel(r), `client CL of "${r.name}"`).toBe(r.cl ?? 0);
      const legacy = legacyScore(r); // -1 = no scores in the core set
      if (legacy === -1) expect(d.scoreForModel(r)).toBeNull();
      else expect(d.scoreForModel(r), `score of "${r.name}"`).toBeCloseTo(legacy, 6);
    }
    expect(d.isCustomAvg.value).toBe(false);
  });

  it('adding EQBench CW to the avg set re-scores; reset restores', () => {
    const withEqb = d.pivotAll.value.find(r => r['EQBench CW'] != null);
    if (!withEqb) return; // snapshot without EQB cells → nothing to assert
    const scoreBefore = d.scoreForModel(withEqb);
    d.toggleAvgBench('EQBench CW'); // opt-in via checkbox — no dedicated preset on purpose
    expect(d.isCustomAvg.value).toBe(true);
    expect(d.coreBenchmarks.value).toContain('EQBench CW');
    expect(d.coreBenchmarks.value.length).toBe(MIRROR_CORE.length + 1);
    // coverage now spreads over 9 benches → CL and Score must move
    expect(d.clForModel(withEqb)).not.toBe(withEqb.cl);
    expect(d.scoreForModel(withEqb)).not.toBe(scoreBefore);
    d.resetAvgSelection();
    expect(d.isCustomAvg.value).toBe(false);
    expect(d.clForModel(withEqb)).toBe(withEqb.cl);
    expect(d.scoreForModel(withEqb)).toBeCloseTo(scoreBefore, 12);
  });

  it('presets list only ships Default and All (no per-benchmark presets)', () => {
    expect(AVG_PRESETS.map(p => p.id).sort()).toEqual(['all', 'default']);
  });

  it('custom selection averages only the picked benchmarks (cl recomputed)', () => {
    const r = d.pivotAll.value.find(x => x['EQBench CW'] != null);
    if (!r) return;
    d.setAvgSelection(['EQBench CW']);
    expect(d.avgForModel(r)).toBe(r['EQBench CW']);
    expect(d.clForModel(r)).toBe(100);
    expect(d.scoreForModel(r)).toBe(r['EQBench CW']); // full coverage keeps the raw avg
    // 2-bench mix: sparse mean + proportional CL blend
    d.setAvgSelection(['Artificial Analysis', 'EQBench CW']);
    const vals = [r['Artificial Analysis'], r['EQBench CW']].filter(v => v != null);
    const raw = vals.reduce((a, b) => a + b, 0) / vals.length;
    expect(d.avgForModel(r)).toBeCloseTo(raw, 12);
    const w = vals.length / 2; // CL = covered/selected
    expect(d.scoreForModel(r)).toBeCloseTo(w * raw + (1 - w) * 50, 12);
    d.resetAvgSelection();
  });

  it('≥1 selection guard: the last selected benchmark can never be removed', () => {
    d.setAvgSelection(['Artificial Analysis']);
    expect(d.coreBenchmarks.value).toEqual(['Artificial Analysis']);
    d.toggleAvgBench('Artificial Analysis'); // refused
    expect(d.coreBenchmarks.value).toEqual(['Artificial Analysis']);
    d.toggleAvgBench('Arena.ai Text'); // adding still works
    expect(d.coreBenchmarks.value.length).toBe(2);
    d.resetAvgSelection();
  });

  it('empty/garbage selections fall back to the shipped default', () => {
    d.setAvgSelection(['EQBench CW']);
    d.setAvgSelection([]);
    expect(d.avgSelection.value).toBeNull();
    expect(d.isCustomAvg.value).toBe(false);
    expect(d.coreBenchmarks.value.length).toBe(MIRROR_CORE.length);
    d.setAvgSelection(['Not A Real Bench', 'Artificial Analysis']);
    expect(d.coreBenchmarks.value).toEqual(['Artificial Analysis']); // unknown names drop out
    d.resetAvgSelection();
  });

  it('?avg= deep link resolves bench slugs and ignores garbage params', () => {
    expect(d.applyAvgParam('eqbench-cw')).toBe(true);
    expect(d.coreBenchmarks.value).toEqual(['EQBench CW']);
    expect(d.applyAvgParam('nonsense-slugg')).toBe(false); // state untouched
    expect(d.coreBenchmarks.value).toEqual(['EQBench CW']);
    expect(d.applyAvgParam('')).toBe(false);
    d.resetAvgSelection();
  });

  it('picking exactly the default set is NOT custom (no badge, no ?avg=)', () => {
    const def = MIRROR_CORE;
    d.setAvgSelection(def);
    expect(d.isCustomAvg.value).toBe(false);
    expect(d.avgPresetId.value).toBe('default');
    d.resetAvgSelection();
  });
});
