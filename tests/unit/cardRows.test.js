// Unit tests for the stats-87 OpenRouter-only card models — the display-only
// census that lives OUTSIDE the ranked universe. Contract under test:
//   · the doc section ships row-shaped entries (card: true, all cells null)
//   · card rows NEVER join pivotAll / pivotOpen / pivotClosed
//   · no card name reaches rankMaps, gradeMaps or the benchStats basis
//   · card models still get reachable model-page slugs (after the ranked
//     universe — existing slugs never move)
//   · scoreForModel resolves null for card rows (no evidence, no rating)
// Runs against the real committed snapshot via the same fetch stub as
// data.store.test.js, so a pipeline drift fails fast.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const snapshot = JSON.parse(readFileSync(path.join(REPO, 'public/benchmark_results.json'), 'utf8'));

vi.stubGlobal('fetch', vi.fn(async () => ({
  ok: true,
  json: async () => snapshot,
})));

const { ensureLoaded, useData } = await import('../../src/stores/data.js');

const cards = snapshot.card_models || [];

let d;
beforeAll(async () => {
  await ensureLoaded();
  d = useData();
});

describe('stats-87: card models census (doc contract)', () => {
  it('the snapshot ships a card_models section (upstream must keep producing it)', () => {
    expect(cards.length).toBeGreaterThan(0);
  });

  it('every card row is shape-complete: card flag, zero coverage, all-null cells', () => {
    for (const r of cards) {
      expect(r.card, `"${r.name}" card flag`).toBe(true);
      expect(r.num_benchmarks, `"${r.name}"`).toBe(0);
      expect(r.cl, `"${r.name}"`).toBe(0);
      for (const b of snapshot.benchmarks) {
        expect(r[b] ?? null, `"${r.name}" cell ${b}`).toBeNull();
      }
      expect(r['Epoch ECI'] ?? null, `"${r.name}" ECI cell`).toBeNull();
    }
  });

  it('every card row has a proper meta record (pricing source of truth)', () => {
    for (const r of cards) {
      const m = snapshot.models_meta[r.name];
      expect(m, `meta for "${r.name}"`).toBeTruthy();
      expect(m.or_id, `or_id for "${r.name}"`).toBeTruthy();
      expect(m.match, `match for "${r.name}"`).toBe('card');
    }
  });

  it('card names never collide with ranked rows (normKey keeps +, stats-70)', () => {
    // '+' is identity-bearing ('Command A' vs 'Command A+' are distinct
    // products) — same fold discipline as the app's normKey.
    const nk = (s) => s.toLowerCase().replace(/[^a-z0-9+]/g, '');
    const ranked = new Set(
      [...snapshot.unified_closed, ...snapshot.unified_open].map(r => nk(r.name)));
    for (const r of cards) {
      expect(ranked.has(nk(r.name)), `"${r.name}" duplicates a ranked row`).toBe(false);
    }
  });
});

describe('stats-87: card models stay outside the ranked universe', () => {
  it('cardModels exposes exactly the doc section', () => {
    expect(d.cardModels.value.map(r => r.name).sort())
      .toEqual(cards.map(r => r.name).sort());
  });

  it('isCardRow flags card rows and nothing else', () => {
    expect(d.isCardRow({ card: true })).toBe(true);
    expect(d.isCardRow({ name: 'x' })).toBe(false);
    expect(d.isCardRow(null)).toBe(false);
    for (const r of d.pivotAll.value) expect(d.isCardRow(r)).toBe(false);
  });

  it('pivot lists contain zero card rows (they never join the ranking)', () => {
    const cardNames = new Set(cards.map(r => r.name));
    for (const r of d.pivotAll.value) expect(cardNames.has(r.name)).toBe(false);
    for (const r of d.pivotOpen.value) expect(cardNames.has(r.name)).toBe(false);
    for (const r of d.pivotClosed.value) expect(cardNames.has(r.name)).toBe(false);
  });

  it('card rows get no rank and no score', () => {
    for (const r of d.cardModels.value) {
      expect(d.scoreForModel(r), `score for "${r.name}"`).toBeNull();
      for (const tier of ['all', 'closed', 'open']) {
        expect(d.rankOf(tier, r), `rank for "${r.name}" in ${tier}`).toBeUndefined();
      }
    }
  });

  it('card models resolve model-page slugs (deep links stay reachable)', () => {
    expect(cards.length).toBeGreaterThan(0);
    for (const r of d.cardModels.value) {
      const slug = d.modelSlug(r.name);
      expect(d.modelSlugIndex.value.get(slug)?.name, `slug for "${r.name}"`).toBe(r.name);
    }
  });

  it('ranked slugs are untouched by card registration (existing links stay valid)', () => {
    // spot-check the invariant on a sample: every ranked row's slug still
    // resolves to the same row
    for (const r of d.pivotAll.value.slice(0, 50)) {
      const slug = d.modelSlug(r.name);
      expect(d.modelSlugIndex.value.get(slug)?.name).toBe(r.name);
    }
  });
});
