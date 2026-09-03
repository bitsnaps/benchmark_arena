// ── Data store (module-level singleton) ───────────────────────────────
// Owns the benchmark snapshot and every derived list. Fetched once,
// shared by all views. Swap later for Pinia when the app outgrows this.

import { ref, computed } from 'vue';
import { SHORT, CORE_BENCHMARKS, LEADER_BENCHES } from '../lib/constants.js';
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
const coreBenchmarks = computed(() => benchmarks.value.filter(b => CORE_BENCHMARKS.includes(b)));
const nonCoreBenchmarks = computed(() => benchmarks.value.filter(b => !CORE_BENCHMARKS.includes(b)));
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

// ── Composite average over the core benchmarks ────────────────────────
function avgForModel(row) {
  const vals = coreBenchmarks.value
    .map(b => row[b])
    .filter(v => v !== null && v !== undefined);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

const topOverall = computed(() =>
  [...pivotAll.value].filter(r => !isSuperseded(r))
    .sort((a, b) => (avgForModel(b) ?? -1) - (avgForModel(a) ?? -1))[0] || null);
const topClosed = computed(() =>
  [...pivotClosed.value].filter(r => !isSuperseded(r))
    .sort((a, b) => (avgForModel(b) ?? -1) - (avgForModel(a) ?? -1))[0] || null);
const topOpen = computed(() =>
  [...pivotOpen.value].filter(r => !isSuperseded(r))
    .sort((a, b) => (avgForModel(b) ?? -1) - (avgForModel(a) ?? -1))[0] || null);

// Per-benchmark leader cards for the overview (current-generation models only)
const leaders = computed(() => LEADER_BENCHES.map(bench => {
  const rows = [...pivotClosed.value, ...pivotOpen.value]
    .filter(r => !isSuperseded(r) && r[bench] !== null && r[bench] !== undefined);
  const top = rows.reduce((acc, r) =>
    acc === null || (r[bench] ?? -1) > (acc[bench] ?? -1) ? r : acc, null);
  return { bench, short: SHORT[bench] || bench, model: top?.name ?? '—', score: top?.[bench] ?? null, count: rows.length };
}));

// ── Ranking per tier (independent of current sort/search) ─────────────
// Ranks are positions among CURRENT-generation models: superseded versions
// (older release in the same product line, see models_meta.superseded_by)
// are excluded so rank #1 is always the best current model.
const rankMaps = computed(() => {
  const build = (list) => [...list]
    .filter(r => !isSuperseded(r))
    .sort((a, b) => (avgForModel(b) ?? -1) - (avgForModel(a) ?? -1))
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
const releaseDateOf = (row) => metaFor(row)?.created || null;
const metaCoverage = computed(() => {
  const total = pivotAll.value.length;
  const withMeta = pivotAll.value.filter(r => !!modelsMeta.value[r.name]).length;
  return { total, withMeta };
});

// Full benchmark name as native tooltip on column headers
function benchThAttrs(column) {
  const b = column.field;
  if (!b || b === 'avg' || b === 'rank') return {};
  const core = coreBenchmarks.value.includes(b);
  return { title: b + (core ? ' (core — counted in Avg)' : ' (not counted in Avg)') };
}

export function useData() {
  return {
    rawData, loading, error, ensureLoaded,
    benchmarks, coreBenchmarks, nonCoreBenchmarks, perBenchData,
    pivotClosed, pivotOpen, pivotAll, pivotFor, stats,
    avgForModel, topOverall, topClosed, topOpen, leaders,
    rankMaps, rankOf, tierOf, isCore, benchThAttrs,
    modelSlugIndex, benchSlugIndex, benchRankIndex,
    modelsMeta, metaFor, metaCoverage, supersededBy, isSuperseded, releaseDateOf,
  };
}
