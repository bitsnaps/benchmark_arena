// ── Value map (stats-31): pure scatter-chart core ────────────────────────
// Ibrahim: "what Chart can we implement to help users find the best LLM
// for budget, maybe something like 'Quality per dollar' in an interactive
// scatter plot, where the user hover to see more useful details, maybe we
// can use the blended price on Y axis and Our score on X axis, but maybe
// we can let the user can change the variables on X and/or Y axis … I'd
// prefer to svg to make things lighter … use our previous calculated data
// to avoid re-calculations".
//
// Everything the Value map view renders is computed HERE as plain data:
//   · the axis metric registry — every metric reads itself off a pivot
//     row through the SAME store accessors the table already uses
//     (scoreFor / clFor / priceFor / valueFor / metaFor …), so the chart
//     can never drift from the leaderboard math — zero recalculation
//   · scale + tick builders (nice linear ticks, 1-2-5 log decades)
//   · point building with the house honesty rules (a missing value is an
//     excluded point, never a fabricated coordinate; free/zero prices are
//     dropped from log axes — free ≠ $0, tiers are rate-limited)
//   · the Pareto "value frontier" — the direct answer to "best LLM for
//     budget": models no other model beats on BOTH axes at once
// No Vue, no DOM, no chart library — unit tests pin the math directly.

import { fmtScore, fmtUsd, fmtSec, fmtCtx, fmtValue } from './format.js';

// ── Axis metric registry ─────────────────────────────────────────────────
// Each metric:
//   id / label   — dropdown entry
//   title        — human axis title (rendered on the chart)
//   scale        — default scale ('linear' | 'log'); the user can flip it
//   better       — which direction is "better" (drives the frontier)
//   zeroFloor    — clamp the linear domain's low end to 0 (naturally
//                  non-negative quantities where 0 is a meaningful bound)
//   fmt          — tick + tooltip formatter
//   get(row, api, now) — the value, or null when unknown. `api` carries
//                  the store accessors (injected so this module stays
//                  pure and testable): scoreFor, clFor, priceFor, valueFor,
//                  metaFor, isOlder, releaseOf, isNew.
export const AXES = {
  score: {
    id: 'score', label: 'Score', title: 'Our Score (CL-weighted)',
    scale: 'linear', better: 'high', zeroFloor: false,
    fmt: (v) => fmtScore(v),
    get: (row, api) => api.scoreFor(row),
  },
  cl: {
    id: 'cl', label: 'Coverage (CL %)', title: 'Coverage Level (CL %)',
    scale: 'linear', better: 'high', zeroFloor: true,
    fmt: (v) => Math.round(v) + '%',
    get: (row, api) => api.clFor(row),
  },
  blend: {
    id: 'blend', label: 'Blended price', title: 'Blended API price, $/1M tokens (3:1 in:out)',
    scale: 'log', better: 'low', zeroFloor: false,
    fmt: (v) => fmtUsd(v),
    get: (row, api) => api.priceFor(row)?.blend ?? null,
  },
  input: {
    id: 'input', label: 'Input price', title: 'Input price, $/1M tokens',
    scale: 'log', better: 'low', zeroFloor: false,
    fmt: (v) => fmtUsd(v),
    get: (row, api) => api.priceFor(row)?.input ?? null,
  },
  output: {
    id: 'output', label: 'Output price', title: 'Output price, $/1M tokens',
    scale: 'log', better: 'low', zeroFloor: false,
    fmt: (v) => fmtUsd(v),
    get: (row, api) => api.priceFor(row)?.output ?? null,
  },
  value: {
    id: 'value', label: 'Value (Score per $)', title: 'Value — Score per 1M blended tokens',
    scale: 'log', better: 'high', zeroFloor: false,
    fmt: (v) => fmtValue(v),
    get: (row, api) => api.valueFor(row),
  },
  ttft: {
    id: 'ttft', label: 'AA TTFT (latency)', title: 'AA median TTFT (seconds)',
    scale: 'log', better: 'low', zeroFloor: false,
    fmt: (v) => fmtSec(v),
    get: (row, api) => api.metaFor(row)?.aa_ttft_seconds ?? null,
  },
  age: {
    id: 'age', label: 'Age (days since release)', title: 'Age (days since release)',
    scale: 'linear', better: 'low', zeroFloor: true,
    fmt: (v) => String(Math.round(v)),
    get: (row, api, now) => {
      const created = api.releaseOf?.(row);
      if (!created) return null;
      const t = Date.parse(String(created));
      if (!Number.isFinite(t)) return null;
      return Math.max(0, ((now ?? Date.now()) - t) / 86400000);
    },
  },
  context: {
    id: 'context', label: 'Context window', title: 'Context window (tokens)',
    scale: 'log', better: 'high', zeroFloor: false,
    fmt: (v) => fmtCtx(v),
    get: (row, api) => api.metaFor(row)?.context_length ?? null,
  },
};

export const X_AXIS_IDS = ['score', 'cl', 'value', 'ttft', 'age'];
export const Y_AXIS_IDS = ['blend', 'input', 'output', 'value', 'ttft', 'context', 'score'];

// Dropdown options (id + label pairs, registry order preserved)
export const axisOptions = (ids) => ids.map((id) => ({ id, label: AXES[id].label }));
export const isAxisId = (v) => !!AXES[v];

// ── Tick builders ────────────────────────────────────────────────────────
// Classic nice-numbers algorithm: step rounded to 1/2/5 × 10^k so linear
// axes never show ticks like $3.7333. Returns ticks spanning [min, max].
export function niceTicks(min, max, count = 6) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) {
    const c = Number.isFinite(min) ? (Number.isFinite(max) ? (min + max) / 2 : min) : 0;
    return [c - 1, c, c + 1].map((v) => Math.round(v * 1e10) / 1e10);
  }
  const raw = (max - min) / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const n = Math.ceil((max - lo) / step);
  const out = [];
  for (let i = 0; i <= n; i++) out.push(Math.round((lo + i * step) * 1e10) / 1e10);
  return out;
}

// Log ticks: 1-2-5 multiples per decade inside [min, max] (widened a
// touch so boundary decades survive float noise). Narrow spans (< 3
// ticks) add 3-7 multiples, then fall back to a geometric linspace so
// even a toy log axis (e.g. score 55–90) gets readable ticks.
export function logTicks(min, max) {
  if (!(max > min) || !(min > 0)) return [];
  const lo = min * 0.999, hi = max * 1.001;
  const collect = (mults) => {
    const out = [];
    const e0 = Math.floor(Math.log10(lo)), e1 = Math.ceil(Math.log10(hi));
    for (let e = e0; e <= e1; e++) {
      for (const m of mults) {
        const v = m * Math.pow(10, e);
        if (v >= lo && v <= hi) out.push(Math.round(v * 1e10) / 1e10);
      }
    }
    return out;
  };
  let ticks = collect([1, 2, 5]);
  if (ticks.length < 3) ticks = collect([1, 2, 3, 5, 7]);
  if (ticks.length < 3) {
    const l0 = Math.log10(lo), l1 = Math.log10(hi);
    for (let i = 0; i < 5; i++) {
      ticks.push(Math.round(Math.pow(10, l0 + ((l1 - l0) * i) / 4) * 1e10) / 1e10);
    }
  }
  return [...new Set(ticks)].sort((a, b) => a - b);
}

// Domain padding. Linear: 6% headroom each side (snapped out to the first
// and last nice tick). Log: multiplicative 1.6× headroom.
export function linearDomain(min, max, metric) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  let lo = min, hi = max;
  if (!(hi > lo)) { lo -= Math.abs(hi || 1) * 0.1 || 1; hi += Math.abs(hi || 1) * 0.1 || 1; }
  const pad = (hi - lo) * 0.06;
  lo -= pad; hi += pad;
  if (metric?.zeroFloor) lo = Math.max(0, lo);
  const t = niceTicks(lo, hi, 6);
  return [Math.min(lo, t[0]), Math.max(hi, t[t.length - 1])];
}

export function logDomain(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(min > 0) || !(max >= min)) return [0.1, 10];
  if (!(max > min)) return [min / 1.6, max * 1.6];
  return [min / 1.6, max * 1.6];
}

// Scale factory: returns a 0..1 fraction mapper + labeled ticks. The view
// multiplies the fraction by the plot span — keeps this module DOM-free.
export function makeScale(metric, min, max, scaleOverride) {
  const scale = scaleOverride ?? metric.scale;
  const [lo, hi] = scale === 'log' ? logDomain(min, max) : linearDomain(min, max, metric);
  if (scale === 'log') {
    const l0 = Math.log10(lo), l1 = Math.log10(hi);
    return {
      lo, hi, scale,
      ticks: logTicks(lo, hi).map((v) => ({ v, label: metric.fmt(v) })),
      frac: (v) => (Math.log10(Math.max(v, Number.MIN_VALUE)) - l0) / (l1 - l0),
    };
  }
  return {
    lo, hi, scale,
    ticks: niceTicks(lo, hi, 6).map((v) => ({ v, label: metric.fmt(v) })),
    frac: (v) => (v - lo) / (hi - lo),
  };
}

// ── Point building (honest-exclusion rules) ─────────────────────────────
// Rows → plottable points for one (x, y) pair. Rules:
//   · older models (superseded / stale) are skipped unless includeOlder —
//     same default as the leaderboard; the view surfaces the count on a
//     toggle instead of silently plotting stale generations
//   · a row whose x OR y value is missing/NaN is excluded and counted in
//     `hidden` (x-reason first) — never fabricated onto the plot
//   · when the effective scale is log, non-positive values are excluded
//     (log of 0 is -Inf; a rate-limited free tier is not "$0 to run")
export function buildScatterPoints(rows, xId, yId, api, { includeOlder = false, now = Date.now(), xScale, yScale } = {}) {
  const mx = AXES[xId], my = AXES[yId];
  if (!mx || !my) return { points: [], hidden: { x: 0, y: 0 }, hiddenTotal: 0 };
  const read = (m, row, eff) => {
    const v = m.get(row, api, now);
    const n = v === null || v === undefined ? NaN : Number(v);
    if (!Number.isFinite(n)) return null;
    if (eff === 'log' && n <= 0) return null;
    return n;
  };
  const points = [];
  const hidden = { x: 0, y: 0 };
  for (const row of rows) {
    if (!row || !row.name) continue;
    if (!includeOlder && api.isOlder?.(row)) continue;
    const x = read(mx, row, xScale ?? mx.scale);
    if (x === null) { hidden.x++; continue; }
    const y = read(my, row, yScale ?? my.scale);
    if (y === null) { hidden.y++; continue; }
    const created = api.releaseOf?.(row) ?? null;
    points.push({
      row, name: row.name, x, y, older: !!api.isOlder?.(row), created,
      isNew: api.isNew ? !!api.isNew(created) : false,
      provider: api.providerOf ? api.providerOf(row) : null,
    });
  }
  return { points, hidden, hiddenTotal: hidden.x + hidden.y };
}

// ── Value frontier (Pareto set) ──────────────────────────────────────────
// A point is on the frontier when NO other point is at least as good on
// both axes and strictly better on one. Directions come from the metric
// registry (`better`), so the same code answers "best score per dollar"
// (score↑ / price↓), "best quality per second of latency" (score↑ /
// ttft↓) or any other pairing the user dials in. Float comparisons use a
// 1e-9 epsilon; exact (x, y) duplicates all stay on the frontier.
export function valueFrontier(points, xBetter = 'high', yBetter = 'low') {
  const eps = 1e-9;
  const good = (v, dir) => (dir === 'low' ? -v : v);
  return points.filter((p, i) => {
    const gx = good(p.x, xBetter), gy = good(p.y, yBetter);
    return !points.some((q, j) => {
      if (i === j) return false;
      const qx = good(q.x, xBetter), qy = good(q.y, yBetter);
      return qx >= gx - eps && qy >= gy - eps && (qx - gx > eps || qy - gy > eps);
    });
  });
}

// Frontier points ordered along X (left → right) for the polyline path.
export function frontierPath(points) {
  return [...points].sort((a, b) => a.x - b.x || a.y - b.y);
}
