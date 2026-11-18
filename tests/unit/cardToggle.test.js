// Unit tests for the stats-87/89 "Show OpenRouter-only" reveal toggle in
// src/stores/leaderboard.js — stats-89 flipped the shipped default to ON
// (card rows render inline at the bottom of the ranked table), so the
// persistence contract is inverted: only the OFF choice is stored under
// the versioned key (the shipped default survives cleared storage — same
// shape as the bl_eci_v1 store). Corrupt/stale storage falls back to the
// shipped default (ON). The store guards `typeof window === 'undefined'`,
// so in node we mount a minimal window.localStorage mock; a fresh module
// import re-reads storage (proving the versioned round-trip a real
// browser would do).
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

describe('stats-89: showCardModels persistence (shipped default ON)', () => {
  it('defaults to visible without any stored choice', async () => {
    const s = await freshStore();
    expect(s.useLeaderboard().showCardModels.value).toBe(true);
    expect(mem.has(s.CARD_STORAGE_KEY)).toBe(false);
  });

  it('persists turning it OFF under the versioned key; ON removes it', async () => {
    const s = await freshStore();
    const lb = s.useLeaderboard();

    lb.showCardModels.value = false;
    expect(mem.has(s.CARD_STORAGE_KEY)).toBe(true);
    const doc = JSON.parse(mem.get(s.CARD_STORAGE_KEY));
    expect(doc.version).toBe(s.CARD_SCHEMA_VERSION);
    expect(doc.on).toBe(false);

    lb.showCardModels.value = true;
    expect(mem.has(s.CARD_STORAGE_KEY)).toBe(false);
  });

  it('re-reads the stored choice on a fresh import (browser round-trip)', async () => {
    let s = await freshStore();
    s.useLeaderboard().showCardModels.value = false;

    s = await freshStore();
    expect(s.useLeaderboard().showCardModels.value).toBe(false);

    // back on — the removal must survive the round-trip too
    s.useLeaderboard().showCardModels.value = true;
    s = await freshStore();
    expect(s.useLeaderboard().showCardModels.value).toBe(true);
  });

  it('honors a legacy stats-87 stored {on:true} choice as ON', async () => {
    // pre-89 users who explicitly turned the census on keep it on
    mem.set('bl_card_v1', JSON.stringify({ version: 1, on: true }));
    const s = await freshStore();
    expect(s.useLeaderboard().showCardModels.value).toBe(true);
  });

  it('ignores stale-schema and corrupt stored values (falls back to the shipped default ON)', async () => {
    mem.set('bl_card_v1', JSON.stringify({ version: 99, on: false }));
    let s = await freshStore();
    expect(s.useLeaderboard().showCardModels.value).toBe(true);

    mem.set('bl_card_v1', '{not json');
    s = await freshStore();
    expect(s.useLeaderboard().showCardModels.value).toBe(true);
  });
});
