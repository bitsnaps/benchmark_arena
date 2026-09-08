// Unit tests for src/lib/pivot.js — the models × providers matcher core.
// Pure-function tests on hand-built fixtures: no snapshot, no browser.
// Locks the matching discipline (org-strip normalization, variant ids stay
// separate, free twins attach to their base) and the Compare-tab filters.
import { describe, it, expect } from 'vitest';
import {
  normKey,
  buildMatrix,
  sortMatrixRows,
  cellBlend,
  rowBlend,
  cheapestPid,
  filterMatrix,
  latencyTier,
  latencyClass,
  ttftIndexFromMeta,
  isBatchId,
  isBatchRow,
  DEFAULT_COLUMNS,
} from '../../src/lib/pivot.js';

// ── fixture builders ──────────────────────────────────────────────────
// mkProv(id, models, extra) — models shaped like providers.json rows
const mkProv = (id, models, extra = {}) => ({ id, name: id, kind: 'aggregator', models, ...extra });

describe('normKey', () => {
  it('drops the org prefix, case and separators', () => {
    expect(normKey('deepseek/deepseek-v4-flash')).toBe('deepseekv4flash');
    expect(normKey('deepseek-ai/DeepSeek-V4-Flash')).toBe('deepseekv4flash');
    expect(normKey('anthropic/claude-fable-5.1')).toBe('claudefable51');
    expect(normKey('anthropic/claude-fable-5-1')).toBe('claudefable51');
  });

  it('keeps bare ids and dotted versions joinable', () => {
    expect(normKey('gpt-6')).toBe('gpt6');
    expect(normKey('GPT-6')).toBe('gpt6');
  });

  it('keeps pricing-variant suffixes separate (never folds variants)', () => {
    // ':batch' is a different offering with a different price — its suffix
    // glues onto the key so it can NOT join the base model
    expect(normKey('openai/gpt-6-astra:batch')).toBe('gpt6astrabatch');
    expect(normKey('openai/gpt-6-astra')).toBe('gpt6astra');
  });

  it('is null-safe', () => {
    expect(normKey(null)).toBe(null);
    expect(normKey('')).toBe(null);
    expect(normKey('///')).toBe(null);
  });
});

describe('buildMatrix', () => {
  const provs = [
    mkProv('openrouter', [
      { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek: DeepSeek V4 Flash', in: 0.08, out: 0.16, ctx: 128000 },
      { id: 'deepseek/deepseek-v4-flash:free', name: 'DeepSeek: DeepSeek V4 Flash (free)', in: 0, out: 0, free: true, base: 'deepseek/deepseek-v4-flash' },
      { id: 'openai/gpt-6', name: 'OpenAI: GPT-6', in: 2, out: 8 },
      { id: 'openai/gpt-6-astra', name: 'OpenAI: GPT-6 Astra', in: 1.5, out: 6 },
      { id: 'openai/gpt-6-astra:batch', name: 'OpenAI: GPT-6 Astra (batch)', in: 1, out: 4 },
      { id: 'nvidia/nemotron-3-ultra-free', name: 'Nemotron 3 Ultra (free)', free: true, base: 'nvidia/nemotron-3-ultra' },
    ]),
    mkProv('orcarouter', [
      { id: 'deepseek-ai/DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash', in: 0.07, out: 0.14, ctx: 131072 },
      { id: 'qwen/qwen3.8-27b-free', name: 'Qwen3.8 27B (free)', free: true, base: 'qwen/qwen3.8-27b' },
      { id: 'qwen/qwen3.8-27b', name: 'Qwen3.8 27B', in: 0.3, out: 1.2 },
    ]),
    mkProv('nvidia-nim', [
      { id: 'deepseek-ai/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: '01-ai/yi-large', name: 'Yi Large' },
    ], { free_tier: true }),
    mkProv('zen', [
      { id: 'mimo-v2.5', name: 'MiMo V2.5' },
      { id: 'mimo-v2.5-free', name: 'MiMo V2.5 (free)', free: true, base: 'mimo-v2.5' },
    ]),
  ];

  const build = (ids = ['openrouter', 'orcarouter', 'nvidia-nim', 'zen']) =>
    buildMatrix(provs, ids);

  it('joins the same model across sellers with different org/id conventions', () => {
    const { rows } = build();
    const r = rows.find((x) => x.key === 'deepseekv4flash');
    expect(r).toBeDefined();
    expect(Object.keys(r.cells).sort()).toEqual(['nvidia-nim', 'openrouter', 'orcarouter']);
    expect(r.name).toBe('DeepSeek: DeepSeek V4 Flash'); // vendor-style name preferred
    expect(r.firstId).toBe('deepseek/deepseek-v4-flash');
  });

  it('keeps the paid price intact when a free twin attaches to the same cell', () => {
    const { rows } = build();
    const cell = rows.find((x) => x.key === 'deepseekv4flash').cells.openrouter;
    expect(cell.in).toBe(0.08);
    expect(cell.out).toBe(0.16);
    expect(cell.free).toBe(true);
    expect(cell.freeBase).toBe('deepseek/deepseek-v4-flash:free');
  });

  it('creates free-only cells when no seller prices the base model, and merges\n       the free flag into the paid cell when one exists', () => {
    const { rows } = build();
    // nemotron twin: base unpriced anywhere → free-only cell, honest null price
    const r = rows.find((x) => x.key === 'nemotron3ultra');
    expect(Object.keys(r.cells)).toEqual(['openrouter']);
    const cell = r.cells.openrouter;
    expect(cell.free).toBe(true);
    expect(cell.in).toBe(null);
    expect(cell.listed).toBe(true);
    expect(cell.freeBase).toBe('nvidia/nemotron-3-ultra-free');
    // qwen twin: orcarouter also prices the base → one cell, price + free flag
    const qw = rows.find((x) => x.key === 'qwen3827b').cells.orcarouter;
    expect(qw.in).toBe(0.3);
    expect(qw.out).toBe(1.2);
    expect(qw.free).toBe(true);
    expect(qw.freeBase).toBe('qwen/qwen3.8-27b-free');
    expect(rows.find((x) => x.key === 'qwen3827b').cells.openrouter).toBeUndefined();
  });

  it('marks provider-level free tiers (NVIDIA NIM) without fabricating prices', () => {
    const { rows } = build();
    const cell = rows.find((x) => x.key === 'deepseekv4flash').cells['nvidia-nim'];
    expect(cell.free).toBe(true);
    expect(cell.in).toBe(null);
    expect(cell.listed).toBe(true);
  });

  it('keeps variant ids (e.g. :batch) as their own rows', () => {
    const { rows } = build();
    const batch = rows.find((x) => x.key === 'gpt6astrabatch');
    const base = rows.find((x) => x.key === 'gpt6astra');
    expect(batch).toBeDefined();
    expect(base).toBeDefined();
    expect(batch.cells.openrouter.in).toBe(1);
    expect(base.cells.openrouter.in).toBe(1.5);
  });

  it('counts intra-provider collapsed duplicates in coverage', () => {
    const dupeProvs = [
      mkProv('a', [
        { id: 'org/model-x', in: 1, out: 2 },
        { id: 'ORG/MODEL-X', in: 3, out: 6 }, // same normalized key, same seller
      ]),
    ];
    const { rows, coverage } = buildMatrix(dupeProvs, ['a']);
    expect(coverage.collapsed).toBe(1);
    const cell = rows.find((r) => r.key === 'modelx').cells.a;
    expect(cell.in).toBe(1); // first priced row wins, dupes never silently mixed
  });

  it('reports coverage honestly', () => {
    const { coverage } = build();
    expect(coverage.sellers).toBe(4);
    // deepseekv4flash, gpt6, gpt6astra, gpt6astrabatch, nemotron3ultra,
    // qwen3827b, mimov25, yilarge
    expect(coverage.models).toBe(8);
    expect(coverage.cells).toBe(10);
  });

  it('ignores unselected sellers entirely', () => {
    const { rows, coverage } = buildMatrix(provs, ['openrouter']);
    expect(coverage.sellers).toBe(1);
    const r = rows.find((x) => x.key === 'deepseekv4flash');
    expect(Object.keys(r.cells)).toEqual(['openrouter']);
  });
});

describe('row ordering + price helpers', () => {
  const rows = buildMatrix([
    mkProv('a', [{ id: 'x/m1', name: 'M1', in: 4, out: 8 }, { id: 'x/m2', name: 'M2', in: 1, out: 2 }]),
    mkProv('b', [{ id: 'y/m1', name: 'M1', in: 2, out: 4 }]),
    mkProv('c', [{ id: 'z/m1-free', name: 'M1 free', free: true, base: 'z/m1' }]),
  ], ['a', 'b', 'c']).rows;

  it('sorts by seller coverage desc, then name', () => {
    const sorted = sortMatrixRows(rows);
    expect(sorted[0].key).toBe('m1'); // 3 sellers
    expect(sorted.map((r) => r.key).slice(1)).toEqual(['m2']); // alphabetical tail
  });

  it('blends free cells to 0 and unpriced cells to null (never fabricated)', () => {
    const m1 = rows.find((r) => r.key === 'm1');
    expect(cellBlend(m1.cells.a)).toBe((3 * 4 + 8) / 4);
    expect(cellBlend(m1.cells.c)).toBe(0);
    expect(cellBlend(null)).toBe(null);
  });

  it('finds the cheapest seller per row — free wins, ties keep first column', () => {
    const m1 = rows.find((r) => r.key === 'm1');
    expect(cheapestPid(m1)).toBe('c');
    const m2 = rows.find((r) => r.key === 'm2');
    expect(cheapestPid(m2)).toBe('a');
    expect(rowBlend(m1)).toBe(0);
  });
});

describe('filterMatrix (composable Compare-tab filters)', () => {
  const rows = buildMatrix([
    mkProv('a', [
      { id: 'x/paid', name: 'Paid Model', in: 4, out: 8 },
      { id: 'x/cheap', name: 'Cheap Model', in: 0.1, out: 0.2 },
      { id: 'x/ghost', name: 'Ghost Model' }, // listed, no price at all
    ]),
    mkProv('b', [
      { id: 'y/paid-free', name: 'Paid Model (free)', free: true, base: 'y/paid' },
    ]),
  ], ['a', 'b']).rows;

  it('searches names and seller ids', () => {
    expect(filterMatrix(rows, { q: 'cheap' }).map((r) => r.key)).toEqual(['cheap']);
    expect(filterMatrix(rows, { q: 'y/paid' }).map((r) => r.key)).toEqual(['paid']);
  });

  it('freeOnly keeps rows with a free cell in any selected seller', () => {
    const got = filterMatrix(rows, { freeOnly: true }).map((r) => r.key);
    expect(got).toEqual(['paid']);
  });

  it('maxPrice caps the cheapest blend; free rows survive any cap', () => {
    // 'paid' keeps a $5 blend on seller a but carries a free twin on b (blend 0)
    // → it survives every cap; 'cheap' ($0.125 blend) survives anything ≥ 0.125
    expect(filterMatrix(rows, { maxPrice: 5 }).map((r) => r.key)).toEqual(['paid', 'cheap']);
    expect(filterMatrix(rows, { maxPrice: 0.5 }).map((r) => r.key)).toEqual(['paid', 'cheap']);
    // free twin blends to 0 → 'paid' survives even a $0 cap
    expect(filterMatrix(rows, { maxPrice: 0 }).map((r) => r.key)).toEqual(['paid']);
  });

  it('hides unpriced rows only while a price cap is active', () => {
    expect(filterMatrix(rows, {}).map((r) => r.key)).toContain('ghost');
    expect(filterMatrix(rows, { maxPrice: 100 }).map((r) => r.key)).not.toContain('ghost');
  });

  it('composes all three filters', () => {
    expect(filterMatrix(rows, { q: 'paid', freeOnly: true, maxPrice: 10 }).map((r) => r.key))
      .toEqual(['paid']);
  });
});

describe('latency ladder (AA median TTFT feeds it since stats-24)', () => {
  it('tiers seconds honestly', () => {
    expect(latencyTier(null)).toBe(null);
    expect(latencyTier(undefined)).toBe(null);
    expect(latencyTier(NaN)).toBe(null);
    expect(latencyTier(0.4)).toBe('fast');
    expect(latencyTier(1.49)).toBe('fast');
    expect(latencyTier(1.5)).toBe('ok');
    expect(latencyTier(3.4)).toBe('ok');
    expect(latencyTier(3.5)).toBe('slow');
  });

  it('maps to CSS classes, empty string when unknown', () => {
    expect(latencyClass(0.4)).toBe('lat-fast');
    expect(latencyClass(2)).toBe('lat-ok');
    expect(latencyClass(9)).toBe('lat-slow');
    expect(latencyClass(null)).toBe('');
  });
});

describe('TTFT join — AA median latency into matrix cells (stats-24)', () => {
  const meta = {
    'Claude Fable 5.1': { or_id: 'anthropic/claude-fable-5.1', aa_ttft_seconds: 6.548 },
    'GPT-5.6 Terra': { or_id: 'openai/gpt-5.6-terra', aa_ttft_seconds: 1.629 },
    'No-lat Model': { or_id: 'vendor/no-lat' },   // mined record without a TTFT value
    'Bad-lat Model': { aa_ttft_seconds: 'oops' }, // malformed value must be skipped
  };

  it('indexes by normalized or_id and name, skipping unmeasured/malformed records', () => {
    const idx = ttftIndexFromMeta(meta);
    expect(idx.get('claudefable51')).toBe(6.548);
    expect(idx.get('gpt56terra')).toBe(1.629);
    expect(idx.has('nolatmodel')).toBe(false);
    expect(idx.has('badlatmodel')).toBe(false);
  });

  it('is tolerant of null/undefined meta (buildMatrix 2-arg calls unchanged)', () => {
    expect(ttftIndexFromMeta(null).size).toBe(0);
    expect(ttftIndexFromMeta(undefined).size).toBe(0);
    const { rows } = buildMatrix(
      [mkProv('p1', [{ id: 'a/m1', name: 'M1', in: 1, out: 2 }])],
      ['p1'],
    );
    expect(rows[0].cells.p1.latency).toBe(null);
  });

  it('stamps every cell of a matched row — variant ids (dash vs dot) join too', () => {
    const provs = [
      mkProv('p1', [{ id: 'anthropic/claude-fable-5.1', name: 'OpenRouter: Claude Fable 5.1', in: 10, out: 50 }]),
      mkProv('p2', [{ id: 'anthropic/claude-fable-5-1', name: 'Anthropic: Claude Fable 5.1', in: 12, out: 60 }]),
      mkProv('p3', [{ id: 'vendor/unmeasured', name: 'Unmeasured Model', in: 1, out: 2 }]),
    ];
    const { rows } = buildMatrix(provs, ['p1', 'p2', 'p3'], meta);
    const fable = rows.find(r => r.key === 'claudefable51');
    expect(fable.latency).toBe(6.548);
    expect(fable.cells.p1.latency).toBe(6.548);
    expect(fable.cells.p2.latency).toBe(6.548);
    const other = rows.find(r => r.key === 'unmeasured');
    expect(other.cells.p3.latency).toBe(null);
  });
});

describe('DEFAULT_COLUMNS', () => {
  it('targets the four keyless API catalogs plus major priced hosts', () => {
    expect(DEFAULT_COLUMNS).toEqual([
      'openrouter', 'orcarouter', 'opencode-zen', 'nvidia-nim',
      'fireworks-ai', 'deepinfra', 'together-ai', 'groq',
    ]);
  });
});

describe('batch pricing-variant detection (stats-19 toggle)', () => {
  it('flags only :batch-suffixed ids', () => {
    expect(isBatchId('openai/gpt-5:batch')).toBe(true);
    expect(isBatchId('GPT-5:batch')).toBe(true);
    expect(isBatchId('openai/gpt-5')).toBe(false);
    expect(isBatchId('')).toBe(false);
    expect(isBatchId(null)).toBe(false);
  });

  it('never flags real model names that merely end in similar words', () => {
    // '-beta'/'-online' are part of genuine model names, NOT pricing modes
    expect(isBatchId('x-ai/grok-3-beta')).toBe(false);
    expect(isBatchId('perplexity/sonar-small-online')).toBe(false);
  });

  it('catalog rows are batch rows when their id is a batch id', () => {
    expect(isBatchRow({ id: 'openai/gpt-5:batch', name: 'GPT-5 batch' })).toBe(true);
    expect(isBatchRow({ id: 'openai/gpt-5', name: 'GPT-5' })).toBe(false);
  });

  it('pivot rows are batch rows only when EVERY joined id is a batch id', () => {
    expect(isBatchRow({ ids: ['openai/gpt-5:batch'], name: null })).toBe(true);
    expect(isBatchRow({ ids: ['openai/gpt-5', 'openai/gpt-5:batch'], name: null })).toBe(false);
  });

  it('falls back to the (batch) display-name marker when no ids exist', () => {
    expect(isBatchRow({ name: 'GPT-5 (batch)' })).toBe(true);
    expect(isBatchRow({ name: 'GPT-5' })).toBe(false);
    expect(isBatchRow(null)).toBe(false);
    expect(isBatchRow({})).toBe(false);
  });
});
