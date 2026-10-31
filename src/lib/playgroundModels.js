// ── Playground model options ───────────────────────────────────────────
// "Available" = a chat model listed by one of the user's own My Providers
// entries: those are the only models this static site can actually reach
// (the public catalog says who sells a model, not how to call it with your
// key). Arena joins reuse the My Providers matcher, so a model shows the
// same score/price here as on its provider card — read-only, never stored.

import { matchListing, extractPricingFor, parseProviderId } from './myProviders.js';

// ctx: { catalogIndex, rowByName, scoreForModel, priceFor, isOlder, isUnranked, slugOf }
export function buildPlaygroundGroups(providers, ctx) {
  const groups = [];
  for (const p of providers || []) {
    const chat = (p.models || []).filter(m => m.chat);
    if (!chat.length) continue;
    const hits = new Map();
    if (ctx?.catalogIndex) {
      for (const en of matchListing(chat, ctx.catalogIndex).matched) hits.set(en.model.id, en.name);
    }
    const items = chat.map(m => {
      const arenaName = hits.get(m.id) || null;
      const row = arenaName ? ctx.rowByName.get(arenaName) : null;
      const own = extractPricingFor(m, p.priceKeys);
      const ref = row ? ctx.priceFor(row) : null;
      let price = null;
      if (own && own.in != null && own.out != null) price = { in: own.in, out: own.out, source: 'provider' };
      else if (ref && Number.isFinite(ref.input) && Number.isFinite(ref.output)) price = { in: ref.input, out: ref.output, source: 'arena' };
      return {
        key: p.id + '\u0001' + m.id,
        providerId: p.id,
        providerLabel: p.label,
        catalogId: p.catalogId || null,
        kind: p.kind || null,
        custom: !!p.custom,
        modelId: m.id,
        arenaName,
        slug: arenaName && ctx.slugOf ? ctx.slugOf(arenaName) : null,
        score: row && !ctx.isUnranked(row) ? ctx.scoreForModel(row) : null,
        older: row ? !!ctx.isOlder(row) : false,
        ctx: m.context_length || null,
        free: !!m.free,
        price,
      };
    });
    // Best-rated first (the leaderboard's own order), then the rest by id.
    items.sort((a, b) => {
      const sa = a.score ?? -1, sb = b.score ?? -1;
      if (sa !== sb) return sb - sa;
      return a.modelId.localeCompare(b.modelId);
    });
    groups.push({
      providerId: p.id, label: p.label, baseUrl: p.baseUrl, hasKey: !!p.key,
      catalogId: p.catalogId || null, kind: p.kind || null, custom: !!p.custom,
      items,
    });
  }
  return groups;
}

// ── Catalog providers (public/providers.json) ─────────────────────────
// Every lab / cloud / serverless / aggregator entry the scraper knows
// about joins the Playground as a pickable group, joined read-only to the
// arena like synced listings. A catalog group is BROWSABLE without any
// setup; chatting from one needs a base URL + key, collected by the setup
// modal, which then links a real My Providers entry via `catalogId`.

// Documented OpenAI-compatible endpoints for the well-known providers.
// Curated from each vendor's official docs (2026-11); everything is a
// PREFILL — the setup modal leaves every field editable, and chat.js
// reports a wrong guess (401/404) honestly. Perplexity is listed as the
// full chat path because its base has no version segment.
export const KNOWN_ENDPOINTS = Object.freeze({
  'openai': 'https://api.openai.com/v1',
  'anthropic': 'https://api.anthropic.com/v1', // OpenAI SDK compatibility layer
  'google-ai-studio': 'https://generativelanguage.googleapis.com/v1beta/openai',
  'openrouter': 'https://openrouter.ai/api/v1',
  'groq': 'https://api.groq.com/openai/v1',
  'cerebras': 'https://api.cerebras.ai/v1',
  'mistral': 'https://api.mistral.ai/v1',
  'deepseek': 'https://api.deepseek.com/v1',
  'xai': 'https://api.x.ai/v1',
  'together-ai': 'https://api.together.xyz/v1',
  'fireworks-ai': 'https://api.fireworks.ai/inference/v1',
  'deepinfra': 'https://api.deepinfra.com/v1/openai',
  'nvidia-nim': 'https://integrate.api.nvidia.com/v1',
  'sambanova': 'https://api.sambanova.ai/v1',
  'perplexity': 'https://api.perplexity.ai/chat/completions',
  'cohere': 'https://api.cohere.ai/compatibility/v1',
  'moonshot-ai': 'https://api.moonshot.ai/v1',
  'minimax': 'https://api.minimax.io/v1',
  'z-ai': 'https://api.z.ai/api/paas/v4',
  'alibaba-dashscope': 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
});

// One providers.json entry → the My-Providers shape buildPlaygroundGroups
// already speaks (same fields lib/myProviders.js derives from a listing),
// with prices converted per-1M → per-token strings so extractPricingFor
// reads them unchanged. `custom: false` marks its items "needs setup".
export function catalogProviderEntry(p) {
  const models = (p.models || [])
    .filter(m => m && m.id)
    .map((m) => {
      const pid = parseProviderId(m.id);
      const priced = m.in != null || m.out != null;
      return {
        id: m.id,
        owned_by: null,
        endpoints: ['openai'],
        context_length: Number.isFinite(m.ctx) && m.ctx > 0 ? m.ctx : null,
        max_output_tokens: null,
        pricing: priced
          ? { prompt: m.in == null ? null : String(m.in / 1e6), completion: m.out == null ? null : String(m.out / 1e6) }
          : null,
        raw: m,
        key: pid.key, base: pid.base, variant: pid.variant,
        free: !!pid.free || (m.in === 0 && m.out === 0),
        chat: true,
      };
    });
  return {
    id: 'cat:' + p.id,
    label: p.name || p.id,
    baseUrl: KNOWN_ENDPOINTS[p.id] || '',
    key: '',
    catalogId: p.id,
    kind: p.kind || null,
    custom: false,
    priceKeys: null,
    models,
  };
}

const KIND_RANK = { 'first-party': 0, cloud: 1, serverless: 2, aggregator: 3 };

// Groups for every catalog provider NOT already linked to a My Providers
// entry (the linked entry's own group replaces the catalog one). Custom
// groups are not touched here; the view concatenates custom first.
export function buildCatalogGroups(catalog, linkedCatalogIds, ctx) {
  const linked = new Set(linkedCatalogIds || []);
  const groups = [];
  for (const p of catalog || []) {
    if (!p || !p.id || linked.has(p.id)) continue;
    if (!Array.isArray(p.models) || !p.models.length) continue;
    const [g] = buildPlaygroundGroups([catalogProviderEntry(p)], ctx);
    if (g) groups.push(g);
  }
  groups.sort((a, b) =>
    ((KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9)) || a.label.localeCompare(b.label));
  return groups;
}

// Cap the rendered options of the pick list (catalog scale = thousands of
// rows; rendering them all on open would jank the rail). Group headers stay
// only while they still show ≥1 item; order is preserved.
export function capGroupItems(groups, max) {
  let remaining = Math.max(0, max | 0);
  const out = [];
  let hidden = 0;
  for (const g of groups || []) {
    if (remaining <= 0) { hidden += g.items.length; continue; }
    const items = g.items.slice(0, remaining);
    remaining -= items.length;
    hidden += g.items.length - items.length;
    if (items.length) out.push({ ...g, items });
  }
  return { groups: out, hidden };
}

// Rewrite one model's id inside a listing (setup-modal override for
// catalogs that prefix ids differently than the real API expects). The
// matcher fields are re-derived so arena joins keep working.
export function applyModelOverride(models, oldId, newId) {
  const to = String(newId || '').trim();
  if (!to || to === oldId) return models || [];
  return (models || []).map((m) => {
    if (m.id !== oldId) return m;
    const pid = parseProviderId(to);
    return { ...m, id: to, key: pid.key, base: pid.base, variant: pid.variant, free: pid.free || m.free, raw: { ...(m.raw || {}), id: to } };
  });
}

export function filterGroups(groups, query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return groups;
  return groups
    .map(g => ({
      ...g,
      items: g.label.toLowerCase().includes(q)
        ? g.items
        : g.items.filter(i => i.modelId.toLowerCase().includes(q) || (i.arenaName || '').toLowerCase().includes(q)),
    }))
    .filter(g => g.items.length);
}

// Rail provider filter groups: optgroup label per kind, custom entries on
// top. Unknown kinds (a future catalog addition) fall into their own group.
export const KIND_LABELS = Object.freeze({
  'first-party': 'Labs',
  'cloud': 'Cloud',
  'serverless': 'Serverless',
  'aggregator': 'Aggregators & gateways',
});

export function providerOptGroups(groups) {
  const mine = [], byKind = new Map();
  for (const g of groups || []) {
    const opt = { id: g.providerId, label: g.label, n: g.items.length };
    if (g.custom) mine.push(opt);
    else {
      const k = g.kind || 'other';
      if (!byKind.has(k)) byKind.set(k, []);
      byKind.get(k).push(opt);
    }
  }
  const out = mine.length ? [{ label: 'My providers', options: mine }] : [];
  for (const [k, options] of byKind) {
    out.push({ label: KIND_LABELS[k] || k, options });
  }
  return out;
}

// Provider rail filter ('' = all providers). Composes with filterGroups:
// narrow by provider first, then let the text search do its thing.
export function filterByProvider(groups, providerId) {
  const f = String(providerId || '');
  if (!f) return groups;
  return (groups || []).filter(g => g.providerId === f);
}

export function findOption(groups, providerId, modelId) {
  for (const g of groups || []) {
    if (g.providerId !== providerId) continue;
    const hit = g.items.find(i => i.modelId === modelId);
    if (hit) return hit;
  }
  return null;
}

// Every option that serves a given arena model (for "Chat in Playground"
// links on the model card), best-priced first.
export function optionsForArenaName(groups, name) {
  const out = [];
  for (const g of groups || []) for (const i of g.items) if (i.arenaName === name) out.push(i);
  return out.sort((a, b) => ((a.price ? a.price.in * 3 + a.price.out : Infinity) - (b.price ? b.price.in * 3 + b.price.out : Infinity)));
}
