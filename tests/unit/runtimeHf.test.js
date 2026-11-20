// stats-94 unit tests: the runtime HF lane ("add any Hugging Face model").
// Layers under test:
//   1. src/lib/runtimeHf.js — input normalization, row/meta builders, the
//      add/remove contract (quant guard, board-collision guard, dedupe,
//      storage roundtrip, HF fetch mapping incl. failure modes)
//   2. stores/data.js merge — runtime entries become census rows appended
//      AFTER the baked card_models section, never touch the ranked universe,
//      resolve slugs + meta, and DROP OUT when a baked row owns the name.
//
// The snapshot fetch stub is the same pattern as cardRows.test.js / data
// .store.test.js; the HF API is mocked per-URL; localStorage is a fake.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const snapshot = JSON.parse(readFileSync(path.join(REPO, 'public/benchmark_results.json'), 'utf8'));

// ── fake localStorage (node env — no window) ──────────────────────────────
const lsStore = new Map();
const fakeStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => { lsStore.set(k, String(v)); },
  removeItem: (k) => { lsStore.delete(k); },
};
vi.stubGlobal('window', { localStorage: fakeStorage });

// ── fetch stub: HF API mock + snapshot for the data store ─────────────────
const HF_PAYLOAD = {
  createdAt: '2026-11-01T10:20:30.000Z',
  downloads: 12340,
  likes: 56,
  pipeline_tag: 'text-generation',
  safetensors: { total: 27300000000 },
};
const fetchMock = vi.fn(async (url) => {
  const u = String(url);
  if (u.includes('huggingface.co/api/models/')) {
    if (u.includes('bad-org/dead-repo')) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (u.includes('rate-limited-org/busy-repo')) {
      return { ok: false, status: 429, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => HF_PAYLOAD };
  }
  // the data store's snapshot fetch (benchmark_results.json)
  return { ok: true, status: 200, json: async () => snapshot };
});
vi.stubGlobal('fetch', fetchMock);

const runtimeHf = await import('../../src/lib/runtimeHf.js');

beforeEach(() => {
  lsStore.clear();
  runtimeHf.__resetRuntimeHfForTests();
  fetchMock.mockClear();
});

describe('stats-94: normalizeHfInput', () => {
  it('accepts bare repo ids and pasted HF URLs', () => {
    expect(runtimeHf.normalizeHfInput('org/repo')).toBe('org/repo');
    expect(runtimeHf.normalizeHfInput('  org/repo  ')).toBe('org/repo');
    expect(runtimeHf.normalizeHfInput('https://huggingface.co/org/repo')).toBe('org/repo');
    expect(runtimeHf.normalizeHfInput('http://www.huggingface.co/org/repo?ref=main')).toBe('org/repo');
    expect(runtimeHf.normalizeHfInput('hf.co/org/repo#readme')).toBe('org/repo');
    expect(runtimeHf.normalizeHfInput('org/repo/')).toBe('org/repo');
    expect(runtimeHf.normalizeHfInput('datasets/org/repo')).toBe('org/repo');
    // dots/dashes/underscores are legal HF repo characters
    expect(runtimeHf.normalizeHfInput('NousResearch/SoV3-7B-Plus')).toBe('NousResearch/SoV3-7B-Plus');
  });

  it('rejects non-repo shapes (no fabrication)', () => {
    expect(runtimeHf.normalizeHfInput('')).toBeNull();
    expect(runtimeHf.normalizeHfInput('org')).toBeNull();
    expect(runtimeHf.normalizeHfInput('org/repo/extra')).toBeNull();
    expect(runtimeHf.normalizeHfInput('org/ repo')).toBeNull();
    expect(runtimeHf.normalizeHfInput(null)).toBeNull();
    expect(runtimeHf.normalizeHfInput(42)).toBeNull();
    expect(runtimeHf.normalizeHfInput('org/repo x')).toBeNull();
  });

  it('isRepoShaped is a cheap loose pre-check for the picker', () => {
    expect(runtimeHf.isRepoShaped('org/repo')).toBe(true);
    expect(runtimeHf.isRepoShaped('https://huggingface.co/org/repo')).toBe(true);
    expect(runtimeHf.isRepoShaped('plain query')).toBe(false);
    expect(runtimeHf.isRepoShaped('GLM')).toBe(false);
    expect(runtimeHf.isRepoShaped('')).toBe(false);
  });
});

describe('stats-94: row + meta builders (census shapes)', () => {
  const entry = {
    hf_id: 'demo-org/Test-94', name: 'Test-94', org: 'demo-org',
    created: '2026-11-01', downloads: 12340, likes: 56,
    pipeline_tag: 'text-generation', total_params_b: 27.3, added: '2026-11-21',
  };

  it('buildRuntimeRow: card + hf_only + runtime true, every cell null', () => {
    const row = runtimeHf.buildRuntimeRow(entry, ['Arena', 'DeepSWE']);
    expect(row).toMatchObject({
      name: 'Test-94', num_benchmarks: 0, cl: 0,
      card: true, hf_only: true, runtime: true,
    });
    expect(row['Epoch ECI'] ?? null).toBeNull();
    expect(row['Arena'] ?? null).toBeNull();
    expect(row['DeepSWE'] ?? null).toBeNull();
  });

  it('buildRuntimeMeta: same key shape as the baked lane, match=runtime-hf', () => {
    const m = runtimeHf.buildRuntimeMeta(entry);
    expect(m.match).toBe('runtime-hf');
    expect(m.or_id ?? null).toBeNull();
    expect(m.provider).toBe('demo-org');
    expect(m.hugging_face_id).toBe('demo-org/Test-94');
    expect(m.total_params_b).toBe(27.3);
    expect(m.params_source).toBe('huggingface');
    expect(m.created).toBe('2026-11-01');
    expect(m.hf_only).toBe(true);
    expect(m.hf_runtime_added).toBe('2026-11-21');
    // OR-only fields stay honest gaps, never guessed
    expect(m.context_length ?? null).toBeNull();
    expect(m.pricing_usd_per_1m ?? null).toBeNull();
    expect(m.superseded_by ?? null).toBeNull();
  });

  it('buildRuntimeMeta without a param count keeps params_source null', () => {
    const m = runtimeHf.buildRuntimeMeta({ ...entry, total_params_b: null });
    expect(m.total_params_b ?? null).toBeNull();
    expect(m.params_source ?? null).toBeNull();
  });
});

describe('stats-94: addRuntimeRepo contract', () => {
  it('adds a repo: fetches identity, stores it, returns the entry', async () => {
    const res = await runtimeHf.addRuntimeRepo('demo-org/Test-94', { knownNames: ['Other Model'] });
    expect(res.ok).toBe(true);
    expect(res.entry).toMatchObject({
      hf_id: 'demo-org/Test-94', name: 'Test-94', org: 'demo-org',
      created: '2026-11-01', downloads: 12340, likes: 56, total_params_b: 27.3,
    });
    expect(res.entry.added).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // persisted under the versioned key
    const stored = JSON.parse(lsStore.get(runtimeHf.RUNTIME_HF_STORAGE_KEY));
    expect(stored.version).toBe(runtimeHf.RUNTIME_HF_SCHEMA_VERSION);
    expect(stored.repos).toHaveLength(1);
    expect(stored.repos[0].hf_id).toBe('demo-org/Test-94');
    expect(runtimeHf.runtimeRepoCount()).toBe(1);
    // the HF request went out with the slash intact
    const called = fetchMock.mock.calls.map(c => String(c[0]));
    expect(called.some(u => u.endsWith('/api/models/demo-org/Test-94'))).toBe(true);
  });

  it('refuses a repo whose display name is already on the board', async () => {
    const res = await runtimeHf.addRuntimeRepo('nex-agi/Nex-N2.6', { knownNames: ['Nex-N2.6', 'Other'] });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('already-on-board');
    expect(res.error).toContain('Nex-N2.6');
    expect(lsStore.has(runtimeHf.RUNTIME_HF_STORAGE_KEY)).toBe(false);
    // the collision check must happen BEFORE the fetch (no wasted request)
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses quantized/mirror repos (curation discipline parity)', async () => {
    const res = await runtimeHf.addRuntimeRepo('demo-org/Test-94-GGUF');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('quant');
    const fourBit = await runtimeHf.addRuntimeRepo('demo-org/model-4bit');
    expect(fourBit.reason).toBe('quant');
    // the '-it' suffix is an instruct-mirror marker per the baked-lane regex
    const instruct = await runtimeHf.addRuntimeRepo('demo-org/Test-94-it');
    expect(instruct.reason).toBe('quant');
  });

  it('rejects malformed ids and dead/429 repos with useful errors', async () => {
    const bad = await runtimeHf.addRuntimeRepo('just-a-name');
    expect(bad).toMatchObject({ ok: false, reason: 'bad-shape' });
    const dead = await runtimeHf.addRuntimeRepo('bad-org/dead-repo');
    expect(dead).toMatchObject({ ok: false, reason: 'fetch' });
    expect(dead.error).toContain('404');
    const busy = await runtimeHf.addRuntimeRepo('rate-limited-org/busy-repo');
    expect(busy.reason).toBe('fetch');
    expect(busy.error).toContain('rate limit');
  });

  it('dedupes: a second add of the same repo never re-fetches', async () => {
    await runtimeHf.addRuntimeRepo('demo-org/Test-94');
    const calls = fetchMock.mock.calls.length;
    const again = await runtimeHf.addRuntimeRepo('https://huggingface.co/demo-org/Test-94');
    expect(again.ok).toBe(false);
    expect(again.reason).toBe('already-added');
    expect(again.entry.hf_id).toBe('demo-org/Test-94');
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('removeRuntimeRepo drops by display name and clears the key when empty', async () => {
    await runtimeHf.addRuntimeRepo('demo-org/Test-94');
    expect(runtimeHf.removeRuntimeRepo('Not-There')).toBe(false);
    expect(runtimeHf.removeRuntimeRepo('Test-94')).toBe(true);
    expect(runtimeHf.runtimeRepoCount()).toBe(0);
    expect(lsStore.has(runtimeHf.RUNTIME_HF_STORAGE_KEY)).toBe(false);
  });

  it('storage roundtrip: a seeded store rehydrates on reset', async () => {
    await runtimeHf.addRuntimeRepo('demo-org/Test-94');
    runtimeHf.__resetRuntimeHfForTests();
    expect(runtimeHf.runtimeRepoCount()).toBe(1);
    // a stale/garbage payload is ignored, never trusted
    lsStore.set(runtimeHf.RUNTIME_HF_STORAGE_KEY, JSON.stringify({ version: 999, repos: 'junk' }));
    runtimeHf.__resetRuntimeHfForTests();
    expect(runtimeHf.runtimeRepoCount()).toBe(0);
    lsStore.set(runtimeHf.RUNTIME_HF_STORAGE_KEY, 'not-json');
    runtimeHf.__resetRuntimeHfForTests();
    expect(runtimeHf.runtimeRepoCount()).toBe(0);
  });
});

// ── store merge (data.js) ──────────────────────────────────────────────────
const { ensureLoaded, useData } = await import('../../src/stores/data.js');

describe('stats-94: the store merges runtime entries into the census', () => {
  let d;
  const baked = snapshot.card_models || [];

  beforeAll(async () => {
    await ensureLoaded();
    d = useData();
  });

  beforeEach(() => {
    runtimeHf.__resetRuntimeHfForTests();
    runtimeHf.runtimeEntries.value = [];
  });

  it('baseline: with no runtime entries, cardModels is exactly the doc section', () => {
    expect(d.cardModels.value).toHaveLength(baked.length);
    expect(d.cardModels.value.map(r => r.name).sort()).toEqual(baked.map(r => r.name).sort());
  });

  it('a runtime entry becomes a census row appended AFTER the baked section', () => {
    runtimeHf.runtimeEntries.value = [{
      hf_id: 'demo-org/Test-94', name: 'Test-94', org: 'demo-org',
      created: '2026-11-01', downloads: 10, likes: 2, pipeline_tag: null,
      total_params_b: 27.3, added: '2026-11-21',
    }];
    const rows = d.cardModels.value;
    expect(rows).toHaveLength(baked.length + 1);
    const row = rows[rows.length - 1];
    expect(row.name).toBe('Test-94');
    expect(row.card).toBe(true);
    expect(row.hf_only).toBe(true);
    expect(row.runtime).toBe(true);
    // every benchmark cell null — the red line (no evidence, no rating)
    for (const b of snapshot.benchmarks) expect(row[b] ?? null).toBeNull();
    expect(row['Epoch ECI'] ?? null).toBeNull();
  });

  it('runtime rows never join the ranked universe (no score, no rank, no grade)', () => {
    runtimeHf.runtimeEntries.value = [{
      hf_id: 'demo-org/Test-94', name: 'Test-94', org: 'demo-org',
      created: '2026-11-01', downloads: 10, likes: 2, pipeline_tag: null,
      total_params_b: null, added: '2026-11-21',
    }];
    const row = d.cardModels.value[d.cardModels.value.length - 1];
    expect(d.pivotAll.value.some(r => r.name === 'Test-94')).toBe(false);
    expect(d.scoreForModel(row)).toBeNull();
    expect(d.isUnranked(row)).toBe(false); // census, not unranked-rank
    expect(d.isCardRow(row)).toBe(true);
    for (const tier of ['all', 'closed', 'open']) {
      expect(d.rankOf(tier, row)).toBeUndefined();
    }
    expect(d.gradeFor(row)).toBeNull();
    expect(d.valueFor(row)).toBeNull();
  });

  it('runtime rows resolve model-page slugs (registered after baked + ranked)', () => {
    runtimeHf.runtimeEntries.value = [{
      hf_id: 'demo-org/Test-94', name: 'Test-94', org: 'demo-org',
      created: '2026-11-01', downloads: 10, likes: 2, pipeline_tag: null,
      total_params_b: null, added: '2026-11-21',
    }];
    const slug = d.modelSlug('Test-94');
    expect(d.modelSlugIndex.value.get(slug)?.name).toBe('Test-94');
    // existing slugs never move
    for (const r of d.pivotAll.value.slice(0, 30)) {
      expect(d.modelSlugIndex.value.get(d.modelSlug(r.name))?.name).toBe(r.name);
    }
    for (const r of baked.slice(0, 10)) {
      expect(d.modelSlugIndex.value.get(d.modelSlug(r.name))?.name).toBe(r.name);
    }
  });

  it('metaFor resolves the runtime record; baked records are never shadowed', () => {
    runtimeHf.runtimeEntries.value = [{
      hf_id: 'demo-org/Test-94', name: 'Test-94', org: 'demo-org',
      created: '2026-11-01', downloads: 10, likes: 2, pipeline_tag: null,
      total_params_b: 27.3, added: '2026-11-21',
    }];
    const row = d.cardModels.value[d.cardModels.value.length - 1];
    const m = d.metaFor(row);
    expect(m.match).toBe('runtime-hf');
    expect(m.hugging_face_id).toBe('demo-org/Test-94');
    expect(m.params_source).toBe('huggingface');
    // baked provenance untouched: every baked card keeps its own record
    const bakedHf = baked.find(r => r.hf_only);
    expect(d.metaFor(bakedHf).match).toBe('curated-hf');
  });

  it('a baked row with the same name wins — the runtime duplicate drops out', () => {
    const bakedName = baked[0].name;
    runtimeHf.runtimeEntries.value = [{
      hf_id: `some-org/${bakedName}`, name: bakedName, org: 'some-org',
      created: null, downloads: null, likes: null, pipeline_tag: null,
      total_params_b: null, added: '2026-11-21',
    }];
    expect(d.cardModels.value).toHaveLength(baked.length);
    // the surviving row is the baked one (runtime meta did not shadow it)
    expect(d.cardModels.value.map(r => r.name)).toContain(bakedName);
  });

  it('a ranked row name is blocked too (stale-storage belt-and-braces)', () => {
    const rankedName = snapshot.unified_closed[0].name;
    runtimeHf.runtimeEntries.value = [{
      hf_id: `org/${rankedName}`, name: rankedName, org: 'org',
      created: null, downloads: null, likes: null, pipeline_tag: null,
      total_params_b: null, added: '2026-11-21',
    }];
    // no census twin of a ranked row, ever
    expect(d.cardModels.value).toHaveLength(baked.length);
    expect(d.cardModels.value.some(r => r.name === rankedName && r.runtime)).toBe(false);
    // and the ranked row's own meta record is untouched
    const rankedRow = d.pivotClosed.value.find(r => r.name === rankedName);
    expect(d.metaFor(rankedRow)?.match ?? null).not.toBe('runtime-hf');
  });
});
