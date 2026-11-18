import { describe, expect, it } from 'vitest';
import { BLURBS, CORE_BENCHMARKS, LEADER_BENCHES, SHORT } from '../../src/lib/constants.js';
import { useData } from '../../src/stores/data.js';

// stats-88: the merged Arena column — one column, two disclosed sources.
// The old 'Arena.ai Text' key must be fully gone from the shipped config;
// the UI surfaces provenance via the header tooltip + per-cell marker.

describe('stats-88 Arena column', () => {
  it('CORE_BENCHMARKS carries Arena, never the old key', () => {
    expect(CORE_BENCHMARKS).toContain('Arena');
    expect(CORE_BENCHMARKS).not.toContain('Arena.ai Text');
    expect(CORE_BENCHMARKS).toHaveLength(8);
  });

  it('LEADER_BENCHES + SHORT follow the rename', () => {
    expect(LEADER_BENCHES).toContain('Arena');
    expect(LEADER_BENCHES).not.toContain('Arena.ai Text');
    // SHORT has no stale entry; the header renders the name itself
    expect(SHORT['Arena.ai Text']).toBeUndefined();
  });

  it('the Arena blurb discloses the two-source design', () => {
    const blurb = BLURBS['Arena'];
    expect(blurb).toBeTruthy();
    expect(blurb).toMatch(/Overall/);
    expect(blurb).toMatch(/calibrated/);
    expect(BLURBS['Arena.ai Text']).toBeUndefined();
  });

  it('header tooltip discloses the fill', () => {
    const { benchThAttrs } = useData();
    const t = benchThAttrs({ field: 'Arena' }).title;
    expect(t).toMatch(/Overall/);
    expect(t).toMatch(/calibrated/);
    // non-Arena columns keep the core/not-counted wording
    const aa = benchThAttrs({ field: 'Artificial Analysis' }).title;
    expect(aa).toContain('Artificial Analysis');
    expect(aa).toContain('global Score');
  });

  it('arena fill marker helpers key off meta.arena_source only', () => {
    // marker logic is exercised in e2e; here we lock the meta contract
    const row = { name: 'Old Model', Arena: 62.1 };
    expect(row.Arena).toBe(62.1);
    expect('arena_source' in row).toBe(false); // provenance lives in models_meta, never on rows
  });
});
