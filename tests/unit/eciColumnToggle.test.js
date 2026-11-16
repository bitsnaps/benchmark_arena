// Unit tests for the stats-85 ECI reference-column toggle in
// src/stores/leaderboard.js — default-ON (ECI leads, per the approved
// stats-82 design), versioned localStorage persistence where ONLY the OFF
// state is written (so the shipped default survives cleared storage), and
// corrupt/stale storage tolerance. Mirrors unrankedToggle.test.js with the
// polarity flipped. The store guards `typeof window === 'undefined'`, so in
// node we mount a minimal window.localStorage mock; a fresh module import
// re-reads storage (proving the versioned round-trip a real browser does).
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
  return await import('../../src/stores/leaderboard.js');
}

beforeEach(() => {
  mem.clear();
});

describe('stats-85: showEci persistence (display-only ECI column)', () => {
  it('defaults to ON without any stored choice (ECI leads, stats-82 design)', async () => {
    const s = await freshStore();
    expect(s.useLeaderboard().showEci.value).toBe(true);
    // default state writes nothing — cleared storage keeps the shipped default
    expect(mem.has(s.ECI_COL_STORAGE_KEY)).toBe(false);
  });

  it('persists ONLY the off state under the versioned key; on removes it', async () => {
    const s = await freshStore();
    const lb = s.useLeaderboard();

    lb.showEci.value = false;
    expect(mem.has(s.ECI_COL_STORAGE_KEY)).toBe(true);
    const doc = JSON.parse(mem.get(s.ECI_COL_STORAGE_KEY));
    expect(doc.version).toBe(s.ECI_COL_SCHEMA_VERSION);
    expect(doc.on).toBe(false);

    // back on — the stored OFF choice is dropped (default takes over)
    lb.showEci.value = true;
    expect(mem.has(s.ECI_COL_STORAGE_KEY)).toBe(false);
  });

  it('re-reads the stored OFF choice on a fresh import (browser round-trip)', async () => {
    let s = await freshStore();
    s.useLeaderboard().showEci.value = false;

    s = await freshStore();
    expect(s.useLeaderboard().showEci.value).toBe(false);

    // re-enable — removal must survive the round-trip too
    s.useLeaderboard().showEci.value = true;
    s = await freshStore();
    expect(s.useLeaderboard().showEci.value).toBe(true);
  });

  it('ignores stale-schema and corrupt stored values (falls back to ON)', async () => {
    mem.set('bl_eci_col_v1', JSON.stringify({ version: 99, on: false }));
    let s = await freshStore();
    expect(s.useLeaderboard().showEci.value).toBe(true);

    mem.set('bl_eci_col_v1', '{not json');
    s = await freshStore();
    expect(s.useLeaderboard().showEci.value).toBe(true);

    // a well-formed current-version doc with on:true also reads as ON
    mem.set('bl_eci_col_v1', JSON.stringify({ version: 1, on: true }));
    s = await freshStore();
    expect(s.useLeaderboard().showEci.value).toBe(true);
  });
});
