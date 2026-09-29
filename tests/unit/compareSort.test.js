// Unit tests for src/lib/compareSort.js — the stats-55 nulls-sink sorter
// used by the side-by-side compare panel. Pure-function tests: missing
// values sink in BOTH directions, ties stay stable, no-value inputs never
// crash. This is the contract that keeps "no data" from outranking scores
// when a column is sorted descending.
import { describe, it, expect } from 'vitest';
import { sinkLast } from '../../src/lib/compareSort.js';

const named = (...pairs) => pairs.map(([name, v]) => ({ name, v }));

// NOTE: Array.prototype.sort comparator signature is (a, b); Buefy calls
// custom-sort as (a, b, isAsc) — here we emulate that call style exactly.
const sortByBuefy = (rows, isAsc) =>
  [...rows].sort((a, b) => sinkLast((r) => r.v)(a, b, isAsc)).map((r) => r.name);

describe('sinkLast — Buefy custom-sort contract', () => {
  const rows = named(
    ['low', 10],
    ['gap-null', null],
    ['high', 90],
    ['gap-undef', undefined],
    ['mid', 50],
  );

  it('ascending: scores low→high, missing values sink last', () => {
    expect(sortByBuefy(rows, true)).toEqual(['low', 'mid', 'high', 'gap-null', 'gap-undef']);
  });

  it('descending: scores high→low, missing values STILL sink last', () => {
    // The bug this lib exists for: Buefy's default would float the gaps
    // to the top on desc — "no data" must never beat a score.
    expect(sortByBuefy(rows, false)).toEqual(['high', 'mid', 'low', 'gap-null', 'gap-undef']);
  });

  it('ties keep their input order (stable sort, no comparator churn)', () => {
    const tied = named(['a', 50], ['b', 50], ['c', 50]);
    expect(sortByBuefy(tied, true)).toEqual(['a', 'b', 'c']);
    expect(sortByBuefy(tied, false)).toEqual(['a', 'b', 'c']);
  });

  it('all-missing column never crashes and never reorders', () => {
    const gaps = named(['x', null], ['y', undefined], ['z', null]);
    expect(sortByBuefy(gaps, true)).toEqual(['x', 'y', 'z']);
    expect(sortByBuefy(gaps, false)).toEqual(['x', 'y', 'z']);
  });

  it('getter sees the row (works for computed scores, not just raw cells)', () => {
    const rows = named(['kimi', { covered: 80 }], ['gap', {}], ['gpt', { covered: 95 }]);
    const cmp = sinkLast((r) => (r.v.covered ?? null));
    expect([...rows].sort((a, b) => cmp(a, b, false)).map((r) => r.name))
      .toEqual(['gpt', 'kimi', 'gap']);
  });
});
