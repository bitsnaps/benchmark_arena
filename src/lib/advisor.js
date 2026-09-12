// ── Use-case advisor: pure scoring core (stats-33) ────────────────────
// Deterministic client-side ranking over the benchmark snapshot. No Vue,
// no store, no DOM — every function here is unit-testable in isolation
// (tests/unit/advisor.test.js) and every number it produces is traceable
// to benchmark_results.json through the same formulas the site uses.
//
// Spec: docs/spec-usecase-advisor.md. Key contracts:
//   · profile scores use the leaderboard's coverage-weighted mean
//     (w·raw + (1−w)·50) — with the 8 core benchmarks as the bench subset
//     this reproduces the store's scoreForModel EXACTLY (parity test).
//   · unknowns never penalize: per-model weight renormalization over the
//     components that actually have data; unknowns surface as flags.
//   · cost/space scores are log-normalized across the current candidate
//     pool (prices span ~3 orders of magnitude — linear would flatten).
//   · candidates are current-generation only — the VIEW filters
//     isOlder() rows before calling into this lib (advising a superseded
//     model is bad advice by definition).

import { SCORE_PRIOR, WEIGHTS, CTX_LADDER, CAP_LADDER } from '../config/advisorProfiles.js';
import { fmtUsd, fmtSec, fmtScore } from './format.js';

// ── Profile score (coverage-weighted sparse mean over a bench subset) ─
// Mirrors stores/data.js scoreForModel but parameterized by the profile's
// benchmark subset: raw = plain mean of the scores the model actually has
// on the subset; w = covered/total; score = w·raw + (1−w)·SCORE_PRIOR.
// Uncovered benches are "no evidence" (regress to the prior), never zero.
export function profileScoreFor(row, benches) {
  const vals = [];
  for (const b of benches) {
    const v = row?.[b];
    if (v !== null && v !== undefined) vals.push(v);
  }
  const covered = vals.length;
  if (!covered) return { score: null, covered: 0 };
  const raw = vals.reduce((a, b) => a + b, 0) / covered;
  const w = Math.min(1, Math.max(0, covered / benches.length));
  return { score: w * raw + (1 - w) * SCORE_PRIOR, covered };
}

// Quality tag for a candidate given its profile coverage
// (≥2 = solid, 1 = thin, 0 = the view falls back to the core Score).
export function coverageTag(covered) {
  return covered >= 2 ? 'solid' : covered === 1 ? 'thin' : 'limited';
}

// ── Weight lookup: the 9-cell priority × speed table ──────────────────
export function weightFor(priority, speed) {
  return (WEIGHTS[priority] && WEIGHTS[priority][speed]) || WEIGHTS.balanced.ok;
}

// ── Log-scale normalization references over the candidate pool ────────
// pMin/pMax from candidates with a known positive blended price, tMin/tMax
// from known positive TTFTs. Null when no candidate has data (the score
// then treats every candidate as best-in-class for that component).
export function normalizeParams(cands) {
  const blends = cands.map(c => c.blend).filter(v => typeof v === 'number' && v > 0);
  const ttfts = cands.map(c => c.ttft).filter(v => typeof v === 'number' && v > 0);
  return {
    pMin: blends.length ? Math.min(...blends) : null,
    pMax: blends.length ? Math.max(...blends) : null,
    tMin: ttfts.length ? Math.min(...ttfts) : null,
    tMax: ttfts.length ? Math.max(...ttfts) : null,
  };
}

// Cost score ∈ [0,1]: 1 = cheapest known (a free listing is always 1),
// 0 = priciest. Unknown price → null (component simply doesn't vote).
export function costScoreOf(blend, norm) {
  if (typeof blend !== 'number' || !Number.isFinite(blend)) return null;
  if (blend <= 0) return 1;
  const { pMin, pMax } = norm;
  if (pMin === null || pMax === null || pMax <= 0) return 1;
  if (pMax === pMin) return 1; // degenerate spread — this IS the cheapest known
  const t = (Math.log1p(blend) - Math.log1p(pMin)) / (Math.log1p(pMax) - Math.log1p(pMin));
  return 1 - Math.min(1, Math.max(0, t));
}

// Speed score ∈ [0,1]: 1 = fastest known TTFT. Unknown → null.
export function speedScoreOf(ttft, norm) {
  if (typeof ttft !== 'number' || !Number.isFinite(ttft) || ttft <= 0) return null;
  const { tMin, tMax } = norm;
  if (tMin === null || tMax === null) return 1;
  if (tMax === tMin) return 1;
  const t = (Math.log1p(ttft) - Math.log1p(tMin)) / (Math.log1p(tMax) - Math.log1p(tMin));
  return 1 - Math.min(1, Math.max(0, t));
}

// ── Composite with per-model weight renormalization ───────────────────
// Quality is always known (no-score candidates are excluded by the view
// before ranking). Cost/speed join when present; missing components
// renormalize the weights so an unknown never penalizes. Cost/speed live
// on a 0-1 scale and are scaled ×100 to blend with the 0-100 quality.
export function compositeOf(cand, weights, norm) {
  const q = cand.quality;
  const c = costScoreOf(cand.blend, norm);
  const s = speedScoreOf(cand.ttft, norm);
  let num = weights.q * q;
  let den = weights.q;
  if (c !== null) { num += weights.c * c * 100; den += weights.c; }
  if (s !== null) { num += weights.s * s * 100; den += weights.s; }
  return {
    score: den > 0 ? num / den : null,
    used: { q: true, c: c !== null, s: s !== null },
  };
}

// ── Hard constraints ──────────────────────────────────────────────────
// eff = { ctx, vision, open, cap, strict }. Contract (spec §4.7): an
// UNKNOWN value passes with a flag by default and drops in strict mode;
// a KNOWN disqualifying value always drops. Open-weights membership is
// exact (every row is closed or open tier) so it never has unknowns.
// The free-listing $0 rule matches the leaderboard's filterPriceFor().
export function passConstraints(cand, eff) {
  const flags = [];
  const drop = { pass: false, flags };
  if (eff.ctx > 0) {
    if (cand.ctx === null || cand.ctx === undefined) {
      if (eff.strict) return drop;
      flags.push('context unlisted');
    } else if (cand.ctx < eff.ctx) return drop;
  }
  if (eff.vision) {
    if (cand.vision === null || cand.vision === undefined) {
      if (eff.strict) return drop;
      flags.push('vision unlisted');
    } else if (!cand.vision) return drop;
  }
  if (eff.open === 'open' && !cand.open) return drop;
  if (eff.open === 'api' && cand.open) return drop;
  if (eff.cap > 0) {
    if (cand.free) {
      // free listing counts as $0 — survives any cap (same rule as the
      // leaderboard's price filter)
    } else if (cand.blend === null || cand.blend === undefined) {
      if (eff.strict) return drop;
      flags.push('price unlisted');
    } else if (cand.blend > eff.cap) return drop;
  }
  return { pass: true, flags };
}

// Survivors of a constraint pass (used by both ranking and the hint).
export function survivors(cands, eff) {
  const kept = [];
  const flagsByCand = new Map();
  for (const c of cands) {
    const r = passConstraints(c, eff);
    if (r.pass) {
      kept.push(c);
      if (r.flags.length) flagsByCand.set(c.name, r.flags);
    }
  }
  return { kept, flagsByCand };
}

// ── Ranking ───────────────────────────────────────────────────────────
// Sort: composite desc → profile coverage desc → blended price asc
// (unknown = +∞) → newest release first. Returns new array, no mutation.
export function rankCandidates(cands, weights, norm) {
  const scored = cands.map(c => ({ cand: c, ...compositeOf(c, weights, norm) }));
  return scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const cov = (b.cand.covered ?? 0) - (a.cand.covered ?? 0);
    if (cov) return cov;
    const pb = typeof b.cand.blend === 'number' ? b.cand.blend : Infinity;
    const pa = typeof a.cand.blend === 'number' ? a.cand.blend : Infinity;
    if (pa !== pb) return pa - pb;
    const cb = Date.parse(b.cand.created || '') || 0;
    const ca = Date.parse(a.cand.created || '') || 0;
    return cb - ca;
  });
}

// ── Generated reasons (deterministic order, max 3) + data flags ───────
// ranked = output of rankCandidates; item = one of its entries.
export function buildReasons(ranked, item, profileLabel, max = 3) {
  const i = ranked.indexOf(item);
  const top = ranked[0];
  const reasons = [];

  if (i === 0 && ranked.length > 1) {
    reasons.push(`Best ${profileLabel} fit in this shortlist`);
  } else if (top && top !== item && typeof top.cand.blend === 'number'
    && typeof item.cand.blend === 'number' && item.cand.blend > 0
    && top.cand.blend / item.cand.blend >= 1.5) {
    const d = (top.score ?? 0) - (item.score ?? 0);
    reasons.push(`${(top.cand.blend / item.cand.blend).toFixed(1)}× cheaper than #1 at −${d.toFixed(1)} pts`);
  }

  const withPrice = ranked.filter(r => typeof r.cand.blend === 'number');
  if (withPrice.length > 1) {
    const cheapest = withPrice.reduce((a, b) => (b.cand.blend < a.cand.blend ? b : a));
    if (cheapest === item) {
      reasons.push(item.cand.blend === 0
        ? 'Free listing available'
        : `Cheapest in the shortlist (${fmtUsd(item.cand.blend)}/1M blended)`);
    }
  }

  const withTtft = ranked.filter(r => typeof r.cand.ttft === 'number' && r.cand.ttft > 0);
  if (withTtft.length > 1) {
    const fastest = withTtft.reduce((a, b) => (b.cand.ttft < a.cand.ttft ? b : a));
    if (fastest === item) reasons.push(`Fastest listed TTFT (${fmtSec(item.cand.ttft)})`);
  }

  if (item.cand.open) reasons.push('Open weights');
  if (item.cand.free && !reasons.some(r => r === 'Free listing available')) {
    reasons.push('Free listing available');
  }

  return reasons.slice(0, max);
}

// Data flags for a ranked item: coverage tag first, then constraint flags.
export function buildFlags(item, constraintFlags) {
  const flags = [];
  if (item.cand.tag === 'limited') flags.push('limited data — showing general score');
  else if (item.cand.tag === 'thin') flags.push('thin profile coverage');
  for (const f of constraintFlags || []) {
    if (!flags.includes(f)) flags.push(f);
  }
  if (item.cand.ttft === null && item.used && !item.used.s) {
    if (!flags.includes('TTFT unlisted')) flags.push('TTFT unlisted');
  }
  return flags;
}

// ── Empty-state hint (P1) ─────────────────────────────────────────────
// Try every one-notch relaxation of the constraint set; surface whichever
// admits the most additional models. Deterministic. Returns null when the
// copy should stay generic (no relaxation helps).
function oneNotchRelaxations(eff) {
  const out = [];
  // CAP_LADDER is the UI ladder [0=none, 1, 4, 12]; walking 1→4→12→0 is
  // the one-notch relaxation order (0 terminates).
  const CAP_RELAX_ORDER = [1, 4, 12, 0];
  const capIdx = CAP_RELAX_ORDER.indexOf(eff.cap);
  if (eff.cap > 0 && capIdx >= 0 && capIdx < CAP_RELAX_ORDER.length - 1) {
    const v = CAP_RELAX_ORDER[capIdx + 1];
    out.push({
      label: v > 0 ? `relaxing the price cap to $${v}/1M` : 'dropping the price cap',
      eff: { ...eff, cap: v },
    });
  }
  const ctxIdx = CTX_LADDER.indexOf(eff.ctx);
  if (eff.ctx > 0 && ctxIdx > 0) {
    out.push({ label: `allowing ${fmtCtxOf(CTX_LADDER[ctxIdx - 1])} context`, eff: { ...eff, ctx: CTX_LADDER[ctxIdx - 1] } });
  }
  if (eff.vision) out.push({ label: 'dropping the vision requirement', eff: { ...eff, vision: false } });
  if (eff.open === 'open') out.push({ label: 'allowing hosted API models', eff: { ...eff, open: 'any' } });
  else if (eff.open === 'api') out.push({ label: 'allowing open-weight models', eff: { ...eff, open: 'any' } });
  if (eff.strict) out.push({ label: 'turning off strict mode', eff: { ...eff, strict: false } });
  return out;
}

function fmtCtxOf(n) {
  if (!n) return 'any';
  if (n >= 1000000) return (n / 1000000) + 'M';
  return Math.round(n / 1000) + 'K';
}

export function emptyStateHint(cands, eff) {
  const base = survivors(cands, eff).kept.length;
  let best = null;
  for (const r of oneNotchRelaxations(eff)) {
    const n = survivors(cands, r.eff).kept.length - base;
    if (n > 0 && (!best || n > best.n)) best = { n, label: r.label };
  }
  if (!best) return null;
  return `No model fits those constraints. ${best.label.charAt(0).toUpperCase()}${best.label.slice(1)} would add ${best.n} option${best.n === 1 ? '' : 's'}.`;
}

// Display helper for the composite (0-100 scale, 1 dp like the leaderboard)
export function fmtComposite(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return fmtScore(Math.round(v * 10) / 10);
}
