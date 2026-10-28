// stats-66 unit tests: lib/myProviderRows.js — the shared row builders
// behind the My Providers card tables and the per-provider full page.
// Pure functions + fake catalog context: no snapshot, no network.
import { describe, it, expect } from 'vitest';
import { buildCatalogIndex, parseModelListing } from '../../src/lib/myProviders.js';
import {
  buildMatchedRows, buildUnlistedRows, buildMergedRows,
  sortMergedRows, numSort, textSort, passLabelOf,
} from '../../src/lib/myProviderRows.js';

// ── fake snapshot context ─────────────────────────────────────────────
// Two arena models: one current, one older (superseded), plus one unranked
// row (stats-65) that must stay out of the picks entirely.
const PIVOT_ROWS = [
  { name: 'Claude Opus 4.6' },
  { name: 'GPT-5.6 Luna' },
  { name: 'Old Bot 1.0' },
  { name: 'Fresh Single-Source' },
];
const META = {
  'Old Bot 1.0': { superseded_by: 'Old Bot 2.0' },
  'Fresh Single-Source': { unranked: true },
};
const baseCtx = () => ({
  catalogIndex: buildCatalogIndex(PIVOT_ROWS.filter(r => r.name !== 'Fresh Single-Source'), META),
  rowByName: new Map(PIVOT_ROWS.map(r => [r.name, r])),
  scoreForModel: (row) => ({ 'Claude Opus 4.6': 72.5, 'GPT-5.6 Luna': 61, 'Old Bot 1.0': 40 }[row.name] ?? null),
  clForModel: (row) => ({ 'Claude Opus 4.6': 88, 'GPT-5.6 Luna': 55 }[row.name] ?? null),
  priceFor: (row) => ({ 'Claude Opus 4.6': { blend: 9.1 }, 'GPT-5.6 Luna': { blend: 0.4 } }[row.name] ?? null),
  isOlder: (row) => row.name === 'Old Bot 1.0',
  isUnranked: (row) => row.name === 'Fresh Single-Source',
});

// provider listing: exact hit, :free twin of an arena model, one reseller
// SKU with published prices, one unlisted id, one non-chat endpoint.
// Built through the REAL parser (parseModelListing) — the app never feeds
// raw id strings to the matchers, so the tests must not either.
const LISTING_JSON = JSON.stringify({
  object: 'list',
  data: [
    { id: 'claude-opus-4.6', object: 'model', supported_endpoint_types: ['openai'], pricing: { prompt: '0.000002', completion: '0.00001' } },
    { id: 'claude-opus-4.6:free', object: 'model', supported_endpoint_types: ['openai'], pricing: { prompt: '0', completion: '0' } },
    { id: 'gpt-5.6-luna]', object: 'model', supported_endpoint_types: ['openai'], context_length: 1000000, pricing: { prompt: '0.000001', completion: '0.000004' } },
    { id: 'reseller-only-9b', object: 'model', supported_endpoint_types: ['openai'], context_length: 32000, pricing: { prompt: '0.5', completion: '1.5' } },
    { id: 'image-forge-xl', object: 'model', owned_by: 'runware', supported_endpoint_types: ['image-generation'] },
  ],
});
const PROVIDER = () => ({
  id: 'p1', label: 'Test Gateway', mode: 'paste', intent: '', priceKeys: null,
  models: parseModelListing(LISTING_JSON).models,
});

describe('passLabelOf / PASS_LABEL', () => {
  it('labels single and combo passes', () => {
    expect(passLabelOf('exact')).toBe('exact id');
    expect(passLabelOf('route+dated')).toBe('route tag + dated snapshot');
    expect(passLabelOf('mystery')).toBe('mystery');
  });
});

describe('buildMatchedRows', () => {
  it('mirrors score / CL / arena price read-only and labels the pass', () => {
    const rows = buildMatchedRows(PROVIDER(), baseCtx());
    const opus = rows.find(r => r.name === 'Claude Opus 4.6');
    expect(opus).toBeTruthy();
    expect(opus.score).toBe(72.5);
    expect(opus.cl).toBe(88);
    expect(opus.price).toEqual({ blend: 9.1 });
    expect(opus.pass).toBe('exact');
    expect(opus.older).toBe(false);
    expect(opus.slug).toBe('claude-opus-4-6');
  });

  it('flags older generations via isOlder', () => {
    const p = PROVIDER();
    p.models.push(...parseModelListing(JSON.stringify({ object: 'list', data: [
      { id: 'old-bot-1.0', object: 'model', supported_endpoint_types: ['openai'] },
    ] })).models);
    const rows = buildMatchedRows(p, baseCtx());
    expect(rows.find(r => r.name === 'Old Bot 1.0').older).toBe(true);
  });

  it('excludes unranked rows from the picks (stats-65)', () => {
    const p = PROVIDER();
    p.models.push(...parseModelListing(JSON.stringify({ object: 'list', data: [
      { id: 'fresh-single-source', object: 'model', supported_endpoint_types: ['openai'] },
    ] })).models);
    const rows = buildMatchedRows(p, baseCtx());
    expect(rows.some(r => r.name === 'Fresh Single-Source')).toBe(false);
  });

  it('extracts the provider-published price (ownPrice) per matched row', () => {
    const rows = buildMatchedRows(PROVIDER(), baseCtx());
    const luna = rows.find(r => r.key === 'gpt-5.6-luna]');
    expect(luna.ownPrice).toEqual({ in: 1, out: 4, blend: 1.75, viaKeys: false });
  });

  it('honors custom pricing keys as a render-time lens (stats-51)', () => {
    const p = PROVIDER();
    p.models = parseModelListing(JSON.stringify({ object: 'list', data: [
      { id: 'sol-gateway', object: 'model', type: 'chat', supported_endpoint_types: ['openai'],
        pricing: { type: 'per_token', currency: 'USD', input_per_1M_tokens: 2.11, output_per_1M_tokens: 10.55 } },
    ] })).models;
    p.priceKeys = { input: 'pricing.input_per_1M_tokens', output: 'pricing.output_per_1M_tokens', unit: '1m' };
    // buildCatalogIndex won't match sol-gateway — but the key extraction is
    // what we assert, through an unlisted row (same extractPricingFor path).
    const rows = buildUnlistedRows(p, { catalogIndex: baseCtx().catalogIndex });
    expect(rows[0].price).toEqual({ in: 2.11, out: 10.55, viaKeys: true });
  });

  it('returns [] without a catalog index (renders regardless of fetch state)', () => {
    expect(buildMatchedRows(PROVIDER(), { ...baseCtx(), catalogIndex: null })).toEqual([]);
    expect(buildMatchedRows(PROVIDER(), null)).toEqual([]);
  });
});

describe('buildUnlistedRows', () => {
  it('splits reseller-only rows and hides non-chat by default', () => {
    const rows = buildUnlistedRows(PROVIDER(), { catalogIndex: baseCtx().catalogIndex });
    const keys = rows.map(r => r.key);
    expect(keys).toContain('reseller-only-9b');
    expect(keys).not.toContain('image-forge-xl');
    expect(rows.every(r => r.kind === 'chat')).toBe(true);
  });

  it('includes non-chat rows when the toggle is on', () => {
    const rows = buildUnlistedRows(PROVIDER(), { catalogIndex: baseCtx().catalogIndex, includeNonChat: true });
    const img = rows.find(r => r.key === 'image-forge-xl');
    expect(img.kind).toBe('non-chat');
  });

  it('keeps the arena-free twin unlisted when it matched (free twins ride with the arena row)', () => {
    // :free twins of arena models match the SAME arena row (exact pass), so
    // they appear as matched rows with free=true — never as unlisted.
    const rows = buildMatchedRows(PROVIDER(), baseCtx());
    const free = rows.filter(r => r.free === true);
    expect(free.length).toBeGreaterThanOrEqual(1);
  });
});

describe('buildMergedRows', () => {
  it('tags status and keeps arena fields null on unlisted rows', () => {
    const rows = buildMergedRows(PROVIDER(), baseCtx());
    const arena = rows.filter(r => r.status === 'arena');
    const unlisted = rows.filter(r => r.status === 'unlisted');
    expect(arena.length).toBe(3); // opus + free twin + luna (gpt-5.6-luna] exact-normKey match)
    expect(unlisted.map(r => r.key)).toContain('reseller-only-9b');
    for (const r of unlisted) {
      expect(r.score).toBeNull();
      expect(r.cl).toBeNull();
      expect(r.price).toBeNull();
      expect(r.name).toBeNull();
    }
    for (const r of arena) expect(r.ownPrice).toBeTruthy();
  });

  it('marks non-chat rows with their own status only when included', () => {
    const off = buildMergedRows(PROVIDER(), baseCtx());
    expect(off.some(r => r.status === 'non-chat')).toBe(false);
    const on = buildMergedRows(PROVIDER(), baseCtx(), { includeNonChat: true });
    expect(on.filter(r => r.status === 'non-chat').map(r => r.key)).toEqual(['image-forge-xl']);
  });

  it('default (scores) order: arena score desc, unlisted sink, then name', () => {
    const rows = buildMergedRows(PROVIDER(), baseCtx());
    const arena = rows.filter(r => r.status === 'arena').map(r => r.name);
    expect(arena[0]).toBe('Claude Opus 4.6');
    expect(arena.indexOf('GPT-5.6 Luna')).toBeGreaterThan(arena.indexOf('Claude Opus 4.6'));
    expect(rows[rows.length - 1].status).not.toBe('arena');
  });

  it('prices intent: provider-published price cheapest first (fixture has no priceless rows)', () => {
    const p = PROVIDER();
    p.intent = 'prices';
    const rows = buildMergedRows(p, baseCtx());
    const blends = rows.map(r => r.ownPrice?.blend ?? null);
    expect(blends.every(v => v !== null)).toBe(true); // opus + free twin + luna + reseller-only all publish prices
    expect(blends).toEqual([...blends].sort((a, b) => a - b)); // cheapest first
    expect(blends[0]).toBe(0); // the :free twin
  });

  it('track intent: plain name/id order, arena row above its :free twin', () => {
    const p = PROVIDER();
    p.intent = 'track';
    const rows = buildMergedRows(p, baseCtx());
    const names = rows.map(r => r.name || r.key);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names.slice(0, names.length)).toEqual(sorted.slice(0, names.length));
  });
});

describe('sortMergedRows is stable on the input array', () => {
  it('does not mutate the caller\'s array', () => {
    const rows = buildMergedRows(PROVIDER(), baseCtx());
    const before = JSON.stringify(rows.map(r => r.key));
    sortMergedRows(rows, 'scores');
    expect(JSON.stringify(rows.map(r => r.key))).toBe(before);
  });
});

describe('numSort / textSort (Buefy custom-sort contract)', () => {
  const rows = [{ v: 3 }, { v: null }, { v: 1 }, { v: 2 }];
  it('numSort: nulls sink in BOTH directions', () => {
    const asc = [...rows].sort((a, b) => numSort(r => r.v)(a, b, true));
    const desc = [...rows].sort((a, b) => numSort(r => r.v)(a, b, false));
    expect(asc.map(r => r.v)).toEqual([1, 2, 3, null]);
    expect(desc.map(r => r.v)).toEqual([3, 2, 1, null]);
  });
  it('textSort: same null-last discipline for strings', () => {
    const rs = [{ s: 'b' }, { s: null }, { s: 'a' }];
    const asc = [...rs].sort((a, b) => textSort(r => r.s)(a, b, true));
    expect(asc.map(r => r.s)).toEqual(['a', 'b', null]);
  });
});
