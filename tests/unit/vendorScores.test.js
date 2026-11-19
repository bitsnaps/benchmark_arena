// Unit tests for the stats-91 vendor lane helper in src/stores/data.js —
// vendorScoresFor is the single read path for creator-reported scores, and
// it must return scores ONLY for rows that carry them (card rows baked by
// scripts/bake_vendor_scores.py). Ranked rows never carry the key, but the
// helper stays defensive: anything non-array folds to [].
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
  return await import('../../src/stores/data.js');
}

beforeEach(() => mem.clear());

describe('stats-91: vendorScoresFor (creator-reported lane)', () => {
  it('returns the baked array for a card row that carries vendor_scores', async () => {
    const s = await freshStore();
    const row = {
      name: 'LongCat 2.0', card: true, cl: 0, num_benchmarks: 0,
      vendor_scores: [{ benchmark: 'GPQA-diamond', score: 88.9, qualifier: 'in-house', source: 'card' }],
      vendor_source_url: 'https://huggingface.co/meituan-longcat/LongCat-2.0',
    };
    expect(s.useData().vendorScoresFor(row)).toHaveLength(1);
    expect(s.useData().vendorScoresFor(row)[0].score).toBe(88.9);
  });

  it('returns [] for rows without the key (ranked rows, scoreless census rows)', async () => {
    const s = await freshStore();
    expect(s.useData().vendorScoresFor({ name: 'GPT-5.5', score: 78.2 })).toEqual([]);
    expect(s.useData().vendorScoresFor({ name: 'Nex-N2.6', card: true })).toEqual([]);
  });

  it('folds corrupt values (non-array) to [] — display-only, never throws', async () => {
    const s = await freshStore();
    expect(s.useData().vendorScoresFor({ name: 'X', vendor_scores: 'oops' })).toEqual([]);
    expect(s.useData().vendorScoresFor({ name: 'X', vendor_scores: null })).toEqual([]);
    expect(s.useData().vendorScoresFor(null)).toEqual([]);
  });
});
