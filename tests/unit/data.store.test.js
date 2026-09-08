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

describe('LLM Chess cells (non-core, curated aliases)', () => {
  it('cells exist for 30+ unified rows and stay within the 0-100 rescale', () => {
    const withChess = d.pivotAll.value.filter(r => r['LLM Chess'] != null);
    expect(withChess.length).toBeGreaterThanOrEqual(30);
    for (const r of withChess) {
      expect(r['LLM Chess'], `"${r.name}" chess cell`).toBeGreaterThanOrEqual(0);
      expect(r['LLM Chess'], `"${r.name}" chess cell`).toBeLessThanOrEqual(100);
    }
  });

  it('rescale anchors: top model ~100, floor model < 15', () => {
    const top = [...d.pivotAll.value]
      .filter(r => r['LLM Chess'] != null)
      .sort((a, b) => b['LLM Chess'] - a['LLM Chess'])[0];
    expect(top['LLM Chess']).toBeGreaterThan(99);   // gpt-5.6-sol-xhigh 1549.7 raw
    const floor = rowOf('DeepSeek V3');
    if (floor) expect(floor['LLM Chess']).toBeLessThan(15); // -579 raw (keep-best over -823)
  });

  it('curated alias targets carry cells', () => {
    for (const name of ['Claude Opus 4.5', 'Claude Opus 4.7', 'Claude Opus 4.8',
      'Claude Sonnet 4.6', 'Claude Haiku 4.5', 'Claude 4.1 Opus',
      'grok 3 mini', 'grok 4 fast chat', 'Llama 4 Maverick', 'Llama 4 Scout',
      'llama 3.3 70b instruct', 'GLM-5', 'Kimi K2.5', 'Grok 4.6']) {
      const r = rowOf(name);
      if (!r) continue; // absent from snapshot
      expect(r['LLM Chess'], `chess cell of "${name}"`).not.toBeNull();
    }
  });

  it('collision traps: no chess cell leaked onto the wrong rows', () => {
    // qwen3.8-27b local quants are a DIFFERENT model than Qwen3.8-Max
    expect(rowOf('Qwen3.8-Max')?.['LLM Chess'] ?? null).toBeNull();
    // glm-4.7-flash != GLM-4.7
    expect(rowOf('GLM-4.7')?.['LLM Chess'] ?? null).toBeNull();
    // standard-tier gpt-5.x entries must not feed the Pro rows
    for (const name of ['GPT-5.5 Pro', 'GPT-5.4 Pro', 'GPT-5 Pro', 'GPT-5.2-Codex']) {
      const r = rowOf(name);
      if (!r) continue;
      expect(r['LLM Chess'], `chess cell of "${name}"`).toBeNull();
    }
  });

  it('chess never feeds the default Score (non-core parity holds)', () => {
    for (const r of d.pivotAll.value) {
      const legacy = legacyScore(r);
      if (legacy === -1) continue;
      // models whose ONLY non-core difference is chess must still match
      expect(d.scoreForModel(r)).toBeCloseTo(legacy, 6);
    }
  });
});

describe('pricing layer (price column from models_meta.pricing_usd_per_1m)', () => {
  it('most catalog-matched models carry a price', () => {
    const priced = d.pivotAll.value.filter(r => d.priceFor(r));
    expect(priced.length).toBeGreaterThan(70);
  });

  it('blend is the 3:1 input:output mean of the row\u2019s own prices', () => {
    const any = d.pivotAll.value.find(r => {
      const p = d.priceFor(r);
      return p && p.output !== null;
    });
    expect(any).toBeTruthy();
    const p = d.priceFor(any);
    expect(p.blend).toBeCloseTo((3 * p.input + p.output) / 4, 10);
  });

  it('every priced row records its source — aa (AA list price) or openrouter', () => {
    let aa = 0, or = 0;
    for (const r of d.pivotAll.value) {
      const p = d.priceFor(r);
      if (!p) continue;
      expect(['aa', 'openrouter']).toContain(p.source);
      if (p.source === 'aa') {
        aa++;
        // the aa branch must surface the AA record verbatim
        const rec = d.metaFor(r).pricing_aa_usd_per_1m;
        expect(p.input).toBe(rec.input);
      } else {
        or++;
        expect(d.metaFor(r).pricing_usd_per_1m).toBeTruthy();
      }
    }
    expect(aa).toBeGreaterThan(0); // stats-19: the AA layer is populated
  });

  it('anchor: Claude Opus 5 at its official $5 / $25 list price', () => {
    const p = d.priceFor(rowOf('Claude Opus 5'));
    expect(p).not.toBeNull();
    expect(p.input).toBe(5.0);
    expect(p.output).toBe(25.0);
  });

  it('rows without a catalog match resolve to null — never fabricated', () => {
    expect(d.priceFor({ name: 'definitely-not-a-model' })).toBeNull();
    const without = d.pivotAll.value.filter(r => !d.priceFor(r));
    expect(without.length).toBeGreaterThan(0); // small locals have no API price
  });

  it('every price is a sane USD-per-1M number (0..1000)', () => {
    for (const r of d.pivotAll.value) {
      const p = d.priceFor(r);
      if (!p) continue;
      expect(p.input).toBeGreaterThanOrEqual(0);
      expect(p.input).toBeLessThan(1000);
      if (p.output !== null) expect(p.output).toBeLessThan(1000);
    }
  });
});

describe('value lens (Score per 1M blended tokens)', () => {
  beforeAll(() => d.resetAvgSelection()); // value follows the current avg set — pin the default

  it('anchor: Claude Opus 5 = Score ÷ 10 (blend of $5 in / $25 out)', () => {
    const row = rowOf('Claude Opus 5');
    expect(row).toBeTruthy();
    const p = d.priceFor(row);
    expect(p.blend).toBeCloseTo(10, 10);
    expect(d.valueFor(row)).toBeCloseTo(d.scoreForModel(row) / 10, 10);
  });

  it('value is exactly Score ÷ blend for every priced, scored row', () => {
    let n = 0;
    for (const r of d.pivotAll.value) {
      const p = d.priceFor(r);
      const s = d.scoreForModel(r);
      if (!p || !p.blend || p.blend <= 0 || s === null) continue;
      expect(d.valueFor(r), `value of "${r.name}"`).toBeCloseTo(s / p.blend, 10);
      n++;
    }
    expect(n).toBeGreaterThan(80); // snapshot currently has 87 value rows
  });

  it('rows without a price or a score resolve to null — never fabricated', () => {
    expect(d.valueFor({ name: 'definitely-not-a-model' })).toBeNull();
    const noPrice = d.pivotAll.value.find(r => !d.priceFor(r));
    if (noPrice) expect(d.valueFor(noPrice)).toBeNull();
    const noScore = d.pivotAll.value.find(r => d.priceFor(r) && d.scoreForModel(r) === null);
    if (noScore) expect(d.valueFor(noScore)).toBeNull();
  });

  it('no Infinity, no zero-or-negative values (free-tier guard holds)', () => {
    for (const r of d.pivotAll.value) {
      const v = d.valueFor(r);
      if (v === null) continue;
      expect(Number.isFinite(v), `finite value for "${r.name}"`).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });

  it('cheap capable models beat expensive ones (DeepSeek V3 ≫ Claude Opus 5)', () => {
    const cheap = rowOf('DeepSeek V3');
    const dear = rowOf('Claude Opus 5');
    if (!cheap || !dear) return;
    expect(d.valueFor(cheap)).toBeGreaterThan(d.valueFor(dear) * 5);
  });

  it('value follows the avg-set selection (re-scores with it)', () => {
    const row = rowOf('Claude Opus 5');
    const before = d.valueFor(row);
    d.toggleAvgBench('EQBench CW');
    const after = d.valueFor(row);
    expect(after).not.toBeCloseTo(before, 9); // Score moved → value moved with it
    d.resetAvgSelection();
    expect(d.valueFor(row)).toBeCloseTo(before, 12);
  });
});

describe('curated meta aliases (renames / word-order variants)', () => {
  it('Claude Opus 4.5 pins to anthropic/claude-opus-4.5 at $5/$25', () => {
    // (stats-22 re-point: Claude 4.1 Opus aged off the leaderboards in the
    // 2026-09-08 refresh — Opus 4.5 carries the same assertions: curated pin,
    // real price, older-generation freshness chain)
    const row = rowOf('Claude Opus 4.5');
    expect(row).toBeTruthy();
    expect(d.metaFor(row)?.or_id).toBe('anthropic/claude-opus-4.5');
    const p = d.priceFor(row);
    expect(p.input).toBe(5.0);
    expect(p.output).toBe(25.0);
    // joins the Opus freshness chain like every other older generation
    expect(d.isOlder(row)).toBe(true);
  });

  it('Qwen3.8-Max survives the catalog rename to the 0902 revision', () => {
    const row = rowOf('Qwen3.8-Max');
    expect(row).toBeTruthy();
    expect(d.metaFor(row)?.or_id).toBe('qwen/qwen3.8-max-0902');
    expect(d.priceFor(row).input).toBe(2.0);
    expect(d.isOlder(row)).toBe(false); // current listing — stays visible
  });

  it('gemma 3 4b it pins to google/gemma-3-4b-it ($0.05 in)', () => {
    const row = rowOf('gemma 3 4b it');
    expect(row).toBeTruthy();
    expect(d.metaFor(row)?.or_id).toBe('google/gemma-3-4b-it');
    expect(d.priceFor(row).input).toBe(0.05);
  });

  it('alias rows absent from the catalog fall back to a dash (no fabrication)', () => {
    // META_NAME_ALIASES maps by exact catalog id; an id that vanishes from
    // the catalog must resolve to no meta at all, never to a stub.
    expect(d.metaFor({ name: 'definitely-not-a-model' })).toBeNull();
  });
});

describe('hugging face identity (open-weight repo links)', () => {
  it('catalog-sourced ids: DeepSeek V3 and GLM-5.3 carry their HF repos', () => {
    expect(d.metaFor(rowOf('DeepSeek V3'))?.hugging_face_id).toBe('deepseek-ai/DeepSeek-V3');
    expect(d.metaFor(rowOf('GLM-5.3'))?.hugging_face_id).toBe('zai-org/GLM-5.3');
  });

  it('closed models have no HF id — never guessed', () => {
    for (const name of ['Claude Opus 5', 'GPT-5.5 Pro', 'Gemini 3.1 Pro', 'Grok 4.6']) {
      expect(d.metaFor(rowOf(name))?.hugging_face_id ?? null).toBeNull();
    }
  });

  it('curated overrides fill open rows the catalog leaves empty (verified ids)', () => {
    expect(d.metaFor(rowOf('Granite 4.1 8B'))?.hugging_face_id).toBe('ibm-granite/granite-4.1-8b');
    expect(d.metaFor(rowOf('Mistral Large 3'))?.hugging_face_id).toBe('mistralai/Mistral-Large-3-675B-Instruct-2512');
    // the override stage also tops up safetensors param counts
    expect(d.metaFor(rowOf('Granite 4.1 8B'))?.total_params_b).toBe(8.8);
    expect(d.metaFor(rowOf('Granite 4.1 8B'))?.params_source).toBe('huggingface');
  });

  it('catalog-absent open models get a minimal meta record with their verified HF id', () => {
    // MiMo-V2-Flash never matched OpenRouter (or_id=None, no record existed
    // at all) — the override stage creates the record instead of skipping it
    const mimo = d.metaFor(rowOf('MiMo-V2-Flash'));
    expect(mimo?.hugging_face_id).toBe('XiaomiMiMo/MiMo-V2-Flash');
    expect(mimo?.total_params_b).toBeGreaterThan(0); // safetensors-backed
    expect(mimo?.or_id ?? null).toBeNull();
    // no OpenRouter price can be fabricated for a record the catalog never
    // matched — but stats-19's AA layer may attach a REAL mined list price
    expect(mimo?.pricing_usd_per_1m ?? null).toBeNull();
    const aa = d.priceFor(rowOf('MiMo-V2-Flash'));
    expect(aa?.source).toBe('aa'); // mined from Artificial Analysis, not guessed
    expect(aa?.input).toBe(0.1);
    expect(aa?.output).toBe(0.3);
    expect(d.hfUrlFor(rowOf('MiMo-V2-Flash'))).toBe('https://huggingface.co/XiaomiMiMo/MiMo-V2-Flash');
  });

  it('prefix-display pins: shortened row names keep their official full-name repo', () => {
    expect(d.metaFor(rowOf('K-EXAONE 2.0'))?.hugging_face_id).toBe('LGAI-EXAONE/K-EXAONE-2.0-750B-A37B');
    expect(d.metaFor(rowOf('Nemotron 3 Nano Omni 30B A3B'))?.hugging_face_id)
      .toBe('nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-BF16');
    // verified-absent stays honest: 401 + not in HF search => no link
    expect(d.metaFor(rowOf('MiMo-V2-Omni'))?.hugging_face_id ?? null).toBeNull();
  });

  it('every non-null HF id is a well-formed org/repo pair', () => {
    for (const [name, m] of Object.entries(META)) {
      const id = m.hugging_face_id;
      if (!id) continue;
      expect(id, name).toMatch(/^[A-Za-z0-9][A-Za-z0-9.\-]*\/[A-Za-z0-9][A-Za-z0-9.\-_]*$/);
    }
  });

  it('free variants persist on the record but never become a price', () => {
    // :free catalog twins are stored raw for the future per-provider
    // "free at which seller" feature — data only, nothing renders them
    const inkling = d.metaFor(rowOf('Inkling'));
    expect(inkling?.or_free_variants).toEqual(['thinkingmachines/inkling:free']);
    expect(d.priceFor(rowOf('Inkling'))).not.toBeNull(); // paid listing untouched
    for (const [name, m] of Object.entries(META)) {
      for (const fid of m.or_free_variants || []) {
        expect(fid.endsWith(':free'), `${name}: ${fid}`).toBe(true);
      }
    }
  });

  it('hfUrlFor builds the huggingface.co link; helpers null-safe', () => {
    expect(d.hfUrlFor(rowOf('DeepSeek V3'))).toBe('https://huggingface.co/deepseek-ai/DeepSeek-V3');
    expect(d.hfIdFor({ name: 'definitely-not-a-model' })).toBeNull();
    expect(d.hfUrlFor({ name: 'definitely-not-a-model' })).toBeNull();
  });
});

describe('availability ("available at" cross-seller layer)', () => {
  // anchors chosen from the committed snapshot — a data refresh that moves
  // these must be a conscious decision, not a silent match drift

  it('snapshot contract: every available_at entry is well-formed', () => {
    let withSellers = 0;
    let withFree = 0;
    for (const [name, m] of Object.entries(META)) {
      if (!m.available_at) continue;
      withSellers += 1;
      expect(Array.isArray(m.available_at), name).toBe(true);
      expect(m.available_at.length, `${name}: no empty lists — omit the field instead`).toBeGreaterThan(0);
      const slugs = new Set();
      for (const a of m.available_at) {
        expect(typeof a.p, `${name} entry slug`).toBe('string');
        expect(typeof a.n, `${name} entry name`).toBe('string');
        expect(slugs.has(a.p), `${name}: duplicate seller ${a.p}`).toBe(false);
        slugs.add(a.p);
        if (typeof a.in === 'number') expect(a.in, `${name}@${a.p}`).toBeGreaterThanOrEqual(0);
        if (a.free) withFree += 1;
      }
    }
    expect(withSellers).toBeGreaterThan(80); // baked matcher must keep its coverage
    expect(withFree).toBeGreaterThanOrEqual(8);
  });

  it('free listings: explicit flags only, and free never fabricates a price', () => {
    for (const [name, m] of Object.entries(META)) {
      for (const a of m.available_at || []) {
        if (a.free) {
          // free comes from an explicit listing: -free/:free suffix or an
          // OpenRouter :free twin — a priced row may carry both (paid tier +
          // separate free listing), but an unpriced free entry never invents 0s
          if (typeof a.in !== 'number') {
            expect(a.in ?? null, `${name}@${a.p}`).toBeNull();
          }
        }
      }
    }
  });

  it('anchor: deepseek v4 flash is free at OpenCode Zen and OrcaRouter', () => {
    const row = rowOf('deepseek v4 flash');
    const a = d.availableAtFor(row);
    const zen = a.find(x => x.p === 'opencode-zen');
    const orca = a.find(x => x.p === 'orcarouter');
    expect(zen?.free, 'zen free flag').toBe(true);
    expect(orca?.free, 'orcarouter free flag').toBe(true);
    expect(d.hasFreeListingFor(row)).toBe(true);
    expect(a[0].p).toBe('openrouter'); // reference router always sorts first
    expect(a.length).toBeGreaterThanOrEqual(10); // widely hosted model
  });

  it('anchor: OpenRouter :free twins surface as a free listing at OpenRouter', () => {
    // per-model free sellers from the committed snapshot (Hy3 is free at
    // OrcaRouter via its "-free" twin; the others via OpenRouter ":free" ids)
    const EXPECT = {
      'Inkling': ['openrouter'],
      'Nemotron 3 Ultra': ['openrouter'],
      'Hy3': ['orcarouter'],
    };
    for (const [name, sellers] of Object.entries(EXPECT)) {
      const row = rowOf(name);
      if (!row) continue;
      expect(d.hasFreeListingFor(row), name).toBe(true);
      const freeSlugs = d.availableAtFor(row).filter(a => a.free).map(a => a.p);
      for (const s of sellers) {
        expect(freeSlugs, `${name} free at ${s}`).toContain(s);
      }
    }
  });

  it('identity-only rows match by name route without fabricating sellers', () => {
    // MiMo-V2-Flash is absent from the OpenRouter catalog (no or_id) — the
    // name route may only attach exact normalized id matches it truly has
    const row = rowOf('MiMo-V2-Flash');
    const a = d.availableAtFor(row);
    expect(Array.isArray(a)).toBe(true);
    // verified absent from OpenRouter → never an OpenRouter entry
    for (const e of a) expect(e.p).not.toBe('openrouter');
    // anchor: exact normalized name match on a real catalog row (Novita),
    // not a fuzzy hop — a data refresh that moves this is a conscious change
    expect(a.map(e => e.p)).toContain('novita-ai');
  });

  it('filterPriceFor: free counts as $0, priced rows use the 3:1 blend, unpriced sink', () => {
    const flash = rowOf('deepseek v4 flash');
    expect(d.filterPriceFor(flash)).toBe(0); // free listing wins the slider
    const priced = d.pivotAll.value.find(r => !d.hasFreeListingFor(r) && d.priceFor(r));
    if (priced) expect(d.filterPriceFor(priced)).toBeCloseTo(d.priceFor(priced).blend, 10);
    const unpriced = d.pivotAll.value.find(r => !d.hasFreeListingFor(r) && !d.priceFor(r));
    if (unpriced) expect(d.filterPriceFor(unpriced)).toBeNull();
  });

  it('sellerCountFor + null-safe helpers', () => {
    expect(d.sellerCountFor(rowOf('deepseek v4 flash'))).toBeGreaterThanOrEqual(10);
    expect(d.availableAtFor({ name: 'definitely-not-a-model' })).toEqual([]);
    expect(d.hasFreeListingFor({ name: 'definitely-not-a-model' })).toBe(false);
    expect(d.sellerCountFor({ name: 'definitely-not-a-model' })).toBe(0);
    expect(d.filterPriceFor({ name: 'definitely-not-a-model' })).toBeNull();
  });
});
