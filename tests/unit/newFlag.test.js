// stats-27: the NEW badge — release-date predicate (calendar-day window,
// user-adjustable), the meta date index, and the buildMatrix row stamping
// that feeds the Compare rows.
import { describe, it, expect } from 'vitest';
import {
  isNewModel, createdIndexFromMeta, createdForRow,
  newBadgeTitle, NEW_WINDOW_CHOICES, NEW_WINDOW_DEFAULT,
} from '../../src/lib/newFlag.js';
import { buildMatrix } from '../../src/lib/pivot.js';

// Fixed "today" so the calendar-day math is deterministic:
// 2026-09-09T12:00:00Z. A 'YYYY-MM-DD' created string parses as UTC
// midnight, so dayFloor differences are exact calendar days.
const NOW = Date.parse('2026-09-09T12:00:00Z');

const daysAgo = (n) => {
  const d = new Date(NOW - n * 86400000);
  return d.toISOString().slice(0, 10);
};

describe('isNewModel (the windowed release predicate)', () => {
  it('flags models released within the window — boundary inclusive', () => {
    expect(isNewModel(daysAgo(7), NOW, 7)).toBe(true);   // exactly 7 days ago
    expect(isNewModel(daysAgo(6), NOW, 7)).toBe(true);
    expect(isNewModel(daysAgo(0), NOW, 7)).toBe(true);   // today
  });

  it('drops models older than the window', () => {
    expect(isNewModel(daysAgo(8), NOW, 7)).toBe(false);
    expect(isNewModel('2026-01-01', NOW, 7)).toBe(false);
  });

  it('windows 14 / 30 widen honestly', () => {
    expect(isNewModel(daysAgo(8), NOW, 14)).toBe(true);
    expect(isNewModel(daysAgo(15), NOW, 14)).toBe(false);
    expect(isNewModel(daysAgo(30), NOW, 30)).toBe(true);
    expect(isNewModel(daysAgo(31), NOW, 30)).toBe(false);
  });

  it('defaults to the shipped 7-day window from the singleton', () => {
    expect(NEW_WINDOW_DEFAULT).toBe(7);
    expect(NEW_WINDOW_CHOICES).toEqual([7, 14, 30]);
    expect(isNewModel(daysAgo(7), NOW)).toBe(true);
    expect(isNewModel(daysAgo(8), NOW)).toBe(false);
  });

  it('is honest about gaps: no date / bad date / bad window → false', () => {
    expect(isNewModel(null, NOW, 7)).toBe(false);
    expect(isNewModel(undefined, NOW, 7)).toBe(false);
    expect(isNewModel('', NOW, 7)).toBe(false);
    expect(isNewModel('not-a-date', NOW, 7)).toBe(false);
    expect(isNewModel(daysAgo(1), NOW, 0)).toBe(false);
    expect(isNewModel(daysAgo(1), NOW, -5)).toBe(false);
  });
});

describe('createdIndexFromMeta (normKey(or_id)-first, name-fallback)', () => {
  const meta = {
    'Claude Fable 5.1': { or_id: 'anthropic/claude-fable-5.1', created: '2026-09-01' },
    'Some Old Model': { or_id: 'acme/old', created: '2020-01-01' },
    'No Date Model': { or_id: 'acme/nodate' },
    'Id-less': { created: '2026-09-05' },
  };

  it('indexes by normalized API id and meta key', () => {
    const idx = createdIndexFromMeta(meta);
    // normKey('anthropic/claude-fable-5.1') → 'claudefable51': the vendor
    // prefix and every separator are stripped, so catalog ids and listing
    // ids land on the same key
    expect(idx.get('claudefable51')).toBe('2026-09-01');
    expect(idx.get('old')).toBe('2020-01-01');
    expect(idx.get('idless')).toBe('2026-09-05');
  });

  it('skips records without a created date (honest gap)', () => {
    const idx = createdIndexFromMeta(meta);
    expect(idx.has('nodatemodel')).toBe(false);
  });

  it('is null-safe', () => {
    expect(createdIndexFromMeta(null).size).toBe(0);
    expect(createdIndexFromMeta(undefined).size).toBe(0);
    expect(createdIndexFromMeta({}).size).toBe(0);
  });
});

describe('createdForRow (pivot row resolution)', () => {
  const idx = createdIndexFromMeta({
    'Claude Fable 5.1': { or_id: 'anthropic/claude-fable-5.1', created: '2026-09-01' },
  });

  it('first joining id wins, row key is the fallback', () => {
    expect(createdForRow({ ids: ['openrouter/claude-fable-5.1'], key: 'claudefable51' }, idx)).toBe('2026-09-01');
    expect(createdForRow({ ids: ['unrelated/id'], key: 'claudefable51' }, idx)).toBe('2026-09-01');
  });

  it('returns null when nothing joins (honest gap)', () => {
    expect(createdForRow({ ids: ['nope'], key: 'nope' }, idx)).toBeNull();
    expect(createdForRow(null, idx)).toBeNull();
    expect(createdForRow({ ids: [], key: 'x' }, null)).toBeNull();
  });
});

describe('buildMatrix stamps r.created (stats-27 meta pass)', () => {
  const providers = [
    { id: 'openrouter', name: 'OpenRouter', models: [
      { id: 'anthropic/claude-fable-5.1', name: 'Anthropic: Claude Fable 5.1', in: 3, out: 15 },
      { id: 'acme/ancient', name: 'Ancient', in: 1, out: 2 },
    ] },
  ];
  const meta = {
    'Claude Fable 5.1': { or_id: 'anthropic/claude-fable-5.1', created: '2026-09-01' },
    'Ancient': { or_id: 'acme/ancient' }, // no date
  };

  it('stamps the release date on rows that join meta', () => {
    const { rows } = buildMatrix(providers, ['openrouter'], meta);
    const fable = rows.find(r => r.key === 'claudefable51');
    const ancient = rows.find(r => r.key === 'ancient');
    expect(fable.created).toBe('2026-09-01');
    expect(ancient.created).toBeUndefined(); // no date on record → untouched
  });

  it('stamps nothing without meta (2-arg calls stay byte-identical)', () => {
    const { rows } = buildMatrix(providers, ['openrouter']);
    expect(rows.every(r => r.created === undefined)).toBe(true);
  });
});

describe('badge wording lives in one place', () => {
  it('tooltip names the date, the source and the window', () => {
    expect(newBadgeTitle('2026-09-04', 7))
      .toBe('Released 2026-09-04 (per OpenRouter) · flagged NEW for 7 days — change the window with the "New badge" selector');
  });
});
