// stats-93: unit tests for the measured-elsewhere link map (GDPx / RLI).
// Pure display data — links only, never scores; the contract asserts the
// map stays a closed, hand-verified set.
import { describe, it, expect } from 'vitest';
import { MEASURED_ELSEWHERE, elsewhereFor } from '../../src/lib/measuredElsewhere.js';

describe('measuredElsewhere', () => {
  it('carries exactly the two stats-93 boards with stable urls', () => {
    expect(MEASURED_ELSEWHERE.map(b => b.key)).toEqual(['gdpx', 'rli']);
    expect(MEASURED_ELSEWHERE.map(b => b.url)).toEqual([
      'https://gdpx.semianalysis.com/',
      'https://www.remotelabor.ai/',
    ]);
  });

  it('every board exposes label/url/note and a non-empty model list', () => {
    for (const b of MEASURED_ELSEWHERE) {
      expect(b.label.length).toBeGreaterThan(0);
      expect(b.note.length).toBeGreaterThan(0);
      expect(b.models.length).toBeGreaterThan(0);
      expect(Object.isFrozen(b.models)).toBe(false); // plain data, no runtime trickery
    }
  });

  it('elsewhereFor returns only boards that list the model', () => {
    expect(elsewhereFor('Claude Opus 5.5').map(b => b.key)).toEqual(['gdpx', 'rli']);
    expect(elsewhereFor('GPT-5.2').map(b => b.key)).toEqual(['rli']);
    expect(elsewhereFor('Kimi K3').map(b => b.key)).toEqual(['gdpx']);
    expect(elsewhereFor('Kimi K3.1 Pro')).toEqual([]); // ranked, not on those boards
    expect(elsewhereFor('')).toEqual([]);
    expect(elsewhereFor(undefined)).toEqual([]);
  });

  it('model lists contain no duplicates and no cross-board drift in spellings', () => {
    for (const b of MEASURED_ELSEWHERE) {
      expect(new Set(b.models).size).toBe(b.models.length);
    }
    // shared rows must use the SAME canonical spelling on both boards
    const gdpx = new Set(MEASURED_ELSEWHERE[0].models);
    for (const m of MEASURED_ELSEWHERE[1].models) {
      if (gdpx.has(m) || [...gdpx].some(g => g.toLowerCase() === m.toLowerCase())) {
        expect(gdpx.has(m)).toBe(true);
      }
    }
  });
});
