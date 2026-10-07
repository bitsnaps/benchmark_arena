// ── stats-60: model grades (S/A/B/C/D tiers) ───────────────────────────
// Ibrahim: group models into categories (A, B, C…) for quick decisions
// instead of exact score comparison. Two approved design rounds:
//
//   · Grading runs on the SAME composite the leaderboard ranks by
//     (scoreForModel), so the badge can never contradict the ranking.
//   · k = 5 clusters (1-D k-means over current rated models), labels
//     S/A/B/C/D from the top. Re-validated on the 2026-10-07 snapshot:
//     bounds 46.5/51.5/57.5/65.0, pyramid 9/13/10/13/4, stable day-over-day.
//   · Boundaries snap to a 0.5 grid; the k-means part is deterministic
//     (quantile seeds — no randomness), so every refresh recomputes the
//     same way and a model's grade only moves when the data does.
//   · Honesty rules (non-negotiable): a model covering fewer than
//     MIN_COVERED_FOR_GRADE of the selected benchmarks is "Unrated" —
//     its score leans mostly on the neutral prior, grading it would be
//     theater. Equal scores can never straddle a boundary (strict >
//     against snapped bounds; a model sitting exactly ON a boundary takes
//     the LOWER grade — never inflated).
//   · Optional feature: three modes — Overall grade (default), Per-axis
//     (Quality · Value · Speed), Off. The mode is a lib singleton (the
//     newWindowDays pattern) persisted per device and synced with the
//     ?tiers= URL param for shareable views.
//
// Per-axis semantics: Quality = the overall grade; Value = grade over the
// value lens (score per 1M blended tokens, same machinery); Speed = the
// shipped TTFT ladder fast/ok/slow (lib/pivot.js latencyTier) — NOT a new
// scale, per the stats-28 "never pin it, never fork a scale" discipline.

import { ref } from 'vue';
import { latencyTier } from './pivot.js';

export const GRADE_LETTERS = ['S', 'A', 'B', 'C', 'D'];
export const GRADE_UNRATED = 'Unrated';
export const TIERS_STORAGE_KEY = 'arena.tiers_mode';
export const TIERS_BOUNDARY_GRID = 0.5;
// Coverage gate: fewer covered benchmarks than this → Unrated (the score is
// mostly neutral prior below half coverage of the shipped 8-core set).
export const MIN_COVERED_FOR_GRADE = 3;

export const TIERS_MODES = [
  {
    id: 'overall',
    label: 'Overall grade',
    desc: 'One S/A/B/C/D grade per model from the global Score (the same CL-weighted composite the leaderboard ranks by).',
  },
  {
    id: 'axis',
    label: 'Per-axis (Quality · Value · Speed)',
    desc: 'Three separate grades: Quality from the global Score, Value from the value lens (Score per $1M blended), Speed from median TTFT (fast/ok/slow).',
  },
  {
    id: 'off',
    label: 'Off',
    desc: 'No grade chips anywhere — exact scores only.',
  },
];
export const TIERS_MODE_DEFAULT = 'overall';
const MODE_IDS = TIERS_MODES.map(m => m.id);

// ── Shared singleton mode state (lib/newFlag.js pattern) ────────────────
function loadMode() {
  try {
    const v = localStorage.getItem(TIERS_STORAGE_KEY);
    return MODE_IDS.includes(v) ? v : TIERS_MODE_DEFAULT;
  } catch { return TIERS_MODE_DEFAULT; } // node tests / private mode
}

export const tiersMode = ref(loadMode());

export function setTiersMode(m) {
  const v = MODE_IDS.includes(m) ? m : TIERS_MODE_DEFAULT;
  tiersMode.value = v;
  try {
    if (v === TIERS_MODE_DEFAULT) localStorage.removeItem(TIERS_STORAGE_KEY);
    else localStorage.setItem(TIERS_STORAGE_KEY, v);
  } catch { /* private mode — session-only */ }
}

// ?tiers= deep link: accepts one of the mode ids. Unknown values are
// ignored (return false) so stale share links never corrupt state.
export function applyTiersParam(param) {
  if (typeof param !== 'string' || !MODE_IDS.includes(param)) return false;
  setTiersMode(param);
  return true;
}

// ── Deterministic 1-D k-means (quantile seeds — no randomness) ─────────
// Sorts, seeds k centers from DISTINCT values at floor-based quantiles
// (never two identical seeds — zero-width clusters would park a boundary
// exactly on the top score), then runs Lloyd's algorithm to convergence.
// Equal converged centers are still harmless: gradeIndexOf stays monotone.
export function kmeans1d(values, k = GRADE_LETTERS.length) {
  const xs = (Array.isArray(values) ? values : [])
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!xs.length || !(k >= 1)) return [];
  const uniq = [...new Set(xs)];
  const kk = Math.min(k, uniq.length);
  const centers = [];
  for (let i = 0; i < kk; i++) {
    centers.push(uniq[Math.min(uniq.length - 1, Math.floor(((i + 0.5) * uniq.length) / kk))]);
  }
  for (let iter = 0; iter < 100; iter++) {
    const groups = centers.map(() => []);
    for (const x of xs) {
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < centers.length; i++) {
        const d = Math.abs(x - centers[i]);
        if (d < bd) { bd = d; best = i; }
      }
      groups[best].push(x);
    }
    let moved = false;
    for (let i = 0; i < centers.length; i++) {
      if (!groups[i].length) continue;
      const m = groups[i].reduce((a, b) => a + b, 0) / groups[i].length;
      if (Math.abs(m - centers[i]) > 1e-9) { centers[i] = m; moved = true; }
    }
    if (!moved) break;
  }
  return [...centers].sort((a, b) => a - b);
}

// Cluster centers → snapped boundary values (midpoints on the 0.5 grid).
export function gradeBounds(centers, grid = TIERS_BOUNDARY_GRID) {
  const cs = [...centers].sort((a, b) => a - b);
  return cs.slice(0, -1).map((c, i) => Math.round((c + cs[i + 1]) / 2 / grid) * grid);
}

// Pure: score → tier index (0 = best). STRICT > against snapped bounds:
// equal scores always land on the same side (ties never split), and a
// score exactly on a boundary takes the LOWER grade — never inflated.
export function gradeIndexOf(score, bounds) {
  let g = 0;
  for (const b of bounds || []) if (score > b) g++;
  return g;
}

// Build the grade maps for one snapshot state. Pure apart from consuming
// the store's reactive accessors; re-runs whenever data or the Avg set
// changes (the composite follows the selection by design).
//   { rows, scoreOf, valueOf, coverageOf, minCoverage? } →
//   { overall: { bounds, letters: Map(name → 'S'..'D') },
//     value:   { bounds, letters: Map(name → 'S'..'D') } }
// Rows outside the maps (no metric / below the coverage gate) resolve to
// no grade — the UI renders them as Unrated (overall) or omits the chip
// (per-axis Value/Speed honest gaps).
export function computeGradeMaps({
  rows, scoreOf, valueOf, coverageOf,
  minCoverage = MIN_COVERED_FOR_GRADE,
  k = GRADE_LETTERS.length,
}) {
  const build = (metric) => {
    const rated = [];
    const seen = new Set();
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || !r.name || seen.has(r.name)) continue;
      seen.add(r.name);
      const v = metric(r);
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      const cov = coverageOf ? coverageOf(r) : minCoverage;
      if (!(cov >= minCoverage)) continue;
      rated.push([r.name, v]);
    }
    const distinct = new Set(rated.map(([, v]) => v)).size;
    const letters = new Map();
    if (distinct < 2) return { bounds: null, letters }; // nothing separable
    const centers = kmeans1d(rated.map(([, v]) => v), Math.min(k, distinct));
    const bounds = gradeBounds(centers);
    // gradeIndexOf counts boundaries from the BOTTOM (0 = lowest scores);
    // the letter ladder runs the other way (S = best). Anchoring the TOP
    // cluster to S: with kk clusters the board spans the top kk letters —
    // data that supports only 2 separable tiers grades S/A, never C/D.
    const kk = centers.length;
    for (const [name, v] of rated) {
      letters.set(name, GRADE_LETTERS[(kk - 1) - gradeIndexOf(v, bounds)]);
    }
    return { bounds, letters };
  };
  return {
    overall: build(scoreOf),
    value: build(valueOf),
  };
}

// Per-row speed tier: the shipped TTFT ladder (fast/ok/slow) or null when
// no median TTFT is on record — an honest gap, never fabricated.
export function speedTierFor(ttftSeconds) {
  return latencyTier(ttftSeconds);
}

// ── Wording (one place, asserted by tests) ──────────────────────────────
export function gradeTitle(letter, bounds) {
  if (letter === GRADE_UNRATED) {
    return `Unrated — this model covers fewer than ${MIN_COVERED_FOR_GRADE} of the selected benchmarks (or has no score at all), so its composite leans mostly on the neutral prior. Grading it would be theater, so we don't.`;
  }
  const b = (bounds || []).map(x => x.toFixed(1)).join(' / ');
  return `Grade ${letter} — k-means (k=5) on the CL-weighted Score of every rated current model, boundaries snapped to 0.5 (${b}). The grade re-computes with every data refresh and follows the Avg-set selection; a model sitting exactly on a boundary takes the lower grade.`;
}

export function valueGradeTitle(letter, bounds) {
  const b = (bounds || []).map(x => x.toFixed(1)).join(' / ');
  return `Value grade ${letter} — k-means (k=5) on the value lens (Score per 1M blended tokens; free tiers excluded), boundaries snapped to 0.5 (${b}). Omitted entirely when the model has no Score or no API price — never fabricated.`;
}

export const SPEED_TIER_TITLE =
  'Speed tier — the shipped TTFT ladder (fast < 1.5s · ok < 3.5s · slow ≥ 3.5s) over Artificial Analysis median time-to-first-token. No measurement on record → no Speed chip (honest gap).';

export const TIERS_METHOD_NOTE =
  'Grades come from 1-D k-means (k=5) over the CL-weighted Score of every rated model — the same composite the leaderboard ranks by, re-computed with each refresh. Boundaries snap to 0.5; equal scores never split across a grade; models covering fewer than 3 selected benchmarks (or with no score) show Unrated. Optional: switch to per-axis grades (Quality · Value · Speed) or turn tiers off — the choice is saved per device.';
