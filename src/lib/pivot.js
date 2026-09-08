// ── Pivot matcher: models × providers matrix ──────────────────────────
// stats-18: powers the /providers "Compare" tab. Joins per-seller catalog
// rows (providers.json) into one row per canonical model so prices for the
// same model sit side by side and the cheapest seller is pickable at a
// glance. Pure functions only — unit-tested in tests/unit/pivot.test.js.
//
// Matching discipline (conservative, explainable — "do our best" v1):
//   1. normKey(): lowercase → drop the org prefix (last '/' segment) →
//      strip every non-alphanumeric char. 'deepseek/deepseek-v4-flash' and
//      'deepseek-ai/DeepSeek-V4-Flash' both → 'deepseekv4flash'.
//      Deliberately aggressive on separators (5.1 ≡ 5-1) but blind to
//      everything else: NO fuzzy edit-distance, NO version guessing. An
//      ':batch' or ':extended' variant id glues its suffix onto the key and
//      stays its own row — variants are separate offerings with separate
//      prices, never folded into the base model (stats-14 discipline).
//   2. Free twins ('-free'/':free' ids; the scraper persists base=<id>) do
//      NOT get their own row: they attach to their base model's row as a
//      free tier inside the seller's cell. A free listing is not a model.
//   3. Everything unmatched stays unmatched — its own row, honest gaps.
//      The view prints a coverage line (collapsed duplicates) so join
//      quality stays visible instead of silently lying.

import { priceBlend } from './format.js';
import { passesPricing } from './priceFilter.js';

// ── Pricing-mode variants (stats-19) ────────────────────────────────────
// OpenRouter's ':batch' ids are async/batch endpoints of the SAME model at
// a discounted price — pricing modes, not models. They glue their suffix in
// normKey (separate rows, per the variant discipline) but hide behind the
// providers listing "batch variants" toggle so the default view compares
// standard endpoints. Note '-beta'/'-online' ids are NOT variants — they
// are part of real model names (grok-3-beta, sonar-small-online).
export function isBatchId(id) {
  return !!id && /:batch$/i.test(String(id).trim());
}

// Accepts a catalog row ({ id, name }) or a pivot row ({ ids[], name }).
// A pivot row is a batch row when EVERY joined id is a batch id (batch ids
// glue their own normKey, so they never mix with base-model ids).
export function isBatchRow(r) {
  if (!r) return false;
  const ids = Array.isArray(r.ids) ? r.ids : (r.id != null ? [r.id] : []);
  if (ids.length) return ids.every(isBatchId);
  return /\(batch\)\s*$/i.test(String(r.name || '').trim());
}

// Join key for a catalog id (or a name fallback). Null-safe.
export function normKey(raw) {
  if (!raw) return null;
  let s = String(raw).toLowerCase().trim();
  const slash = s.lastIndexOf('/');
  if (slash !== -1) s = s.slice(slash + 1);
  s = s.replace(/[^a-z0-9]/g, '');
  return s || null;
}

// Default "Compare" columns — the four keyless API catalogs plus the three
// biggest priced serverless hosts. All ids verified against providers.json.
export const DEFAULT_COLUMNS = [
  'openrouter',
  'orcarouter',
  'opencode-zen',
  'nvidia-nim',
  'fireworks-ai',
  'deepinfra',
  'together-ai',
  'groq',
];

// buildMatrix(providers, selectedIds) → { rows, coverage }
//   rows: [{ key, name, firstId, ids, search, cells: { [providerId]: cell } }]
//   cell: { in, out, ctx, listed, free, freeBase?, latency }
//     price fields null when the API exposes no pricing (honest dash);
//     free=true when a free listing exists in this cell (suffix twin, a
//     zero-priced listing, or a provider-level free tier like NVIDIA NIM);
//     latency reserved — no catalog exposes per-model latency yet (see
//     bench_scraper.py stats-18 note), always null until a source appears.
//   coverage: { models, cells, collapsed, sellers }
//     collapsed = intra-provider id pairs that normalized to the same key
//     (deduped — first priced row wins, dupes counted, never silently mixed).
export function buildMatrix(providers, selectedIds) {
  const sel = selectedIds
    .map((id) => providers.find((p) => p.id === id))
    .filter(Boolean);

  const rows = new Map(); // key → row
  let collapsed = 0;
  let cellCount = 0;

  const rowFor = (key) => {
    let r = rows.get(key);
    if (!r) {
      r = { key, name: null, firstId: null, ids: [], cells: {} };
      rows.set(key, r);
    }
    return r;
  };

  const preferName = (row, cand) => {
    if (!cand) return;
    if (!row.name) { row.name = cand; return; }
    // prefer curated "Vendor: Model" style names (OpenRouter/OrcaRouter)
    if (/: /.test(cand) && !/: /.test(row.name)) row.name = cand;
  };

  const putCell = (prov, key, cell, name, rawId) => {
    const row = rowFor(key);
    const prev = row.cells[prov.id];
    if (prev) {
      collapsed++;
      // priced beats unpriced; otherwise first wins — never silently mix
      const prevPriced = prev.in != null;
      const newPriced = cell.in != null;
      if (prevPriced || !newPriced) return;
    }
    if (!row.cells[prov.id]) cellCount++;
    row.cells[prov.id] = cell;
    if (rawId && !row.ids.includes(rawId)) row.ids.push(rawId);
    if (!row.firstId && rawId) row.firstId = rawId;
    preferName(row, name);
  };

  // pass 1 — every non-twin listing (free twins are handled in pass 2)
  for (const p of sel) {
    const providerFreeTier = !!p.free_tier;
    for (const m of p.models) {
      if (m.free && m.base) continue;
      const key = normKey(m.id);
      if (!key) continue;
      putCell(p, key, {
        in: m.in ?? null,
        out: m.out ?? null,
        ctx: m.ctx ?? null,
        listed: true,
        free: providerFreeTier || (!!(m.free && !m.base)),
        latency: null,
      }, m.name || null, m.id);
    }
  }

  // pass 2 — free twins attach to their base model's row
  for (const p of sel) {
    for (const m of p.models) {
      if (!(m.free && m.base)) continue;
      const key = normKey(m.base);
      if (!key) continue;
      const row = rows.get(key);
      if (row && row.cells[p.id]) {
        const c = row.cells[p.id];
        if (!c.free) row.cells[p.id] = { ...c, free: true, freeBase: m.id };
      } else {
        const r = rowFor(key);
        if (!r.cells[p.id]) {
          cellCount++;
          r.cells[p.id] = {
            in: m.in ?? null,
            out: m.out ?? null,
            ctx: m.ctx ?? null,
            listed: true,
            free: true,
            freeBase: m.id,
            latency: null,
          };
        }
        if (m.id && !r.ids.includes(m.id)) r.ids.push(m.id);
        if (!r.firstId && m.id) r.firstId = m.id;
        preferName(r, m.name || null);
      }
    }
  }

  const list = [...rows.values()];
  for (const r of list) {
    r.search = ((r.name || '') + ' ' + r.ids.join(' ') + ' ' + r.key).toLowerCase();
  }

  return {
    rows: list,
    coverage: { models: list.length, cells: cellCount, collapsed, sellers: sel.length },
  };
}

// Rows sorted by seller coverage (most sellers first), then by name — the
// browse default for "which model is widely available".
export function sortMatrixRows(rows) {
  return [...rows].sort((a, b) => {
    const na = Object.keys(a.cells).length;
    const nb = Object.keys(b.cells).length;
    if (nb !== na) return nb - na;
    return String(a.name || a.key).localeCompare(String(b.name || b.key));
  });
}

// Blended $/1M for one cell (3:1 in:out, same convention as the leaderboard
// Price column). A free listing blends to 0 — it IS free, rate limits aside.
// Unpriced (listed but no API price) → null, never fabricated.
export function cellBlend(cell) {
  if (!cell) return null;
  if (cell.free) return 0;
  if (cell.in == null) return null;
  return priceBlend({ input: cell.in, output: cell.out });
}

// Cheapest known blend across a row's cells (null when none priced).
export function rowBlend(row) {
  let best = null;
  for (const pid of Object.keys(row.cells)) {
    const b = cellBlend(row.cells[pid]);
    if (b !== null && (best === null || b < best)) best = b;
  }
  return best;
}

// Provider id of the cheapest cell (ties → first in column order).
export function cheapestPid(row) {
  let bestPid = null;
  let best = null;
  for (const pid of Object.keys(row.cells)) {
    const b = cellBlend(row.cells[pid]);
    if (b !== null && (best === null || b < best)) { best = b; bestPid = pid; }
  }
  return bestPid;
}

// Row filters for the Compare tab. All composable (the point of stats-18):
//   q        — substring over name + every joined seller id + key
//   freeOnly — keep rows with ≥1 free cell (any selected seller)
//   maxPrice — keep rows whose cheapest known blend ≤ maxPrice
// The pricing half (freeOnly + maxPrice) is the SHARED contract from
// lib/priceFilter.js — the By-provider tab filters its catalog rows with
// the exact same predicate, so the two tabs can never drift (stats-23).
export function filterMatrix(rows, { q = '', freeOnly = false, maxPrice = null } = {}) {
  const term = String(q).trim().toLowerCase();
  return rows.filter((r) => {
    if (term && !r.search.includes(term)) return false;
    return passesPricing(r, {
      blend: rowBlend(r),
      free: Object.values(r.cells).some((c) => c.free),
    }, { freeOnly, maxPrice });
  });
}

// Latency color ladder (seconds, TTFT-style). No catalog exposes per-model
// latency today (probed 2026-09-07 — see bench_scraper.py); cells carry
// latency: null and render uncolored. When a real source appears, set
// cell.latency and these tiers color the price value automatically:
//   < 1.5s → 'fast' (green) · < 3.5s → 'ok' (amber) · ≥ 3.5s → 'slow' (red)
export function latencyTier(sec) {
  if (sec == null || Number.isNaN(Number(sec))) return null;
  const s = Number(sec);
  if (s < 1.5) return 'fast';
  if (s < 3.5) return 'ok';
  return 'slow';
}

export function latencyClass(sec) {
  const t = latencyTier(sec);
  return t ? `lat-${t}` : '';
}
