// Unit tests for src/lib/priceFilter.js — the shared pricing-filter core
// (stats-23). One contract for every seller-side surface: the By-provider
// tab, the Compare pivot (via filterMatrix in pivot.js) and any future
// adopter must all filter identically. Pure-function tests on hand-built
// fixtures: no snapshot, no browser.
import { describe, it, expect } from 'vitest';
import {
  SLIDER_EXP,
  capFromSlider,
  passesPricing,
  priceUniverseBlend,
  usePriceFilter,
} from '../../src/lib/priceFilter.js';

describe('capFromSlider (slider position → $/1M cap)', () => {
  it('treats the top position as "any price" (null = no cap)', () => {
    expect(capFromSlider(100, 8)).toBe(null);
    expect(capFromSlider(100, 0.5)).toBe(null);
  });

  it('maps the bottom position to $0 (free listings survive, priced do not)', () => {
    expect(capFromSlider(0, 8)).toBe(0);
  });

  it('maps the midpoint cubically onto the universe max', () => {
    // 8 * (50/100)^3 = 8 * 0.125 = 1
    expect(capFromSlider(50, 8)).toBe(1);
    expect(SLIDER_EXP).toBe(3);
  });

  it('rounds to cents so the label never shows floating dust', () => {
    // 3 * (25/100)^3 = 0.046875 → 0.05
    expect(capFromSlider(25, 3)).toBe(0.05);
  });

  it('clamps the universe scale to ≥ $1 so pre-load states stay sane', () => {
    expect(capFromSlider(50, 0.4)).toBe(0.13); // scale clamps 0.4 → 1, then cents-rounds
    expect(capFromSlider(50, undefined)).toBe(0.13);
  });
});

describe('passesPricing (THE shared filter contract)', () => {
  const opts = (freeOnly, maxPrice) => ({ freeOnly, maxPrice });

  it('passes everything when no filter is active (default state)', () => {
    expect(passesPricing({}, { blend: null, free: false }, opts(false, null))).toBe(true);
    expect(passesPricing({}, { blend: 42, free: true }, opts(false, null))).toBe(true);
  });

  it('freeOnly keeps only rows with a free listing', () => {
    expect(passesPricing({}, { blend: 0, free: true }, opts(true, null))).toBe(true);
    expect(passesPricing({}, { blend: 5, free: false }, opts(true, null))).toBe(false);
  });

  it('maxPrice caps the blend; free rows survive any cap (the $0 rule lives in the predicate)', () => {
    expect(passesPricing({}, { blend: 5, free: false }, opts(false, 10))).toBe(true);
    expect(passesPricing({}, { blend: 5, free: false }, opts(false, 4))).toBe(false);
    expect(passesPricing({}, { blend: 0, free: true }, opts(false, 0))).toBe(true);
    // free survives even if a caller forgot to blend it to $0
    expect(passesPricing({}, { blend: 9, free: true }, opts(false, 0))).toBe(true);
  });

  it('hides unpriced rows only while a price cap is active', () => {
    expect(passesPricing({}, { blend: null, free: false }, opts(false, null))).toBe(true);
    expect(passesPricing({}, { blend: null, free: false }, opts(false, 100))).toBe(false);
    expect(passesPricing({}, { blend: null, free: true }, opts(false, 100))).toBe(true);
  });

  it('composes freeOnly + maxPrice', () => {
    expect(passesPricing({}, { blend: 0, free: true }, opts(true, 3))).toBe(true);
    expect(passesPricing({}, { blend: 1, free: false }, opts(true, 3))).toBe(false);
    expect(passesPricing({}, { blend: null, free: true }, opts(true, 3))).toBe(true);
  });
});

describe('usePriceFilter (shared singleton state)', () => {
  it('defaults to no filtering: any price, free-only off', () => {
    const { freeOnly, sliderVal, maxPrice, maxPriceLabel } = usePriceFilter();
    expect(freeOnly.value).toBe(false);
    expect(sliderVal.value).toBe(100);
    expect(maxPrice.value).toBe(null);
    expect(maxPriceLabel.value).toBe('any price');
  });

  it('maps the slider through the universe scale and labels the cap', () => {
    const prevBlend = priceUniverseBlend.value;
    const { sliderVal, maxPrice, maxPriceLabel } = usePriceFilter();
    try {
      priceUniverseBlend.value = 8;
      sliderVal.value = 50;
      expect(maxPrice.value).toBe(1);
      expect(maxPriceLabel.value).toBe('≤ $1/1M blended');
      sliderVal.value = 0;
      expect(maxPrice.value).toBe(0);
      expect(maxPriceLabel.value).toBe('≤ $0/1M blended');
    } finally {
      sliderVal.value = 100; // restore the singleton for other suites
      priceUniverseBlend.value = prevBlend;
    }
  });

  it('state is shared: every usePriceFilter() call sees the same refs', () => {
    const a = usePriceFilter();
    const b = usePriceFilter();
    expect(a.freeOnly).toBe(b.freeOnly);
    expect(a.sliderVal).toBe(b.sliderVal);
  });
});
