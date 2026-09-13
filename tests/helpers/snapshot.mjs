// Shared test helper: loads the real snapshot and mirrors the store's
// freshness logic. Every suite (unit + e2e) derives expectations from here,
// so a data refresh never silently invalidates hardcoded counts.
//
// Mirror contract (keep in sync with src/stores/data.js):
//   older  = meta.superseded_by || meta.stale
//   rank/leader/preset lists exclude older rows; nothing is ever deleted.
//   score (stats-35) = harmonized CL blend: every covered cell is z-mapped
//   against every shipped row on that benchmark (50 = median model,
//   15 pts = 1 sd, clipped 0-100), then meaned over the selected set with
//   uncovered benches contributing the neutral 50 prior — algebraically
//   w·zMean + (1−w)·50, w = covered/selected. The z re-derivation below is
//   deliberately independent of src/lib/benchScale.js: this mirror exists
//   to catch drift in the app modules, not to share bugs with them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SNAPSHOT_PATH = path.join(REPO, 'public', 'benchmark_results.json');

export function loadSnapshot() {
  return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
}

// Benchmarks the headline Avg is computed over (mirrors lib/constants.js).
export const CORE_BENCHMARKS = [
  'Artificial Analysis', 'BenchLM.ai', 'Arena.ai Text', 'SimpleBench.com',
  'ARC-AGI-2', 'Design Arena', 'SWE-Marathon', 'FrontierSWE',
];

export const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function avgForModel(row, core = CORE_BENCHMARKS) {
  const vals = core.map((b) => row[b]).filter((v) => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : -1;
}

export const SCORE_PRIOR = 50;

// Independent per-benchmark z stats: sample mean/sd (ddof=1) over the rows
// that report the benchmark. Mirrors computeBenchStats semantics without
// importing it. Benchmarks with <2 data points get no entry (pass-through).
export function benchZStats(rows, benches) {
  const stats = {};
  for (const b of benches) {
    const vals = [];
    for (const r of rows || []) {
      const v = r?.[b];
      if (v === null || v === undefined) continue;
      const n = Number(v);
      if (Number.isNaN(n)) continue;
      vals.push(n);
    }
    if (vals.length < 2) continue;
    const mu = vals.reduce((a, v) => a + v, 0) / vals.length;
    const ss = vals.reduce((a, v) => a + (v - mu) * (v - mu), 0);
    const sd = Math.sqrt(ss / (vals.length - 1));
    stats[b] = { mu, sd: sd > 1e-9 ? sd : 1 };
  }
  return stats;
}

let _snapStats = null; // lazy memo over the committed snapshot
function snapStats() {
  if (!_snapStats) {
    const d = loadSnapshot();
    const rows = [...(d.unified_closed || []), ...(d.unified_open || [])];
    const seen = new Set();
    const pivot = rows.filter((r) => !seen.has(r.name) && seen.add(r.name));
    _snapStats = benchZStats(pivot, d.benchmarks || []);
  }
  return _snapStats;
}

export function zHarmonize(bench, value, stats = snapStats()) {
  if (value === null || value === undefined) return null;
  const st = stats?.[bench];
  if (!st) return value;
  return Math.max(0, Math.min(100, SCORE_PRIOR + (15 * (value - st.mu)) / st.sd));
}

// stats-35 score: mean over the selected set of (covered ? z : prior).
// Returns -1 when the row reports nothing (sentinel, as before).
export function scoreForModel(row, core = CORE_BENCHMARKS, stats = snapStats()) {
  if (!row || !core?.length) return -1;
  let covered = 0;
  let tot = 0;
  for (const b of core) {
    const v = row[b];
    if (v === null || v === undefined) { tot += SCORE_PRIOR; continue; }
    covered++;
    tot += zHarmonize(b, v, stats);
  }
  if (!covered) return -1;
  return tot / core.length;
}

export function makeMirror(data = loadSnapshot()) {
  const META = data.models_meta || {};
  const closed = data.unified_closed || [];
  const open = data.unified_open || [];
  const rows = [...closed, ...open];
  const seen = new Set();
  const pivotAll = rows.filter((r) => !seen.has(r.name) && seen.add(r.name));

  const isOlder = (name) => !!(META[name] && (META[name].superseded_by || META[name].stale));
  const supersededBy = (name) => (META[name] && META[name].superseded_by) || null;
  const current = (list) => list.filter((r) => !isOlder(r.name));
  const stats = benchZStats(pivotAll, data.benchmarks || []);
  const byAvg = (a, b) => avgForModel(b) - avgForModel(a);
  const byScore = (a, b) => scoreForModel(b, CORE_BENCHMARKS, stats) - scoreForModel(a, CORE_BENCHMARKS, stats);

  return {
    data, META, closed, open, rows, pivotAll, isOlder, supersededBy, current, byAvg, byScore,
    olderRows: (list = pivotAll) => list.filter((r) => isOlder(r.name)),
    top: (list) => [...current(list)].sort(byScore),
    clOf: (row) => row.cl ?? 0,
  };
}

// Models that must NEVER be hidden by the freshness rules — the user's red
// line: different product lines (Pro vs Flash vs Lite) are different models
// and none may hide the other.
export const MUST_STAY_VISIBLE = ['Gemini 3.1 Pro', 'Gemini 3.8 Flash', 'Gemini 3.5 Flash-Lite'];

// Curated regression list: these shipped as "visible old models" bugs
// (2026-09 user report). The generic leak rules below now cover them, but
// they stay asserted by name so the exact regression can never return.
export const MUST_BE_HIDDEN = ['gpt 5.5 instant', 'Grok 4 Fast Chat', 'Phi-4 Multimodal', 'Mistral'];
