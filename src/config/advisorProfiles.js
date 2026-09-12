// ── Use-case advisor: static configuration (stats-33) ─────────────────
// Data, not logic — every tunable of the advisor lives here so adjusting
// the wizard is a config change, never a code change. The scoring itself
// is in src/lib/advisor.js; the UI is src/views/AdvisorView.vue.
//
// Design ethos (spec: docs/spec-usecase-advisor.md): the advisor is a
// re-weighted leaderboard, not a heuristic. Profiles are subsets of the
// snapshot's own benchmark columns; the composite blends profile quality
// with cost and speed through the fixed weight table below.

// Neutral baseline the coverage-weighted score regresses to (same prior
// as the leaderboard's Score — stores/data.js scoreForModel).
export const SCORE_PRIOR = 50;

// ── Use-case profiles ─────────────────────────────────────────────────
// benches: benchmark column names as they appear in benchmark_results.json.
// visionLock: profile hard-requires image input (user may still see the
// constraint pre-set on step 2; it cannot be turned off for this profile).
// Coverage today (non-null cells / 115 rows) drives the coverage-tag rule
// in the lib — FrontierSWE (9) and Design Arena (18) are the thin columns.
export const PROFILES = {
  coding: {
    id: 'coding',
    label: 'Coding',
    icon: 'fa-code',
    blurb: 'Building features, fixing bugs, security work, long refactors.',
    benches: ['DeepSWE', 'SWE-Marathon', 'FrontierSWE', 'CyberGem'],
  },
  agentic: {
    id: 'agentic',
    label: 'Agentic workflows',
    icon: 'fa-robot',
    blurb: 'Long-horizon tool use, planning and simulated business work.',
    benches: ['VendingBench', 'SWE-Marathon', 'ARC-AGI-2'],
  },
  reasoning: {
    id: 'reasoning',
    label: 'Hard reasoning',
    icon: 'fa-brain',
    blurb: 'Abstraction and memorization-proof puzzles.',
    benches: ['ARC-AGI-2', 'SimpleBench.com'],
  },
  chat: {
    id: 'chat',
    label: 'Everyday chat',
    icon: 'fa-comments',
    blurb: 'Assistants, drafting and everyday Q&A feel.',
    benches: ['Arena.ai Text', 'BenchLM.ai', 'Artificial Analysis'],
  },
  creative: {
    id: 'creative',
    label: 'Creative writing',
    icon: 'fa-pen-nib',
    blurb: 'Stories, copy, voice and style work.',
    benches: ['EQBench CW', 'Design Arena'],
  },
  vision: {
    id: 'vision',
    label: 'Vision & media',
    icon: 'fa-eye',
    blurb: 'Understanding images and generating UI. Coverage still thin.',
    benches: ['Design Arena'],
    visionLock: true,
  },
};

// ── Priority × speed weight table (all 9 combos, each sums to 1) ─────
// q = profile quality, c = cost, s = speed. "Snappy" shifts weight from
// quality+cost into speed; "think as long as you want" zeroes speed and
// redistributes it proportionally to the q:c ratio.
export const WEIGHTS = {
  'cost-first': {
    fast: { q: 0.38, c: 0.42, s: 0.20 },
    ok: { q: 0.45, c: 0.45, s: 0.10 },
    slow: { q: 0.50, c: 0.50, s: 0.00 },
  },
  balanced: {
    fast: { q: 0.53, c: 0.27, s: 0.20 },
    ok: { q: 0.60, c: 0.30, s: 0.10 },
    slow: { q: 0.70, c: 0.30, s: 0.00 },
  },
  'quality-first': {
    fast: { q: 0.73, c: 0.12, s: 0.15 },
    ok: { q: 0.80, c: 0.15, s: 0.05 },
    slow: { q: 0.84, c: 0.16, s: 0.00 },
  },
};

export const PRIORITIES = [
  { id: 'cost-first', label: 'Cost first', blurb: 'Batch jobs, product traffic, prototypes.' },
  { id: 'balanced', label: 'Balanced', blurb: 'Daily work. Pay a bit more for fewer mistakes.' },
  { id: 'quality-first', label: 'Quality first', blurb: 'Wrong answers are expensive.' },
];

export const SPEEDS = [
  { id: 'fast', label: 'Need snappy UX' },
  { id: 'ok', label: 'A few seconds is fine' },
  { id: 'slow', label: 'Think as long as you want' },
];

// ── Hard-constraint ladders (ascending = stricter; 0 = no preference) ─
// The empty-state hint relaxes exactly one notch down these ladders.
export const CTX_LADDER = [0, 128000, 200000, 1000000];
export const CAP_LADDER = [0, 1, 4, 12]; // USD per 1M blended tokens

export const OPEN_WEIGHTS_OPTIONS = [
  { id: 'any', label: 'Any' },
  { id: 'open', label: 'Open weights only' },
  { id: 'api', label: 'Hosted API only' },
];

export const SHORTLIST_SIZE = 5;

// Blended price recipe, documented in the UI tooltip: 3 input tokens per
// 1 output token. NOTE: the actual blend computation is NOT duplicated —
// the store's priceFor()/filterPriceFor() already implement it (3:1 mean,
// AA list price first) and the advisor reads their output.
export const PRICE_RECIPE_NOTE = 'blended = (3 × input + output) / 4 per 1M tokens';

// Defaults for the wizard form (also the deep-link fallbacks)
export const FORM_DEFAULTS = Object.freeze({
  use: null,
  priority: 'balanced',
  speed: 'ok',
  ctx: 0,
  vision: false,
  open: 'any',
  cap: 0,
  strict: false,
});
