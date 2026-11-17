// Unit tests for the stats-87 "Show OpenRouter-only" reveal toggle in
// src/stores/leaderboard.js — default-off, versioned localStorage
// persistence, and corrupt/stale storage tolerance. Mirrors
// unrankedToggle.test.js (same only-ON persistence contract).
// The store guards `typeof window === 'undefined'`, so in node we mount a
// minimal window.localStorage mock; a fresh module import re-reads storage
// (proving the versioned round-trip a real browser would do).
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

describe('stats-87: showCardModels persistence', () => {
  it('defaults to hidden without any stored choice', async () => {
    const s = await freshStore();
    expect(s.useLeaderboard().showCardModels.value).toBe(false);
    expect(mem.has(s.CARD_STORAGE_KEY)).toBe(false);
  });

  it('persists turning it on under the versioned key and off removes it', async () => {
    const s = await freshStore();
    const lb = s.useLeaderboard();

    lb.showCardModels.value = true;
    expect(mem.has(s.CARD_STORAGE_KEY)).toBe(true);
    const doc = JSON.parse(mem.get(s.CARD_STORAGE_KEY));
    expect(doc.version).toBe(s.CARD_SCHEMA_VERSION);
    expect(doc.on).toBe(true);

    lb.showCardModels.value = false;
    expect(mem.has(s.CARD_STORAGE_KEY)).toBe(false);
  });

  it('re-reads the stored choice on a fresh import (browser round-trip)', async () => {
    let s = await freshStore();
    s.useLeaderboard().showCardModels.value = true;

    s = await freshStore();
    expect(s.useLeaderboard().showCardModels.value).toBe(true);

    // off again — removal must survive the round-trip too
    s.useLeaderboard().showCardModels.value = false;
    s = await freshStore();
    expect(s.useLeaderboard().showCardModels.value).toBe(false);
  });

  it('ignores stale-schema and corrupt stored values (falls back to hidden)', async () => {
    mem.set('bl_card_v1', JSON.stringify({ version: 99, on: true }));
    let s = await freshStore();
    expect(s.useLeaderboard().showCardModels.value).toBe(false);

    mem.set('bl_card_v1', '{not json');
    s = await freshStore();
    expect(s.useLeaderboard().showCardModels.value).toBe(false);
  });
});
