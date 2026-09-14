// ── My Providers lib (stats-36) ───────────────────────────────────────
// Pure logic behind the user-supplied AI-provider feature: parsing
// provider model listings (fetch or paste), ID normalization/cleanup,
// staged conservative catalog matching, and pricing extraction.
// No Vue, no storage, no I/O — everything here is unit-tested, and the
// store (stores/myProviders.js) + view consume it as-is.
//
// Design contract (agreed with Ibrahim, discussion rounds 1-2):
//   • Home stays untouched — this lib only powers the My Providers tab
//     on the Providers page (stats-37 re-home of the stats-36 page).
//   • Matching is CONSERVATIVE: exact → dated-suffix → thinking-variant.
//     Greedy prefix matching is deliberately NOT implemented (it mis-links
//     base versions to wrong successors, e.g. Fable 5 → Fable 5.1).
//   • Provider `created` dates are never trusted (UnoRouter ships the same
//     bogus 2021 stamp on every row) — we don't even keep the field.
//   • Scores are NEVER stored client-side; the view mirrors them read-only
//     from the arena snapshot at render time (single source of truth).
//   • Unknown modality / endpoint shapes fail honest: an unparseable
//     listing surfaces a warning, never a fabricated row.

import { normKey } from './pivot.js';
import { priceBlend } from './format.js';

// Endpoint tokens that mean "serves text chat completions". Reseller lists
// mix in image-generation / embedding / aihorde endpoints — those stay out
// of the chat tables unless the user flips the non-chat toggle.
const CHAT_ENDPOINTS = new Set(['openai', 'anthropic', 'gemini', 'openai-response', 'chat']);

// ── ID parsing ────────────────────────────────────────────────────────
// Reseller IDs carry OpenRouter-style decorations:
//   'anthropic/claude-fable-5.1[1m]'  → base 'claude-fable-5.1', variant '1m'
//   'gpt-5.6-luna:free'               → free twin of 'gpt-5.6-luna'
//   'claude-opus-4-5-20251001'        → dated snapshot (handled by the
//                                        matcher's dated pass, not here —
//                                        the suffix is part of the id)
export function parseProviderId(raw) {
  const id = String(raw ?? '').trim();
  if (!id) return null;
  let base = id;
  let variant = null;
  let free = false;
  const bracket = base.match(/\[([^\]]*)\]$/);
  if (bracket) {
    variant = bracket[1] || null;
    base = base.slice(0, bracket.index);
  }
  if (/:free$/i.test(base)) {
    free = true;
    base = base.replace(/:free$/i, '');
  }
  return { raw: id, base, key: normKey(base), variant, free };
}

// ── Listing parsing ───────────────────────────────────────────────────
// One entry point for fetch AND paste. Accepts:
//   • OpenAI shape   {"data":[{id, owned_by, supported_endpoint_types, ...}]}
//   • some providers {"models":[...]} or a bare [...]
//   • arrays of plain strings (id lists)
//   • non-JSON text  → newline/comma/whitespace-separated id list
//                     ('#' comment lines allowed)
// Returns {models, warnings, format} — never throws on data shape.
const CHAT_FALLBACK = true; // no endpoint info at all → assume chat-capable
// (api.openai.com/v1/models entries carry no endpoint field; hiding every
// first-party model would be worse than the rare non-chat leak)

function coerceModel(e) {
  if (typeof e === 'string') {
    return { id: e.trim(), owned_by: null, endpoints: [], context_length: null, max_output_tokens: null, pricing: null };
  }
  if (!e || typeof e !== 'object') return null;
  const id = String(e.id ?? e.name ?? e.model ?? '').trim();
  if (!id) return null;
  const endpoints = Array.isArray(e.supported_endpoint_types)
    ? e.supported_endpoint_types.map(String)
    : Array.isArray(e.endpoints) ? e.endpoints.map(String) : [];
  const ctx = Number(e.context_length ?? e.context_window ?? NaN);
  const out = Number(e.max_output_tokens ?? NaN);
  return {
    id,
    owned_by: e.owned_by ? String(e.owned_by) : null,
    endpoints,
    context_length: Number.isFinite(ctx) && ctx > 0 ? ctx : null,
    max_output_tokens: Number.isFinite(out) && out > 0 ? out : null,
    pricing: e.pricing && typeof e.pricing === 'object' ? e.pricing : null,
  };
}

export function parseModelListing(text) {
  const warnings = [];
  const src = String(text ?? '').trim();
  if (!src) return { models: [], warnings: ['Empty listing.'], format: 'empty' };

  let entries = null;
  let format = 'ids';
  if (src.startsWith('{') || src.startsWith('[')) {
    try {
      const doc = JSON.parse(src);
      if (Array.isArray(doc)) {
        entries = doc; format = 'array';
      } else if (doc && Array.isArray(doc.data)) {
        entries = doc.data; format = 'openai';
      } else if (doc && Array.isArray(doc.models)) {
        entries = doc.models; format = 'models-key';
      } else if (doc && typeof doc === 'object') {
        return { models: [], warnings: ['JSON parsed but no model list found (looked for "data" / "models" / a bare array).'], format: 'bad-json' };
      }
    } catch {
      warnings.push('Text is not valid JSON — reading it as a plain model-id list.');
    }
  }
  if (entries === null) {
    // plain id-list mode: one id per line / comma separated. Model ids never
    // contain spaces or angle brackets, so HTML error pages and prose fail
    // the plausibility check and are reported — never turned into fake rows.
    let junkLines = 0;
    entries = [];
    for (const line of src.split(/[\n,;]+/).map(s => s.trim())) {
      if (!line || line.startsWith('#')) continue;
      if (!/^[A-Za-z0-9._:@+/[\]-]+$/.test(line)) { junkLines++; continue; }
      entries.push(line);
    }
    if (junkLines) warnings.push(`${junkLines} line${junkLines === 1 ? ' looks' : 's look'} like neither a model id nor JSON — skipped.`);
  }

  const seen = new Set();
  const models = [];
  let dropped = 0;
  for (const e of entries) {
    const c = coerceModel(e);
    if (!c || !c.id) { dropped++; continue; }
    const pid = parseProviderId(c.id);
    if (!pid || !pid.key) { dropped++; continue; }
    if (seen.has(c.id)) { dropped++; continue; } // exact dup — same SKU
    seen.add(c.id);
    const chat = c.endpoints.length
      ? c.endpoints.some(t => CHAT_ENDPOINTS.has(t.toLowerCase()))
      : CHAT_FALLBACK;
    models.push({
      ...c,
      key: pid.key,
      variant: pid.variant,
      free: pid.free,
      chat,
    });
  }
  if (dropped) warnings.push(`${dropped} entr${dropped === 1 ? 'y' : 'ies'} dropped (empty, duplicated, or no usable id).`);
  return { models, warnings, format };
}

// ── Catalog index (matching side) ─────────────────────────────────────
// Keys come from three arena sources, in trust order:
//   1. every unified row's display name (incl. older generations — a
//      provider can absolutely serve a superseded model; the view will
//      flag it with the muted "older" chip)
//   2. models_meta or_id   (OpenRouter slugs, e.g. qwen/qwen3.8-max-0902)
//   3. models_meta hugging_face_id
// On a normKey collision the NON-older row wins the name (a provider id
// matching both "X" and "X (older dup)" should land on the live row).
export function buildCatalogIndex(rows, meta) {
  const index = new Map(); // normKey -> {name}
  const older = (name) => {
    const m = meta?.[name];
    return !!(m && (m.superseded_by || m.stale));
  };
  const put = (rawKey, name) => {
    if (!rawKey) return;
    const prev = index.get(rawKey);
    if (!prev || (older(prev.name) && !older(name))) index.set(rawKey, { name });
  };
  for (const r of rows || []) {
    if (r && r.name) put(normKey(r.name), r.name);
  }
  for (const [name, m] of Object.entries(meta || {})) {
    if (m?.or_id) put(normKey(m.or_id), name);
    if (m?.hugging_face_id) put(normKey(m.hugging_face_id), name);
  }
  return index;
}

// ── Staged matcher ────────────────────────────────────────────────────
// Pass 1 'exact'    : normKey equality (covers [1m]/:free/org-prefix dust
//                     — parseProviderId already stripped those).
// Pass 2 'dated'    : trailing YYYYMMDD or MMDD snapshot stamp
//                     (claude-haiku-4-5-20251001, deepseek-r1-0528).
//                     4-digit strips only fire on a clean hit.
// Pass 3 'thinking' : reseller "-thinking" route of the same model.
// Every match carries its pass so the UI can label HOW it matched.
export function matchOne(key, index) {
  if (!key) return null;
  const exact = index.get(key);
  if (exact) return { pass: 'exact', name: exact.name };

  const d8 = key.replace(/\d{8}$/, '');
  if (d8 !== key && d8.length >= 5 && index.has(d8)) {
    return { pass: 'dated', name: index.get(d8).name };
  }
  const d4 = key.replace(/\d{4}$/, '');
  if (d4 !== key && d4.length >= 5 && index.has(d4)) {
    return { pass: 'dated', name: index.get(d4).name };
  }
  const th = key.replace(/thinking$/, '');
  if (th !== key && th.length >= 5 && index.has(th)) {
    return { pass: 'thinking', name: index.get(th).name };
  }
  return null;
}

export function matchListing(models, index) {
  const matched = [];
  const unlisted = [];
  for (const m of models || []) {
    const hit = matchOne(m.key, index);
    if (hit) matched.push({ model: m, pass: hit.pass, name: hit.name });
    else unlisted.push(m);
  }
  return { matched, unlisted, stats: { total: models?.length || 0, matched: matched.length } };
}

// ── Pricing extraction ────────────────────────────────────────────────
// OpenRouter-style per-token USD strings → per-1M USD numbers.
//   {prompt: "0.0000015", completion: "0.000006"} → {in: 1.5, out: 6}
// Providers that omit pricing (UnoRouter) simply yield null — the view
// shows the arena reference price for matched rows instead. No heuristic
// guessing of units: prompt/completion are the only fields we trust.
function perTokenTo1M(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n * 1e6;
}
export function extractPricing(p) {
  if (!p || typeof p !== 'object') return null;
  const inp = perTokenTo1M(p.prompt);
  const out = perTokenTo1M(p.completion);
  if (inp === null && out === null) return null;
  return { in: inp, out };
}

// ── v2: Compare-pivot overlay (stats-38) ──────────────────────────────
// The Providers page's Compare tab can overlay the user's own gateways as
// extra columns ("am I paying less via my gateway?"). These helpers keep
// every user-side rule in pure, unit-tested code; the view only wires them.
// Discipline (spec docs/spec-my-providers-v2.md):
//   • The overlay NEVER touches row.cells — the view stores it in a
//     separate per-row map, so cheapest-cell highlighting, pricing filters,
//     coverage counts and the slider universe stay catalog-only.
//   • Gateway prices are read from the parsed listing at render time —
//     nothing price-shaped is persisted.

// A SKU counts as free when it says so (:free twin) or publishes a zero
// price — the same rule the catalog uses for isFreeRow (in===0 && out===0).
function isFreeSku(s) {
  return !!s.free || (s.in === 0 && (s.out ?? 0) === 0);
}

// 3:1 in:out blend for one SKU, same convention as cellBlend: free → 0,
// in==null → null (a completion-only price is not blendable — honest null).
function skuBlend(s) {
  if (isFreeSku(s)) return 0;
  if (s.in == null) return null;
  return priceBlend({ input: s.in, output: s.out });
}

// buildMineOverlay(providers, index) → Map<arenaName, Map<providerId, sku[]>>
//   Runs the SAME staged matcher the My Providers tab uses over each
//   provider's chat-capable listing, and groups the matched SKUs per arena
//   model. One gateway can carry several SKUs of the same model ([1m] ctx
//   tags, :free twins) — they all land here; headlineSku picks the
//   comparable one and the view's tooltips enumerate the rest.
export function buildMineOverlay(providersList, index) {
  const byName = new Map();
  if (!index) return byName;
  for (const p of providersList || []) {
    const chat = (p?.models || []).filter(m => m.chat);
    const { matched } = matchListing(chat, index);
    for (const en of matched) {
      if (!byName.has(en.name)) byName.set(en.name, new Map());
      const perProvider = byName.get(en.name);
      if (!perProvider.has(p.id)) perProvider.set(p.id, []);
      const pr = extractPricing(en.model.pricing);
      perProvider.get(p.id).push({
        key: en.model.id,
        variant: en.model.variant || null,
        free: !!en.model.free,
        pass: en.pass,
        in: pr ? pr.in : null,
        out: pr ? pr.out : null,
      });
    }
  }
  return byName;
}

// headlineSku(skus) → { kind: 'paid'|'free'|'unpriced', sku, blend } | null
//   The price shown in the pivot cell. Cheapest PAID SKU wins (the paid SKU
//   is the product comparable to catalog cells — free twins are rate-limited
//   bonuses and stay in the tooltip); no paid blend → a free twin (blend 0,
//   free chip + caveat); neither → 'unpriced' (listed, dash).
export function headlineSku(skus) {
  const list = (skus || []).filter(Boolean);
  if (!list.length) return null;
  let best = null, bestBlend = null, free = null, unpriced = null;
  for (const s of list) {
    if (isFreeSku(s)) { if (!free) free = s; continue; }
    const b = skuBlend(s);
    if (b === null) { if (!unpriced) unpriced = s; continue; }
    if (best === null || b < bestBlend) { best = s; bestBlend = b; }
  }
  if (best) return { kind: 'paid', sku: best, blend: bestBlend };
  if (free) return { kind: 'free', sku: free, blend: 0 };
  return { kind: 'unpriced', sku: unpriced || list[0], blend: null };
}

// undercutsMine(mineBlend, catalogBlend) → true | false | null
//   True when the gateway's blend undercuts the row's cheapest CATALOG
//   blend (rowBlend — catalog-only by construction). Null when either side
//   is unpriced: nothing honest to claim.
export function undercutsMine(mineBlend, catalogBlend) {
  if (mineBlend == null || catalogBlend == null) return null;
  return mineBlend < catalogBlend;
}
