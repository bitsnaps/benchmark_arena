// stats-24: AA median TTFT rendering — the latency join in buildMatrix,
// the fmtSec formatting, and the tier ladder they feed.
import { describe, it, expect } from 'vitest';
import { fmtSec } from '../../src/lib/format.js';
import { latencyTier, latencyClass } from '../../src/lib/pivot.js';

describe('fmtSec (seconds → tooltip/card text)', () => {
  it('keeps sub-10s precision at 2 decimals', () => {
    expect(fmtSec(0.376)).toBe('0.38 s');
    expect(fmtSec(2.7)).toBe('2.70 s');
    expect(fmtSec(6.548)).toBe('6.55 s');
  });

  it('steps down precision as values grow', () => {
    expect(fmtSec(28.653)).toBe('28.7 s');
    expect(fmtSec(161.647)).toBe('162 s');
  });

  it('is null-safe', () => {
    expect(fmtSec(null)).toBe('—');
    expect(fmtSec(undefined)).toBe('—');
    expect(fmtSec('oops')).toBe('—');
  });
});

describe('tier boundaries the tint legend documents', () => {
  it('1.5 s and 3.5 s are the cut lines', () => {
    expect(latencyTier(1.499)).toBe('fast');
    expect(latencyTier(1.5)).toBe('ok');
    expect(latencyTier(3.499)).toBe('ok');
    expect(latencyTier(3.5)).toBe('slow');
    expect(latencyClass(3.5)).toBe('lat-slow');
  });
});
