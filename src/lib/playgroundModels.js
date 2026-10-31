// ── Playground model options ───────────────────────────────────────────
// "Available" = a chat model listed by one of the user's own My Providers
// entries: those are the only models this static site can actually reach
// (the public catalog says who sells a model, not how to call it with your
// key). Arena joins reuse the My Providers matcher, so a model shows the
// same score/price here as on its provider card — read-only, never stored.

import { matchListing, extractPricingFor } from './myProviders.js';

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
    groups.push({ providerId: p.id, label: p.label, baseUrl: p.baseUrl, hasKey: !!p.key, items });
  }
  return groups;
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
