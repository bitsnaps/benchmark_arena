// Shared test helper: loads the real snapshot and mirrors the store's
// freshness logic. Every suite (unit + e2e) derives expectations from here,
// so a data refresh never silently invalidates hardcoded counts.
//
// Mirror contract (keep in sync with src/stores/data.js):
//   older  = meta.superseded_by || meta.stale
//   rank/leader/preset lists exclude older rows; nothing is ever deleted.
//   score = CL-weighted global score: w*rawAvg + (1-w)*50, w = cl/100
//   (the store's ranking metric — raw avg is display/context only)
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

export function scoreForModel(row, core = CORE_BENCHMARKS) {
  const raw = avgForModel(row, core);
  if (raw === -1) return -1;
  const cl = Math.min(100, Math.max(0, row.cl ?? 0));
  return (cl / 100) * raw + (1 - cl / 100) * SCORE_PRIOR;
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
  const byAvg = (a, b) => avgForModel(b) - avgForModel(a);
  const byScore = (a, b) => scoreForModel(b) - scoreForModel(a);

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
export const MUST_BE_HIDDEN = ['gpt 5.5 instant', 'grok 4 fast chat', 'Phi-4 Multimodal', 'Mistral'];
