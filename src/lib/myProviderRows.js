// ── stats-66: shared My-Providers row building ────────────────────────
// One source of truth for the per-provider card tables (MyProvidersPanel)
// and the per-provider full page (MyProviderDetailView). Extracted verbatim
// from the panel so the two surfaces can never drift.
//
// Discipline carried over unchanged (stats-36..65):
//   • scores / CL / arena prices are MIRRORED READ-ONLY from the snapshot
//     through the accessors passed in `ctx` — nothing score-shaped is
//     stored or computed here;
//   • unranked rows stay out of the picks (stats-65: a model without a
//     rating is not a recommendation candidate);
//   • unlisted rows carry metadata + provider-published prices only; every
//     arena column stays an honest dash;
//   • custom pricing keys (stats-51) are a render-time lens on the raw
//     listing — the provider's own price resolves per row, per render.

import { extractPricingFor, matchListing } from './myProviders.js';
import { priceBlend, slugify } from './format.js';

// stats-39: preview/route/thinksearch added; combo passes ('route+dated')
// render as 'route tag + dated snapshot' via the segment join.
export const PASS_LABEL = {
  exact: 'exact id', dated: 'dated snapshot', thinking: 'thinking route',
  preview: 'preview build', route: 'route tag', thinksearch: 'think+search route',
};

export function passLabelOf(p) {
  return String(p).split('+').map(s => PASS_LABEL[s] || s).join(' + ');
}

// Buefy custom-sort comparator factory — same convention as PivotTable's
// byScore/byPrice: the comparator owns the direction, and nulls sink to the
// bottom in BOTH directions (a dash is never a small number).
export function numSort(accessor) {
  return (a, b, isAsc) => {
    const av = accessor(a);
    const bv = accessor(b);
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return isAsc ? av - bv : bv - av;
  };
}

// Text comparator with the same null-last discipline (b-table's default
// string sort cannot know where dashes belong).
export function textSort(accessor) {
  return (a, b, isAsc) => {
    const av = accessor(a);
    const bv = accessor(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const cmp = String(av).localeCompare(String(bv));
    return isAsc ? cmp : -cmp;
  };
}

// ── Matched rows ("On the arena") ─────────────────────────────────────
// ctx: { catalogIndex, rowByName, scoreForModel, clForModel, priceFor,
//        isOlder, isUnranked } — the data store's read-only accessors.
// Each row: { key, name, slug, pass, passLabel, variant, free, score, cl,
//             price (arena reference), older, ownPrice (provider-published) }.
export function buildMatchedRows(p, ctx) {
  if (!ctx || !ctx.catalogIndex) return [];
  const chat = (p.models || []).filter(m => m.chat);
  const { matched } = matchListing(chat, ctx.catalogIndex);
  const rows = matched.map(en => {
    const row = ctx.rowByName.get(en.name);
    const pr = row ? ctx.priceFor(row) : null;
    const op = extractPricingFor(en.model, p.priceKeys);
    return {
      key: en.model.id,
      name: en.name,
      slug: slugify(en.name),
      pass: en.pass,
      passLabel: passLabelOf(en.pass),
      variant: en.model.variant,
      free: en.model.free,
      score: row ? ctx.scoreForModel(row) : null,
      cl: row ? ctx.clForModel(row) : null,
      price: pr,                       // arena reference (AA list first, 3:1 blend)
      older: row ? ctx.isOlder(row) : false,
      ownPrice: (op && (op.in != null || op.out != null))
        ? { in: op.in ?? null, out: op.out ?? null, blend: priceBlend({ input: op.in ?? undefined, output: op.out ?? undefined }), viaKeys: !!op.viaKeys }
        : null,
    };
  });
  // stats-65: unranked rows stay out of the provider picks (v1 scope —
  // a model without a rating is not a recommendation candidate). Rows with
  // no catalog join at all still list (honest availability, no score).
  return rows.filter(r => {
    const row = ctx.rowByName.get(r.name);
    return !row || !ctx.isUnranked(row);
  });
}

// ── Unlisted rows ("reseller-only") ───────────────────────────────────
// includeNonChat: the per-card/page toggle — non-chat endpoints (image /
// embedding / other) stay hidden by default, exactly as the panel behaves.
export function buildUnlistedRows(p, { catalogIndex, includeNonChat = false }) {
  if (!catalogIndex) return [];
  const { unlisted } = matchListing((p.models || []).filter(m => m.chat), catalogIndex);
  const priceOf = (m) => extractPricingFor(m, p.priceKeys);
  const rows = unlisted.map(m => ({
    key: m.id, ctx: m.context_length, endpoints: m.endpoints,
    free: m.free, variant: m.variant, kind: 'chat',
    price: priceOf(m),
  }));
  if (includeNonChat) {
    for (const m of (p.models || []).filter(x => !x.chat)) {
      rows.push({
        key: m.id, ctx: m.context_length, endpoints: m.endpoints,
        free: m.free, variant: m.variant, kind: 'non-chat',
        price: priceOf(m),
      });
    }
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

// Card-table order (unchanged stats-37 contract): the provider's focus
// decides the default — scores → arena score desc; prices → ARENA reference
// price cheapest first (the cards' price column is the arena reference);
// track → name. Nulls sink. The merged full page has its own variant below
// (sortMergedRows), which follows the provider's OWN published price.
export function sortMatchedRows(rows, intent) {
  const dir = (a, b, cmp) => cmp(a, b) || a.name.localeCompare(b.name);
  const num = (v) => (v === null || v === undefined ? -Infinity : v);
  const out = [...rows];
  if (intent === 'prices') out.sort((a, b) => dir(a, b, (x, y) => num(x.price?.blend) - num(y.price?.blend)));
  else if (intent === 'track') out.sort((a, b) => a.name.localeCompare(b.name));
  else out.sort((a, b) => dir(a, b, (x, y) => num(y.score) - num(x.score))); // scores (default)
  return out;
}

// ── Merged rows (stats-66 full page) ──────────────────────────────────
// One table, both populations. status: 'arena' | 'unlisted' | 'non-chat'.
// Arena-only fields (name/slug/score/cl/price/pass/older) are null on
// unlisted rows — the view renders honest dashes there, never guesses.
export function buildMergedRows(p, ctx, { includeNonChat = false } = {}) {
  const matched = buildMatchedRows(p, ctx).map(r => ({ ...r, status: 'arena' }));
  const unlisted = buildUnlistedRows(p, { catalogIndex: ctx?.catalogIndex, includeNonChat })
    .map(r => ({
      key: r.key, name: null, slug: null, pass: null, passLabel: null,
      variant: r.variant, free: r.free, score: null, cl: null,
      price: null, older: false, ownPrice: (r.price && (r.price.in != null || r.price.out != null))
        ? { in: r.price.in ?? null, out: r.price.out ?? null, blend: priceBlend({ input: r.price.in ?? undefined, output: r.price.out ?? undefined }), viaKeys: !!r.price.viaKeys }
        : null,
      ctx: r.ctx, endpoints: r.endpoints,
      status: r.kind === 'non-chat' ? 'non-chat' : 'unlisted',
    }));
  const rows = [...matched, ...unlisted];
  return sortMergedRows(rows, p.intent);
}

// Default order follows the provider's focus (the same contract as the
// cards): scores → arena score desc; prices → the provider's own price
// cheapest first; everything else → arena rows first, then listing id.
// Nulls always sink — a missing value never ranks over a real one.
export function sortMergedRows(rows, intent) {
  const dir = (a, b, cmp) => cmp(a, b) || localeFallback(a, b);
  const num = (v) => (v === null || v === undefined ? -Infinity : v);
  const sorted = [...rows];
  if (intent === 'prices') {
    sorted.sort((a, b) => dir(a, b, (x, y) => num(x.ownPrice?.blend) - num(y.ownPrice?.blend)));
  } else if (intent === 'track') {
    sorted.sort((a, b) => dir(a, b, (x, y) => localeFallback(x, y)));
  } else {
    // scores (default) — unlisted rows (score null) sink below every rated row
    sorted.sort((a, b) => dir(a, b, (x, y) => num(y.score) - num(x.score)));
  }
  return sorted;
}

function localeFallback(a, b) {
  const an = a.name || a.key || '';
  const bn = b.name || b.key || '';
  const c = an.localeCompare(bn);
  if (c !== 0) return c;
  // same arena model (e.g. :free twin) — keep the arena row above reseller variants
  return (a.status === 'arena' ? 0 : 1) - (b.status === 'arena' ? 0 : 1);
}
