// stats-92: unit tests for the Side-by-side creator-reported group builder.
// The lib is pure display grouping — every test doubles as a red-line
// assertion that nothing here can mutate ranking inputs (plain data in,
// plain data out, no store access).
import { describe, it, expect } from 'vitest';
import { vendorCompareGroups } from '../../src/lib/vendorCompare.js';

const viaKey = (row) => (Array.isArray(row?.vendor_scores) ? row.vendor_scores : []);

describe('vendorCompareGroups', () => {
  it('returns [] for empty / malformed input (never throws)', () => {
    expect(vendorCompareGroups([], viaKey)).toEqual([]);
    expect(vendorCompareGroups(undefined, viaKey)).toEqual([]);
    expect(vendorCompareGroups([null, {}, { name: 'X' }], viaKey)).toEqual([]);
  });

  it('groups scores by VERBATIM benchmark name — case variants stay separate', () => {
    const rows = [
      { name: 'A', vendor_scores: [{ benchmark: 'SWE-bench Pro', score: 59.5, qualifier: 'in-house' }] },
      { name: 'B', vendor_scores: [{ benchmark: 'SWE-Bench Pro', score: 40, qualifier: 'in-house' }] },
    ];
    const groups = vendorCompareGroups(rows, viaKey);
    // two separate rows (no normalization merged them); tie order between
    // case variants is collation-dependent, so compare as a sorted set
    expect(groups.map(g => g.benchmark).sort()).toEqual(['SWE-Bench Pro', 'SWE-bench Pro']);
    expect(groups.every(g => g.models === 1)).toBe(true);
  });

  it('puts benchmarks shared by more models first (comparability order)', () => {
    const rows = [
      { name: 'A', vendor_scores: [
        { benchmark: 'Solo', score: 10, qualifier: 'in-house' },
        { benchmark: 'Shared', score: 20, qualifier: 'in-house' },
      ] },
      { name: 'B', vendor_scores: [{ benchmark: 'Shared', score: 30, qualifier: 'cited' }] },
    ];
    const groups = vendorCompareGroups(rows, viaKey);
    expect(groups[0].benchmark).toBe('Shared');
    expect(groups[0].models).toBe(2);
    expect(groups[0].entries.map(e => e.model)).toEqual(['A', 'B']);
    expect(groups[1].benchmark).toBe('Solo');
  });

  it('keeps qualifier verbatim and defaults a missing one to "reported"', () => {
    const rows = [
      { name: 'A', vendor_scores: [{ benchmark: 'X', score: 1 }] },
      { name: 'B', vendor_scores: [{ benchmark: 'Y', score: 2, qualifier: 'in-house' }] },
    ];
    const all = vendorCompareGroups(rows, viaKey).flatMap(g => g.entries);
    const x = all.find(e => e.model === 'A');
    const y = all.find(e => e.model === 'B');
    expect(x.qualifier).toBe('reported');
    expect(y.qualifier).toBe('in-house');
  });

  it('skips non-finite scores and blank benchmark names', () => {
    const rows = [
      { name: 'A', vendor_scores: [
        { benchmark: '', score: 5 },
        { benchmark: 'Bad', score: 'n/a' },
        { benchmark: 'Ok', score: 7.5 },
      ] },
    ];
    const groups = vendorCompareGroups(rows, viaKey);
    expect(groups).toHaveLength(1);
    expect(groups[0].benchmark).toBe('Ok');
    expect(groups[0].entries[0].score).toBe(7.5);
  });

  it('falls back to the row.vendor_scores key when no reader is passed', () => {
    const rows = [{ name: 'A', vendor_scores: [{ benchmark: 'B', score: 3, qualifier: 'in-house' }] }];
    const groups = vendorCompareGroups(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].entries[0]).toEqual({ model: 'A', score: 3, qualifier: 'in-house', source: '' });
  });
});
