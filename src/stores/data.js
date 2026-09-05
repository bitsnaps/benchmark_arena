// ── Data store (module-level singleton) ───────────────────────────────
// Owns the benchmark snapshot and every derived list. Fetched once,
// shared by all views. Swap later for Pinia when the app outgrows this.

import { ref, computed } from 'vue';
import { SHORT, CORE_BENCHMARKS, LEADER_BENCHES, AVG_PRESETS, AVG_STORAGE_KEY } from '../lib/constants.js';
import { slugify } from '../lib/format.js';

const rawData = ref(null);
const loading = ref(true);
const error = ref(null);

let pending = null;

export function ensureLoaded() {
  if (rawData.value) return Promise.resolve();
  if (!pending) {
    pending = (async () => {
      try {
        const res = await fetch('benchmark_results.json');
        if (!res.ok) throw new Error(String(res.status));
        rawData.value = await res.json();
      } catch {
        error.value = 'Failed to load benchmark data.';
      } finally {
        loading.value = false;
      }
    })();
  }
  return pending;
}

// ── Benchmarks ────────────────────────────────────────────────────────
const benchmarks = computed(() => rawData.value?.benchmarks ?? []);

// ── User-selectable average set (commit B) ────────────────────────────
// The global Score averages whatever the user picks here. `null` means the
// shipped default (CORE_BENCHMARKS) — zero behavior change until the user
// touches the "Avg set" dropdown. Custom sets persist to localStorage and
// sync with the ?avg= URL param (shareable views).
const avgSelection = ref(readStoredSelection());

function readStoredSelection() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = window.localStorage.getItem(AVG_STORAGE_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.length ? arr.map(String) : null;
  } catch { return null; }
}

function persistSelection() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (avgSelection.value) window.localStorage.setItem(AVG_STORAGE_KEY, JSON.stringify(avgSelection.value));
    else window.localStorage.removeItem(AVG_STORAGE_KEY);
  } catch { /* storage unavailable (private mode) — session-only selection */ }
}

// The effective average set: the user's selection (or the default) filtered
// to benchmarks that actually exist in this snapshot. Unknown/stale names
// drop out; if nothing valid remains we silently fall back to the default.
const coreBenchmarks = computed(() => {
  const inData = benchmarks.value;
  const wanted = avgSelection.value ?? CORE_BENCHMARKS;
  const eff = inData.filter(b => wanted.includes(b));
  return eff.length ? eff : inData.filter(b => CORE_BENCHMARKS.includes(b));
});
const nonCoreBenchmarks = computed(() => benchmarks.value.filter(b => !coreBenchmarks.value.includes(b)));

// True when the effective set differs from the shipped default (drives the
// "custom" badge + ?avg= param; picking exactly the default set is not custom).
const isCustomAvg = computed(() => {
  if (!avgSelection.value) return false;
  const eff = coreBenchmarks.value;
  const def = benchmarks.value.filter(b => CORE_BENCHMARKS.includes(b));
  return eff.length !== def.length || eff.some(b => !def.includes(b));
});

// Which named preset (if any) the current selection matches — for the dropdown label
const avgPresetId = computed(() => {
  if (!isCustomAvg.value) return 'default';
  const eff = [...coreBenchmarks.value];
  for (const p of AVG_PRESETS) {
    if (p.id === 'default') continue;
    const benches = p.benches === null ? benchmarks.value : p.benches;
    const pb = benchmarks.value.filter(b => benches.includes(b));
    if (pb.length === eff.length && pb.every(b => eff.includes(b))) return p.id;
  }
  return null;
});

function setAvgSelection(list) {
  const clean = [...new Set(list ?? [])].filter(x => typeof x === 'string');
  // Empty selection = back to the shipped default (the ≥1 guard lives in
  // toggleAvgBench, which refuses to deselect the last remaining benchmark).
  avgSelection.value = clean.length ? clean : null;
  persistSelection();
}

function toggleAvgBench(bench) {
  const cur = new Set(avgSelection.value ?? CORE_BENCHMARKS);
  if (cur.has(bench)) {
    if (cur.size <= 1) return; // ≥1 selection guard — the Score needs evidence
    cur.delete(bench);
  } else {
    cur.add(bench);
  }
  setAvgSelection([...cur]);
}

function applyPreset(preset) {
  if (preset.id === 'default') { resetAvgSelection(); return; }
  const benches = preset.benches === null ? benchmarks.value : preset.benches;
  setAvgSelection(benchmarks.value.filter(b => benches.includes(b)));
}

function resetAvgSelection() {
  avgSelection.value = null;
  persistSelection();
}

// ?avg= deep link: comma-separated benchmark slugs (slugify of full names).
// Returns false for empty/unknown params — those never touch current state.
function applyAvgParam(param) {
  if (typeof param !== 'string' || !param.trim()) return false;
  const map = new Map(benchmarks.value.map(b => [slugify(b), b]));
  const resolved = param.split(',').map(s => map.get(s.trim())).filter(Boolean);
  if (!resolved.length) return false;
  setAvgSelection(resolved);
  return true;
}

const perBenchData = computed(() => rawData.value?.per_benchmark || {});

// ── Pivot lists ───────────────────────────────────────────────────────
const pivotClosed = computed(() => rawData.value?.unified_closed || []);
const pivotOpen = computed(() => rawData.value?.unified_open || []);

// Merged list — every LLM in one ranking so the overall top model is
// immediately visible (deduped by name just in case a model appears in
// both source lists).
const pivotAll = computed(() => {
  const seen = new Set();
  const out = [];
  for (const r of [...pivotClosed.value, ...pivotOpen.value]) {
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    out.push(r);
  }
  return out;
});

const pivotFor = (tier) =>
  tier === 'closed' ? pivotClosed.value : tier === 'open' ? pivotOpen.value : pivotAll.value;

const stats = computed(() => ({
  closed: pivotClosed.value.length,
  open: pivotOpen.value.length,
  totalBenchmarks: benchmarks.value.length,
  coreBenchmarks: coreBenchmarks.value.length,
  lastUpdated: rawData.value?.timestamp || '—',
}));

// ── Composite average over the selected benchmarks ────────────────────
// Raw sparse mean: plain average of the selected scores a model actually
// has. Biased in favor of low-coverage models (selection bias — a model
// only shows up on benchmarks where it performs), so it is NOT the ranking
// metric; see scoreForModel.
function avgForModel(row) {
  const vals = coreBenchmarks.value
    .map(b => row[b])
    .filter(v => v !== null && v !== undefined);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

// Coverage recomputed against the CURRENT selection (the baked row.cl only
// knows the shipped 8-core set). With the default selection this reproduces
// the baked value exactly — coverage counts are multiples of 100/n.
function clForModel(row) {
  if (!row) return 0;
  const sel = coreBenchmarks.value;
  if (!sel.length) return 0;
  const has = sel.filter(b => row[b] !== null && row[b] !== undefined).length;
  return (has / sel.length) * 100;
}

// How many of the selected benchmarks the model actually reports
function coveredCountForModel(row) {
  if (!row) return 0;
  return coreBenchmarks.value.filter(b => row[b] !== null && row[b] !== undefined).length;
}

// ── CL-weighted global score (the ranking metric) ─────────────────────
// Blends the raw sparse average toward a neutral 50 baseline in proportion
// to the model's Coverage Level (CL = fraction of the SELECTED benchmarks
// covered):
//
//     score = w * rawAvg + (1 - w) * 50,   w = cl / 100
//
// Full coverage (cl=100) → unchanged raw average. A model reporting 2 of 8
// core benchmarks only keeps 25% of its above-baseline excess, which stops
// flash/niche models from topping the board on a handful of favorable
// results. Uncovered benchmarks are treated as "no evidence" (neutral 50),
// never as a zero.
const SCORE_PRIOR = 50;
function scoreForModel(row) {
  const raw = avgForModel(row);
  if (raw === null || raw === undefined) return null;
  const cl = Math.min(100, Math.max(0, clForModel(row)));
  const w = cl / 100;
  return w * raw + (1 - w) * SCORE_PRIOR;
}

const topOverall = computed(() =>
  [...pivotAll.value].filter(r => !isOlder(r))
    .sort((a, b) => (scoreForModel(b) ?? -1) - (scoreForModel(a) ?? -1))[0] || null);
const topClosed = computed(() =>
  [...pivotClosed.value].filter(r => !isOlder(r))
    .sort((a, b) => (scoreForModel(b) ?? -1) - (scoreForModel(a) ?? -1))[0] || null);
const topOpen = computed(() =>
  [...pivotOpen.value].filter(r => !isOlder(r))
    .sort((a, b) => (scoreForModel(b) ?? -1) - (scoreForModel(a) ?? -1))[0] || null);

// Per-benchmark leader cards for the overview (current-generation models only)
const leaders = computed(() => LEADER_BENCHES.map(bench => {
  const rows = [...pivotClosed.value, ...pivotOpen.value]
    .filter(r => !isOlder(r) && r[bench] !== null && r[bench] !== undefined);
  const top = rows.reduce((acc, r) =>
    acc === null || (r[bench] ?? -1) > (acc[bench] ?? -1) ? r : acc, null);
  return { bench, short: SHORT[bench] || bench, model: top?.name ?? '—', score: top?.[bench] ?? null, count: rows.length };
}));

// ── Ranking per tier (independent of current sort/search) ─────────────
// Ranks are positions among CURRENT-generation models: older releases —
// superseded versions of the same product line (models_meta.superseded_by)
// or stale generations 9+ months past the newest release (models_meta.stale)
// — are excluded so rank #1 is always the best current model.
const rankMaps = computed(() => {
  const build = (list) => [...list]
    .filter(r => !isOlder(r))
    .sort((a, b) => (scoreForModel(b) ?? -1) - (scoreForModel(a) ?? -1))
    .reduce((map, r, i) => map.set(r.name, i + 1), new Map());
  return { all: build(pivotAll.value), closed: build(pivotClosed.value), open: build(pivotOpen.value) };
});
const rankOf = (tier, row) => rankMaps.value[tier]?.get(row.name);
// Which tier a row belongs to (for the merged "all" table + license rows).
// Checked against the RAW source lists — superseded models are excluded from
// rankMaps, so they must not fall through to 'open'.
const tierOf = (row) =>
  (row && pivotClosed.value.some(r => r.name === row.name)) ? 'closed' : 'open';

const isCore = (b) => coreBenchmarks.value.includes(b);

// ── Slug indexes (deep links) ─────────────────────────────────────────
const modelSlugIndex = computed(() => {
  const m = new Map();
  for (const r of pivotAll.value) {
    const s = slugify(r.name);
    if (!m.has(s)) m.set(s, r);
  }
  return m;
});

const benchSlugIndex = computed(() => {
  const m = new Map();
  for (const b of benchmarks.value) m.set(slugify(b), b);
  return m;
});

// Per-benchmark ranking across ALL models (for model cards):
// { [bench]: { count, ranks: Map(name → 1-based rank), best } }
const benchRankIndex = computed(() => {
  const out = {};
  for (const b of benchmarks.value) {
    const rows = pivotAll.value
      .filter(r => r[b] !== null && r[b] !== undefined)
      .sort((x, y) => y[b] - x[b]);
    out[b] = {
      count: rows.length,
      ranks: rows.reduce((m, r, i) => m.set(r.name, i + 1), new Map()),
      best: rows[0]?.name ?? null,
    };
  }
  return out;
});

// ── Model metadata (OpenRouter catalog snapshot) ──────────────────────
// One entry per matched model: params, modalities, context, pricing…
// Models absent from the catalog simply resolve to null.
const modelsMeta = computed(() => rawData.value?.models_meta || {});
const metaFor = (row) => (row && row.name ? modelsMeta.value[row.name] || null : null);
// Supersession: this model is an older version of a product line and a
// newer release exists (scraper fills models_meta.superseded_by by ordering
// same-family+variant siblings by release date).
const supersededBy = (row) => metaFor(row)?.superseded_by || null;
const isSuperseded = (row) => !!supersededBy(row);
// "Older" = superseded by a successor OR a stale generation (no successor in
// the data, but released ≥ 9 months before the newest snapshot release).
// Both kinds hide behind the Older-versions toggle; neither is ever deleted.
const isOlder = (row) => isSuperseded(row) || !!metaFor(row)?.stale;
const releaseDateOf = (row) => metaFor(row)?.created || null;
const metaCoverage = computed(() => {
  const total = pivotAll.value.length;
  const withMeta = pivotAll.value.filter(r => !!modelsMeta.value[r.name]).length;
  return { total, withMeta };
});

// ── Pricing (price layer) ────────────────────────────────────────────────
// API list price attached by the scraper in models_meta.pricing_usd_per_1m
// (OpenRouter snapshot, USD per 1M tokens). Rows without a catalog match
// resolve to null — never fabricated. `blend` is the 3:1 in:out mean used
// for sorting; `output`/`cache_read` may be null when the catalog lacks them.
const priceFor = (row) => {
  const pr = metaFor(row)?.pricing_usd_per_1m;
  if (!pr || typeof pr.input !== 'number') return null;
  const out = typeof pr.output === 'number' ? pr.output : null;
  return {
    input: pr.input,
    output: out,
    cache_read: typeof pr.cache_read === 'number' ? pr.cache_read : null,
    blend: out === null ? pr.input : (3 * pr.input + out) / 4,
  };
};

// Full benchmark name as native tooltip on column headers
function benchThAttrs(column) {
  const b = column.field;
  if (!b || b === 'avg' || b === 'rank') return {};
  const core = coreBenchmarks.value.includes(b);
  return { title: b + (core ? ' (core — counted in global Score)' : ' (not counted in global Score)') };
}

export function useData() {
  return {
    rawData, loading, error, ensureLoaded,
    benchmarks, coreBenchmarks, nonCoreBenchmarks, perBenchData,
    avgSelection, isCustomAvg, avgPresetId, setAvgSelection, toggleAvgBench,
    applyPreset, resetAvgSelection, applyAvgParam,
    pivotClosed, pivotOpen, pivotAll, pivotFor, stats,
    avgForModel, clForModel, coveredCountForModel, scoreForModel,
    topOverall, topClosed, topOpen, leaders,
    rankMaps, rankOf, tierOf, isCore, benchThAttrs,
    modelSlugIndex, benchSlugIndex, benchRankIndex,
    modelsMeta, metaFor, metaCoverage, supersededBy, isSuperseded, isOlder, releaseDateOf,
    priceFor,
  };
}
