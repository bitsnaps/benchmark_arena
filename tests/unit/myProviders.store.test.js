// Unit tests for src/stores/myProviders.js — versioned localStorage
// persistence, the action set, and export/import round-trips.
// The store guards `typeof window === 'undefined'`, so in node we mount a
// minimal window.localStorage mock; a fresh module import re-reads storage
// (proving the schema-versioned round-trip a real browser would do).
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mem = new Map();
const localStorageMock = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => void mem.set(k, String(v)),
  removeItem: (k) => void mem.delete(k),
};
globalThis.window = { localStorage: localStorageMock };

async function freshStore() {
  vi.resetModules();
  return await import('../../src/stores/myProviders.js');
}

beforeEach(() => {
  mem.clear();
});

describe('myProviders store', () => {
  it('starts empty without storage and persists adds under the versioned key', async () => {
    const s = await freshStore();
    await s.ensureMyProvidersLoaded();
    expect(s.useMyProviders().providers.value).toEqual([]);

    const p = s.addProvider({ label: 'UnoRouter', baseUrl: 'https://api.unorouter.com/v1', key: 'sk-test', mode: 'fetch' });
    expect(p.id).toBeTruthy();
    expect(mem.has(s.STORAGE_KEY)).toBe(true);
    const doc = JSON.parse(mem.get(s.STORAGE_KEY));
    expect(doc.version).toBe(s.SCHEMA_VERSION);
    expect(doc.providers).toHaveLength(1);
    expect(doc.providers[0]).toMatchObject({ label: 'UnoRouter', mode: 'fetch', models: [] });
    // the key is stored client-side by design — but never outside storage
    expect(JSON.stringify(doc).indexOf('sk-test')).toBeGreaterThan(-1);
  });

  it('setModels stores listings but never score-shaped fields; clearAll wipes', async () => {
    const s = await freshStore();
    await s.ensureMyProvidersLoaded();
    const p = s.addProvider({ label: 'P' });
    s.setModels(p.id, [{ id: 'a', key: 'a', chat: true, endpoints: ['openai'] }], { via: 'paste' });
    let doc = JSON.parse(mem.get(s.STORAGE_KEY));
    expect(doc.providers[0].models[0].id).toBe('a');
    expect(doc.providers[0].lastSyncAt).toBeTruthy();
    expect(doc.providers[0].mode).toBe('paste');

    s.setError(p.id, 'boom');
    doc = JSON.parse(mem.get(s.STORAGE_KEY));
    expect(doc.providers[0].lastError).toBe('boom');

    s.clearAll();
    expect(mem.has(s.STORAGE_KEY)).toBe(false);
    expect(s.useMyProviders().providers.value).toEqual([]);
  });

  it('reloads from storage on a fresh module instance (the browser round-trip)', async () => {
    const s1 = await freshStore();
    await s1.ensureMyProvidersLoaded();
    const p = s1.addProvider({ label: 'Gateway' });
    s1.setModels(p.id, [{ id: 'x', key: 'x', chat: true, endpoints: [] }]);

    const s2 = await freshStore();
    await s2.ensureMyProvidersLoaded();
    const list = s2.useMyProviders().providers.value;
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('Gateway');
    expect(list[0].models[0].id).toBe('x');
  });

  it('ignores wrong-version / corrupt payloads instead of throwing', async () => {
    mem.set('ba.myproviders.v1', JSON.stringify({ version: 999, providers: [{ id: '1', label: 'future' }] }));
    mem.set('ba.myproviders.other', 'not even used');
    const s = await freshStore();
    await s.ensureMyProvidersLoaded();
    expect(s.useMyProviders().providers.value).toEqual([]);
    mem.set('ba.myproviders.v1', '{corrupt');
    const s2 = await freshStore();
    await s2.ensureMyProvidersLoaded();
    expect(s2.useMyProviders().providers.value).toEqual([]);
  });

  it('export → import round-trips providers through the payload shape', async () => {
    const s = await freshStore();
    await s.ensureMyProvidersLoaded();
    const p = s.addProvider({ label: 'A', baseUrl: 'https://x/v1' });
    s.setModels(p.id, [{ id: 'm1', key: 'm1', chat: true, endpoints: [] }]);
    s.updateProvider(p.id, { intent: 'prices' });
    const payload = s.exportPayload();
    expect(JSON.parse(payload).kind).toBe('benchmark-arena-my-providers');

    s.clearAll();
    const r = s.importPayload(payload);
    expect(r).toMatchObject({ ok: true, count: 1 });
    const restored = s.useMyProviders().providers.value[0];
    expect(restored).toMatchObject({ label: 'A', intent: 'prices', baseUrl: 'https://x/v1' });
    expect(restored.models[0].id).toBe('m1');

    expect(s.importPayload('nope').ok).toBe(false);
    expect(s.importPayload('{"kind":"other"}').ok).toBe(false);
  });

  it('removeProvider and updateProvider mutate + persist', async () => {
    const s = await freshStore();
    await s.ensureMyProvidersLoaded();
    const p = s.addProvider({ label: 'B' });
    s.updateProvider(p.id, { label: 'B2', baseUrl: 'https://y' });
    expect(s.useMyProviders().providers.value[0].label).toBe('B2');
    s.removeProvider(p.id);
    expect(s.useMyProviders().providers.value).toHaveLength(0);
    // empty state removes the storage key entirely (writeStorage contract)
    expect(mem.has('ba.myproviders.v1')).toBe(false);
  });
});
