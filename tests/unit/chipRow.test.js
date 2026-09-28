// Unit tests for src/lib/chipRow.js — the stats-52 Compare picker collapse.
// Pure-function tests: the selected∪floor partition, weight padding with
// stable registry-order ties, and the malformed-input guarantees.
import { describe, it, expect } from 'vitest';
import { pickVisibleChips, CHIP_FLOOR } from '../../src/lib/chipRow.js';

const chip = (id, n = 0) => ({ id, n });
const ids = (out) => out.map(c => c.id);

describe('CHIP_FLOOR', () => {
  it('is the approved 6-chip floor', () => {
    expect(CHIP_FLOOR).toBe(6);
  });
});

describe('pickVisibleChips — the selected∪floor partition', () => {
  const list = [
    chip('a', 10), chip('b', 300), chip('c', 5), chip('d', 200),
    chip('e', 1), chip('f', 50), chip('g', 40), chip('h', 30),
    chip('i', 20), chip('j', 2),
  ];

  it('pads to the floor with the BIGGEST unselected chips', () => {
    // nothing selected → top-6 by weight: b300 d200 f50 g40 h30 i20
    expect(ids(pickVisibleChips(list, new Set()))).toEqual(['b', 'd', 'f', 'g', 'h', 'i']);
  });

  it('renders the visible set in REGISTRY order, never weight order', () => {
    // 'a' is small but first — the row must not jump when weights differ
    const out = pickVisibleChips(list, new Set(['a']));
    expect(ids(out)).toEqual(['a', 'b', 'd', 'f', 'g', 'h']); // a's seat + 5 biggest
  });

  it('selected chips ALWAYS keep a seat, even tiny ones', () => {
    const out = pickVisibleChips(list, new Set(['e', 'j', 'c']));
    expect(ids(out)).toEqual(['b', 'c', 'd', 'e', 'f', 'j']); // 3 selected + 3 padded, registry order
    expect(out.filter(c => ['e', 'j', 'c'].includes(c.id)).length).toBe(3);
  });

  it('selected ≥ floor → every selected chip, nothing padded', () => {
    const sel = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(ids(pickVisibleChips(list, sel))).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  it('selection larger than the floor stays fully visible (8 default columns)', () => {
    const big = Array.from({ length: 40 }, (_, i) => chip('p' + i, 100 - i));
    const sel = new Set(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
    expect(ids(pickVisibleChips(big, sel, CHIP_FLOOR))).toEqual([
      'p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7',
    ]);
  });

  it('floor ≥ list length → the whole list', () => {
    const small = [chip('x', 1), chip('y', 2)];
    expect(ids(pickVisibleChips(small, new Set(), 6))).toEqual(['x', 'y']);
  });

  it('weight ties break by registry order (stable sort)', () => {
    const tied = [chip('t1', 7), chip('t2', 7), chip('t3', 7), chip('t4', 7),
      chip('t5', 7), chip('t6', 7), chip('t7', 7), chip('t8', 7)];
    expect(ids(pickVisibleChips(tied, new Set()))).toEqual(['t1', 't2', 't3', 't4', 't5', 't6']);
  });

  it('custom weight accessor (e.g. matched-model counts)', () => {
    const rows = [{ id: 'w1', n: 3 }, { id: 'w2', n: 9 }, { id: 'w3', n: 1 },
      { id: 'w4', n: 8 }, { id: 'w5', n: 7 }, { id: 'w6', n: 6 }, { id: 'w7', n: 5 }];
    const out = pickVisibleChips(rows, new Set(['w1']), CHIP_FLOOR, c => c.n);
    expect(ids(out)).toEqual(['w1', 'w2', 'w4', 'w5', 'w6', 'w7']); // w1's seat + top-5
  });

  it('selected ids absent from the list are ignored (no phantom seats)', () => {
    expect(ids(pickVisibleChips(list, new Set(['ghost', 'a'])))).toEqual(['a', 'b', 'd', 'f', 'g', 'h']);
  });
});

describe('pickVisibleChips — never throws', () => {
  it('null / undefined / garbage chips render nothing', () => {
    expect(pickVisibleChips(null, new Set())).toEqual([]);
    expect(pickVisibleChips(undefined, new Set())).toEqual([]);
    expect(pickVisibleChips('nope', new Set())).toEqual([]);
    expect(pickVisibleChips([null, undefined, 42, chip('ok', 1)], new Set())).toEqual([
      expect.objectContaining({ id: 'ok' }),
    ]);
  });

  it('non-Set selections degrade safely; NaN weights rank last', () => {
    // registry order wins on return: 'a' precedes 'b' in the list
    expect(ids(pickVisibleChips([chip('a', NaN), chip('b', 1)], ['b']))).toEqual(['a', 'b']);
    expect(ids(pickVisibleChips([chip('a')], null))).toEqual(['a']); // weight defaults to 0 → still visible at floor
  });

  it('floor 0 → selected only; negative/garbage floor falls back to 6', () => {
    const list = [chip('a', 1), chip('b', 2)];
    expect(ids(pickVisibleChips(list, new Set(['a']), 0))).toEqual(['a']);
    expect(pickVisibleChips(list, new Set(), -3)).toHaveLength(2); // fallback floor 6 ≥ 2
    expect(pickVisibleChips(list, new Set(), 'x')).toHaveLength(2);
  });
});
