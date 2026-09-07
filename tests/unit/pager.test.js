// Unit tests for src/lib/pager.js — the shared pagination setting.
// stats-21 keeps ONE page size across every paginated surface (leaderboard,
// Compare pivot, per-provider cards): same options, same default, one
// localStorage key. These lock the migration + sanitization discipline.
import { describe, it, expect } from 'vitest';
import {
  PAGE_ALL,
  DEFAULT_PAGE_SIZE,
  sanitizePageSize,
  readStoredSize,
  clampPage,
  usePageSize,
} from '../../src/lib/pager.js';

describe('sanitizePageSize', () => {
  it('accepts the shipped options (20/50/100/All)', () => {
    expect(sanitizePageSize(20)).toBe(20);
    expect(sanitizePageSize(50)).toBe(50);
    expect(sanitizePageSize(100)).toBe(100);
    expect(sanitizePageSize(PAGE_ALL)).toBe(PAGE_ALL);
  });

  it('folds anything unknown back to the default 50', () => {
    expect(sanitizePageSize(25)).toBe(50);      // stats-20 pivot-only option
    expect(sanitizePageSize(60)).toBe(50);
    expect(sanitizePageSize(NaN)).toBe(50);
    expect(sanitizePageSize(null)).toBe(50);
    expect(sanitizePageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
  });
});

describe('readStoredSize (migration from stats-20 per-table keys)', () => {
  const makeGet = (store) => (k) => (k in store ? store[k] : null);
  const SHARED = 'arena.pagesize';

  it('prefers the shared key when present', () => {
    expect(readStoredSize(makeGet({ [SHARED]: '20' }))).toBe(20);
    expect(readStoredSize(makeGet({ [SHARED]: '0' }))).toBe(PAGE_ALL);
  });

  it('sanitizes a corrupt shared key to the default', () => {
    expect(readStoredSize(makeGet({ [SHARED]: 'bogus' }))).toBe(50);
  });

  it('migrates the legacy home key (20/50/100/All)', () => {
    expect(readStoredSize(makeGet({ 'arena.pagesize.home': '100' }))).toBe(100);
    expect(readStoredSize(makeGet({ 'arena.pagesize.home': '0' }))).toBe(PAGE_ALL);
  });

  it('migrates the legacy pivot key; the old 25 folds to 50', () => {
    expect(readStoredSize(makeGet({ 'arena.pagesize.pivot': '25' }))).toBe(50);
    expect(readStoredSize(makeGet({ 'arena.pagesize.pivot': '100' }))).toBe(100);
  });

  it('defaults to 50 with nothing stored', () => {
    expect(readStoredSize(makeGet({}))).toBe(50);
  });

  it('the shared key wins over any legacy leftovers', () => {
    expect(readStoredSize(makeGet({
      [SHARED]: '20', 'arena.pagesize.home': '100', 'arena.pagesize.pivot': '25',
    }))).toBe(20);
  });
});

describe('clampPage', () => {
  it('keeps the pointer inside 1..totalPages', () => {
    expect(clampPage(3, 5)).toBe(3);
    expect(clampPage(0, 5)).toBe(1);
    expect(clampPage(-1, 5)).toBe(1);
    expect(clampPage(9, 5)).toBe(5);
  });

  it('never divides by a non-positive page count', () => {
    expect(clampPage(2, 0)).toBe(1);
    expect(clampPage(2, -3)).toBe(1);
  });
});

describe('usePageSize singleton', () => {
  it('returns the same ref to every caller (one app-wide setting)', () => {
    expect(usePageSize()).toBe(usePageSize());
  });
});
