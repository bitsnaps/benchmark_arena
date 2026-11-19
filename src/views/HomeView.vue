<script setup>
// Home = the leaderboard. Compact snapshot header, tier tabs, the global
// pivot table, compare panel, then context: category leaders, methodology.
// Tier tabs live in the URL as ?tier=, search as ?q=, the custom average
// mix as ?avg= (comma-separated benchmark slugs), the availability
// filters as ?free=1 / ?price=<max blend> / ?seller=<provider slug>, the
// input-modality filter as ?mod=<token> (stats-34), and the model-grade
// mode as ?tiers= (stats-60).
import { computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { TIERS, SHORT, AVG_PRESETS } from '../lib/constants.js';
import { slugify, fmtScore, fmtUsd, providerColor, initials } from '../lib/format.js';
import { tiersMode, setTiersMode, applyTiersParam, TIERS_MODE_DEFAULT } from '../lib/tiers.js';
import { useData } from '../stores/data.js';
import { useLeaderboard } from '../stores/leaderboard.js';
import PivotTable from '../components/PivotTable.vue';
import ComparePanel from '../components/ComparePanel.vue';
import NewWindowSelect from '../components/NewWindowSelect.vue';
import TiersSelect from '../components/TiersSelect.vue';

const route = useRoute();
const router = useRouter();

const { pivotFor, pivotAll, stats, topOverall, topOpen, scoreForModel, clForModel, leaders, coreBenchmarks, nonCoreBenchmarks, benchmarks, avgSelection, isCustomAvg, avgPresetId, applyPreset, toggleAvgBench, resetAvgSelection, applyAvgParam, loading, isOlder, isUnranked, cardModels, releaseDateOf, priceFor, availableAtFor, hasFreeListingFor, filterPriceFor, metaFor, modelSlug } = useData();
const { searchQuery, compareMode, compareRows, showOlder, minCl, freeOnly, maxPrice, sellerId, modFilter, showUnranked, showEci, showCardModels } = useLeaderboard();

// ── Tier tab ⇄ ?tier= query param ─────────────────────────────────────
const tier = computed(() =>
  TIERS.some(t => t.value === route.query.tier) ? route.query.tier : 'all');

const activeTier = computed({
  get: () => tier.value,
  set: (v) => {
    if (!v || v === tier.value) return;
    router.push({ query: { ...route.query, tier: v === 'all' ? undefined : v } });
  },
});

// ── Search ⇄ ?q= query param (shareable filtered views) ──────────────
watch(() => route.query.q, (q) => {
  const val = typeof q === 'string' ? q : '';
  if (val !== searchQuery.value) searchQuery.value = val;
}, { immediate: true });

watch(searchQuery, (q) => {
  const current = typeof route.query.q === 'string' ? route.query.q : '';
  if (q === current) return;
  router.replace({ query: { ...route.query, q: q || undefined } });
});

// ── Avg set ⇄ ?avg= (custom mixes become shareable links) ────────────
// The URL param (comma-separated bench slugs) wins over localStorage when
// both exist. A missing param never resets a stored custom mix — it just
// means "no explicit request", so we reflect the stored mix into the URL.
watch([loading, () => route.query.avg], ([ld, v]) => {
  if (ld) return;
  const param = typeof v === 'string' ? v : '';
  const serialized = avgSelection.value ? avgSelection.value.map(slugify).join(',') : '';
  if (param && param !== serialized) {
    applyAvgParam(param); // deep link → selection (+ localStorage)
    return;
  }
  if (!param && serialized && !('avg' in route.query)) {
    router.replace({ query: { ...route.query, avg: serialized } });
  }
}, { immediate: true });

watch(avgSelection, (sel) => {
  const want = sel ? sel.map(slugify).join(',') : undefined;
  if (route.query.avg !== want) {
    router.replace({ query: { ...route.query, avg: want } });
  }
});

// ── Tiers mode ⇄ ?tiers= (stats-60, shareable views) ─────────────────
// Same discipline as ?avg=: a valid param wins over localStorage; an
// unknown param is dropped (stale share link); a missing param never
// resets a stored non-default mode — it gets reflected into the URL.
watch([loading, () => route.query.tiers], ([ld, v]) => {
  if (ld) return;
  const param = typeof v === 'string' ? v : '';
  if (param) {
    if (!applyTiersParam(param)) {
      router.replace({ query: { ...route.query, tiers: undefined } });
    }
    return;
  }
  if (!('tiers' in route.query) && tiersMode.value !== TIERS_MODE_DEFAULT) {
    router.replace({ query: { ...route.query, tiers: tiersMode.value } });
  }
}, { immediate: true });

watch(tiersMode, (m) => {
  const want = m === TIERS_MODE_DEFAULT ? undefined : m;
  if (route.query.tiers !== want) {
    router.replace({ query: { ...route.query, tiers: want } });
  }
});

// ── Avg-set dropdown helpers ─────────────────────────────────────────
const isInSel = (b) => coreBenchmarks.value.includes(b);
const selectedCount = computed(() => coreBenchmarks.value.length);
const avgLabel = computed(() => {
  const pid = avgPresetId.value;
  if (pid) return AVG_PRESETS.find(p => p.id === pid)?.label ?? 'Default (8 core)';
  return `Custom (${selectedCount.value})`;
});
// Min-CL slider granularity follows the selection size (100/n per bench)
const clStep = computed(() => 100 / Math.max(1, selectedCount.value));

// ── Availability filters (free toggle / price slider / seller pick) ────
// All three compose with search, tier, avg-set and the coverage controls.
// The slider maps its 0–100 position onto $/1M with a power curve so the
// sub-$1 range (where most models live) keeps usable resolution; the top
// position means "any price" and never hides rows.
const priceMax = computed(() => {
  let m = 0;
  for (const r of pivotAll.value) {
    const p = priceFor(r);
    if (p && p.blend > m) m = p.blend;
  }
  return Math.max(1, Math.ceil(m));
});
const priceFromT = (t) => priceMax.value * Math.pow(t / 100, 2.6);
const tFromPrice = (p) =>
  Math.round(100 * Math.pow(Math.min(p, priceMax.value) / priceMax.value, 1 / 2.6));
const priceSlider = computed({
  get: () => (maxPrice.value == null ? 100 : tFromPrice(maxPrice.value)),
  set: (v) => {
    maxPrice.value = v >= 100 ? null : Math.round(priceFromT(v) * 100) / 100;
  },
});
const priceTag = computed(() =>
  maxPrice.value == null ? 'any price' : '≤ ' + fmtUsd(maxPrice.value));

// Free-listing count for the toggle tag: current tier, current generation.
// stats-79: unranked rows are census-only — the tag must not promise rows
// the ranked table won't render.
const freeCount = computed(() =>
  pivotFor(tier.value).filter(r => !isOlder(r) && !isUnranked(r) && hasFreeListingFor(r)).length);

// Seller dropdown options: every seller that lists at least one
// current-generation RANKED model, busiest first (tier-independent).
// stats-79: sellers that only list census rows would filter the ranked
// table to zero — they don't earn an option.
const sellerOptions = computed(() => {
  const counts = new Map();
  for (const r of pivotAll.value) {
    if (isOlder(r) || isUnranked(r)) continue;
    for (const a of availableAtFor(r)) {
      const e = counts.get(a.p) || { n: a.n, c: 0 };
      e.c += 1;
      counts.set(a.p, e);
    }
  }
  return [...counts.entries()]
    .map(([p, e]) => ({ p, n: e.n, c: e.c }))
    .sort((a, b) => b.c - a.c || a.n.localeCompare(b.n));
});

// ── Availability filters ⇄ URL (?free=1 / ?price= / ?seller=) ─────────
watch(freeOnly, (on) => {
  const want = on ? '1' : undefined;
  if (route.query.free !== want) router.replace({ query: { ...route.query, free: want } });
});
watch(() => route.query.free, (v) => {
  const on = v === '1' || v === 'true';
  if (on !== freeOnly.value) freeOnly.value = on;
}, { immediate: true });

// ── stats-79: unranked reveal ⇄ URL (?unranked=1) ─────────────────────
// The deep link wins over the localStorage default on load (immediate);
// after that the toggle keeps the param in sync so shared URLs tell the
// truth. Toggling off drops the param and clears the stored choice.
watch(showUnranked, (on) => {
  const want = on ? '1' : undefined;
  if (route.query.unranked !== want) router.replace({ query: { ...route.query, unranked: want } });
});
watch(() => route.query.unranked, (v) => {
  const on = v === '1' || v === 'true';
  if (on !== showUnranked.value) showUnranked.value = on;
}, { immediate: true });

// ── stats-85: ECI reference column ⇄ URL (?eci=0 / ?eci=1) ────────────
// Inverted vs the unranked toggle because ECI ships ON: the param only
// appears when the state differs from the default (off → ?eci=0 so shared
// URLs keep the hidden column; on → param dropped, clean URL). Deep links
// win over localStorage on load; ?eci=1 also clears a stored OFF choice.
watch(showEci, (on) => {
  const want = on ? undefined : '0';
  if (route.query.eci !== want) router.replace({ query: { ...route.query, eci: want } });
});
watch(() => route.query.eci, (v) => {
  if (v === undefined) return; // no param → stored/default choice stands
  const on = v === '1' || v === 'true';
  if (on !== showEci.value) showEci.value = on;
}, { immediate: true });

// ── stats-87/89: OpenRouter-only reveal ⇄ URL (?card=0 / ?card=1) ─────
// stats-89: the reveal ships ON (card rows merge inline into the ranked
// table), so the param follows the ECI contract — it appears only when
// the state differs from the default (off → ?card=0 so shared URLs keep
// the rows hidden; on → param dropped, clean URL). Deep links win over
// localStorage on load; ?card=1 also clears a stored OFF choice.
watch(showCardModels, (on) => {
  const want = on ? undefined : '0';
  if (route.query.card !== want) router.replace({ query: { ...route.query, card: want } });
});
watch(() => route.query.card, (v) => {
  if (v === undefined) return; // no param → stored/default choice stands
  const on = v === '1' || v === 'true';
  if (on !== showCardModels.value) showCardModels.value = on;
}, { immediate: true });

watch(maxPrice, (p) => {
  const want = p == null ? undefined : String(p);
  if (route.query.price !== want) router.replace({ query: { ...route.query, price: want } });
});
watch(() => route.query.price, (v) => {
  const num = typeof v === 'string' && v !== '' && Number.isFinite(parseFloat(v)) ? parseFloat(v) : null;
  const eff = num != null && num > 0 ? num : null;
  if (eff !== maxPrice.value) maxPrice.value = eff;
}, { immediate: true });

watch(sellerId, (s) => {
  const want = s || undefined;
  if (route.query.seller !== want) router.replace({ query: { ...route.query, seller: want } });
});
watch([loading, () => route.query.seller], ([ld, v]) => {
  if (ld) return;
  const param = typeof v === 'string' ? v : '';
  const known = param === '' || sellerOptions.value.some(s => s.p === param);
  // any ?seller= value is authoritative: known slugs apply, unknown ones
  // (stale share links) reset to "any" and get dropped from the URL
  const next = known ? param : '';
  if (next !== sellerId.value) sellerId.value = next;
  if (!known && param) router.replace({ query: { ...route.query, seller: undefined } });
}, { immediate: true });

// ── stats-34: Modalities filter ⇄ URL (?mod=image|audio|video) ────────
const MOD_OPTIONS = [
  { v: '', label: 'Any modality' },
  { v: 'image', label: 'Image input' },
  { v: 'audio', label: 'Audio input' },
  { v: 'video', label: 'Video input' },
];
const MOD_TOOLTIP = 'Show only models whose input supports this modality. Rows with unknown modality data are hidden while a filter is on (same rule as the price cap hiding unpriced rows).';
// Counts over the current tier's default ranking (like the Free toggle).
// stats-79: unranked rows hide with the census — counts stay honest to
// what the ranked table actually renders.
const modCount = (tok) =>
  pivotFor(tier.value).filter(r => !isOlder(r) && !isUnranked(r) && ((metaFor(r)?.input_modalities) || []).includes(tok)).length;

watch(modFilter, (m) => {
  const want = m || undefined;
  if (route.query.mod !== want) router.replace({ query: { ...route.query, mod: want } });
});
watch(() => route.query.mod, (v) => {
  const param = typeof v === 'string' ? v : '';
  const known = param === '' || MOD_OPTIONS.some(o => o.v === param);
  // known tokens apply; stale share links reset to "any" + drop the param
  const next = known ? param : '';
  if (next !== modFilter.value) modFilter.value = next;
  if (!known && param) router.replace({ query: { ...route.query, mod: undefined } });
}, { immediate: true });

// ── Rows for the active tab ───────────────────────────────────────────
// One ranked listing. Older releases — superseded versions of the same
// product line plus stale generations (9+ months old, no successor in the
// data) — are hidden by default; the Older-versions toggle interleaves them
// INLINE at their natural score position (dimmed, no rank, "older" chip),
// so there is no separate section to scroll to. All modes respect the
// search box, the min-CL slider and the availability filters (free toggle,
// max-price slider, seller pick); nothing is deleted.
const applyFilters = (list) => {
  const q = searchQuery.value.toLowerCase();
  const mp = maxPrice.value;
  return list.filter(r => {
    if (clForModel(r) < minCl.value) return false;
    if (q && !r.name.toLowerCase().includes(q)) return false;
    if (freeOnly.value && !hasFreeListingFor(r)) return false;
    if (sellerId.value && !availableAtFor(r).some(a => a.p === sellerId.value)) return false;
    // stats-34: input-modality filter — unknown modalities hide while on
    if (modFilter.value && !(metaFor(r)?.input_modalities || []).includes(modFilter.value)) return false;
    if (mp != null) {
      // free listings count as $0 so a free row survives any cap
      const p = filterPriceFor(r);
      if (p === null || p > mp) return false;
    }
    return true;
  });
};

const rows = computed(() => {
  const all = applyFilters(pivotFor(tier.value)).filter(r => !isUnranked(r));
  // stats-89/90: census rows join the ranked table INLINE while revealed —
  // card rows (OpenRouter-only, default ON) and new & unranked rows
  // (single-source, default OFF per Ibrahim: keep the board fast/light).
  // Same toolbar filters, same grid, honest dashes everywhere. The census
  // key parks scoreless rows below the ranking (they claim no rating, so
  // they must not sort by their mostly-neutral prior blend either); b-table's
  // score sort takes over from there, and column sorts (name/price/context)
  // slot census rows in naturally since some cells are real.
  // Closed tab: card rows never merge (open-weight only); unranked closed
  // models do — pivotFor(tier) already scopes them per tab.
  const censusScore = (r) => isUnranked(r) ? -1 : (scoreForModel(r) ?? -1);
  const cards = showCardModels.value ? cardRows.value : [];
  const un = showUnranked.value ? unrankedRows.value : [];
  if (!showOlder.value) return [...all.filter(r => !isOlder(r)), ...cards, ...un];
  // Older toggle on: pre-sort the merged list by the CL-weighted score so
  // older models sit at their natural position and BOTH census kinds park
  // at the end (scoreless rows sink; the table's interactive sort takes
  // over from there).
  return [...all, ...cards, ...un].sort((a, b) => censusScore(b) - censusScore(a));
});

// stats-65/stats-90: the "New & unranked" census — every admitted
// single-source row (unranked flag baked by the scraper) that passes the
// SAME toolbar filters as the ranked table. stats-90: no longer a separate
// section — these rows merge INLINE into the main table while the reveal
// toggle is on (default OFF: the census is a traceability surface, and
// Ibrahim wants the default board fast/light). Newest release first; rows
// without a catalog date (launch-day, not yet provider-matched) sink to
// the end alphabetically. Older+unranked rows stay behind the
// Older-versions toggle like everywhere else: hidden while the toggle is
// off, shown dimmed when it is on. The ranked universe (pivotFor) is
// untouched — these rows never join it, so no rank/Score/grade math can
// see them.
const unrankedRows = computed(() => {
  const list = applyFilters(pivotFor(tier.value))
    .filter(r => isUnranked(r) && (showOlder.value || !isOlder(r)));
  return [...list].sort((a, b) => {
    const da = releaseDateOf(a);
    const db = releaseDateOf(b);
    if (da && db && da !== db) return da < db ? 1 : -1;
    if (da !== db) return da ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
});
const unrankedCount = computed(() =>
  pivotFor(tier.value).filter(r => isUnranked(r) && (showOlder.value || !isOlder(r))).length);

// stats-87/89: the OpenRouter-only census — open-weight models the catalog
// lists that no tracked benchmark scores (card rows, doc section
// card_models). stats-89: no longer a separate section — these rows merge
// INLINE into the ranked table while the toggle is on (same toolbar
// filters; the b-table score sort parks them under the ranking). Card
// models are open-weight by construction, so nothing merges on the Closed
// tab. The ranked universe (pivotFor) is untouched — these rows never
// join it, so no rank/Score/grade math can see them.
const cardRows = computed(() => {
  if (tier.value === 'closed') return [];
  const list = applyFilters(cardModels.value);
  return [...list].sort((a, b) => {
    const da = releaseDateOf(a);
    const db = releaseDateOf(b);
    if (da && db && da !== db) return da < db ? 1 : -1;
    if (da !== db) return da ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
});
const cardCount = computed(() =>
  tier.value === 'closed' ? 0 : cardModels.value.length);

const olderCount = computed(() =>
  pivotFor(tier.value).filter(r => isOlder(r) && !isUnranked(r)).length);

const openModel = (name) =>
  router.push({ name: 'model', params: { slug: modelSlug(name) } });
</script>

<template>
  <section>
    <div class="page-head">
      <div class="kicker">Benchmark cockpit · snapshot {{ stats.lastUpdated }}</div>
      <h1 class="section-title">LLM Leaderboard</h1>
      <p class="section-sub">
        Every public eval we track, merged into one sortable table. Slice by license with the
        tabs, or open any model for its full score card.
      </p>
    </div>

    <!-- Snapshot stats -->
    <div class="grid-4 home-stats">
      <div class="stat">
        <div class="lbl">Models tracked</div>
        <div class="val num">{{ stats.closed + stats.open }}</div>
        <div class="sub">{{ stats.closed }} closed · {{ stats.open }} open weights</div>
      </div>
      <div class="stat">
        <div class="lbl">Public leaderboards</div>
        <div class="val num">{{ stats.totalBenchmarks }}</div>
        <div class="sub">{{ stats.coreBenchmarks }} of them counted in the global Score</div>
      </div>
      <div class="stat">
        <div class="lbl">Top overall</div>
        <div class="val" style="font-size:1.15rem">{{ topOverall ? topOverall.name : '—' }}</div>
        <div class="sub">Score {{ topOverall ? fmtScore(scoreForModel(topOverall)) : '—' }} · CL-weighted, {{ topOverall ? Math.round(clForModel(topOverall)) : '—' }}% coverage</div>
      </div>
      <div class="stat">
        <div class="lbl">Top open-weight</div>
        <div class="val" style="font-size:1.15rem">{{ topOpen ? topOpen.name : '—' }}</div>
        <div class="sub">Score {{ topOpen ? fmtScore(scoreForModel(topOpen)) : '—' }} · CL-weighted, {{ topOpen ? Math.round(clForModel(topOpen)) : '—' }}% coverage</div>
      </div>
    </div>

    <!-- Tier tabs -->
    <b-tabs v-model="activeTier" type="is-toggle" multiline class="tier-tabs">
      <b-tab-item
        v-for="t in TIERS"
        :key="t.value"
        :value="t.value"
        :label="t.label"
        :icon="t.icon"
      />
    </b-tabs>

    <!-- Toolbar -->
    <div class="panel-lab" style="padding:1rem">
      <div class="row">
        <b-field class="mb-0" style="flex:1;min-width:220px">
          <b-input v-model="searchQuery" placeholder="Filter models…" icon="magnifying-glass" rounded />
        </b-field>
        <b-field class="mb-0">
          <b-switch v-model="compareMode" type="is-primary" left-label>
            Compare
            <b-tag v-if="compareRows.length" type="is-warning" size="is-small" rounded>
              {{ compareRows.length }}/5
            </b-tag>
          </b-switch>
        </b-field>
      </div>
      <div class="row mt-sm" style="gap:1.2rem;align-items:center;flex-wrap:wrap">
        <b-switch v-model="showOlder" size="is-small" type="is-warning" left-label>
          Older versions
          <b-tag size="is-small" type="is-warning is-light" rounded>{{ olderCount }}</b-tag>
        </b-switch>
        <span v-if="showOlder" class="cell-sub" style="white-space:nowrap">older models shown inline (dimmed, unranked)</span>
        <!-- stats-79/90: the unranked census is a traceability surface —
             hidden by default, revealed from here; rows render INLINE in the
             main table (stats-90, the stats-89 card-row pattern), parked
             under the ranking by the score sort. Toggle itself hidden when
             the census is empty (a control for nothing is UI debt). -->
        <b-tooltip label="Single-source models the ranking is not allowed to claim yet — one benchmark source, real scores shown as-is, no computed rating and no rank. Shown inline below the ranking; they join it automatically when a 2nd source lands. Hidden by default to keep the board fast."
          type="is-dark" multilined :delay="100">
          <b-switch
            v-if="unrankedCount > 0"
            v-model="showUnranked"
            size="is-small"
            type="is-info"
            left-label
          >
            Show new &amp; unranked
            <b-tag size="is-small" :type="showUnranked ? 'is-info' : 'is-info is-light'" rounded>{{ unrankedCount }}</b-tag>
          </b-switch>
        </b-tooltip>
        <span v-if="showUnranked && unrankedCount > 0" class="cell-sub" style="white-space:nowrap">new &amp; unranked shown inline (dimmed, no rank yet)</span>
        <!-- stats-87/89: OpenRouter-only census — open-weight models the
             catalog lists that no tracked benchmark scores. stats-89: ON by
             default and merged inline at the bottom of the table (the
             separate section made comparison hard); the switch hides/shows
             them, the control itself hides when the census is empty. -->
        <b-tooltip label="Open-weight models listed on OpenRouter that none of our tracked benchmarks score yet — identity, pricing and context info only, no scores. Shown inline below the ranking; they join the ranked board automatically when a benchmark covers them."
          type="is-dark" multilined :delay="100">
          <b-switch
            v-if="cardCount > 0"
            v-model="showCardModels"
            size="is-small"
            type="is-info"
            left-label
          >
            Show OpenRouter-only
            <b-tag size="is-small" :type="showCardModels ? 'is-info' : 'is-info is-light'" rounded>{{ cardCount }}</b-tag>
          </b-switch>
        </b-tooltip>
        <div class="row" style="gap:.6rem;align-items:center;flex:1;min-width:240px">
          <span class="cell-sub" style="white-space:nowrap">Min coverage</span>
          <input
            class="cl-slider"
            type="range"
            min="0"
            :max="100"
            :step="clStep"
            v-model.number="minCl"
            aria-label="Minimum coverage level (CL%)"
          />
          <b-tag size="is-small" :type="minCl ? 'is-info' : 'is-dark is-light'" rounded>
            {{ minCl ? 'CL ≥ ' + minCl + '%' : 'any CL' }}
          </b-tag>
        </div>

        <!-- Availability filters (stats-18): free listings, price cap, seller.
             Free ≠ unlimited — every "free" claim is a rate-limited free tier. -->
        <!-- stats-26: control hints as Buefy tooltips -->
        <b-tooltip label="Show only models with a free listing at some seller — free tiers are rate-limited, not unlimited"
          type="is-dark" multilined :delay="100">
          <b-switch v-model="freeOnly" size="is-small" type="is-success" left-label>
            Free
            <b-tag size="is-small" :type="freeOnly ? 'is-success' : 'is-success is-light'" rounded>{{ freeCount }}</b-tag>
          </b-switch>
        </b-tooltip>
        <b-tooltip label="Cap the blended API price (3:1 in:out, USD per 1M tokens). Free listings count as $0; unpriced rows hide while the cap is on."
          type="is-dark" multilined :delay="100" style="flex:1;min-width:230px">
          <div class="row" style="gap:.6rem;align-items:center">
            <span class="cell-sub" style="white-space:nowrap">Max price</span>
          <input
            class="cl-slider"
            type="range"
            min="0"
            max="100"
            step="1"
            v-model.number="priceSlider"
            aria-label="Maximum blended price per 1M tokens"
          />
          <b-tag size="is-small" :type="maxPrice != null ? 'is-info' : 'is-dark is-light'" rounded>
            {{ priceTag }}
          </b-tag>
          </div>
        </b-tooltip>
        <div class="row" style="gap:.4rem;align-items:center">
          <span class="cell-sub" style="white-space:nowrap">At seller</span>
          <b-select v-model="sellerId" size="is-small" aria-label="Filter by seller catalog">
            <option value="">Any seller</option>
            <option v-for="s in sellerOptions" :key="s.p" :value="s.p">{{ s.n }} ({{ s.c }})</option>
          </b-select>
        </div>

        <!-- stats-34: input-modality filter — unknown rows hide while on -->
        <b-tooltip :label="MOD_TOOLTIP" type="is-dark" multilined :delay="100">
          <div class="row" style="gap:.4rem;align-items:center">
            <span class="cell-sub" style="white-space:nowrap">Modalities</span>
            <b-select v-model="modFilter" size="is-small" aria-label="Filter by input modality">
              <option v-for="o in MOD_OPTIONS" :key="o.v" :value="o.v">{{ o.label }}{{ o.v ? ` (${modCount(o.v)})` : '' }}</option>
            </b-select>
          </div>
        </b-tooltip>

        <!-- stats-27: how fresh a release must be to carry the NEW badge —
             ONE shared window (lib/newFlag.js), the same setting the
             Providers tabs and model cards read -->
        <NewWindowSelect />

        <span class="cell-sub">Row opacity = benchmark coverage — hover a row to solidify it</span>

        <!-- stats-60: model tiers — ONE shared mode (lib/tiers.js), the
             same setting Compare rows and model cards read -->
        <TiersSelect />

        <!-- Avg set: which benchmarks feed the global Score (default = shipped formula).
             Parked on the FAR RIGHT so the opened panel can't cover the model-name column. -->
        <b-dropdown :triggers="['click']" :close-on-click="false" :mobile-modal="false" position="is-bottom-right" class="avg-dropdown" style="margin-left:auto" aria-role="list" aria-label="Choose which benchmarks count in the global Score">
          <template #trigger>
            <button class="button is-small avg-trigger" type="button" :class="isCustomAvg ? 'is-warning' : 'is-dark is-light'">
              <i class="fas fa-sliders"></i>
              <span style="margin-left:.5rem">Avg set · {{ avgLabel }}</span>
              <b-tag v-if="isCustomAvg" type="is-warning" size="is-small" rounded class="ml-2">custom</b-tag>
            </button>
          </template>

          <b-dropdown-item
            v-for="p in AVG_PRESETS"
            :key="p.id"
            aria-role="listitem"
            :class="{ 'is-active-preset': (p.id === 'default' && !isCustomAvg) || avgPresetId === p.id }"
            @click="applyPreset(p)"
          >
            <i class="fas" :class="((p.id === 'default' && !isCustomAvg) || avgPresetId === p.id) ? 'fa-circle-dot' : 'fa-circle-notch'"></i>
            {{ p.label }}
          </b-dropdown-item>

          <hr class="dropdown-divider" />
          <div class="avg-bench-list">
            <div v-for="b in benchmarks" :key="b" class="avg-bench-row">
              <b-checkbox
                :model-value="isInSel(b)"
                :disabled="isInSel(b) && selectedCount <= 1"
                @update:model-value="toggleAvgBench(b)"
              >
                {{ SHORT[b] || b }}
              </b-checkbox>
            </div>
          </div>

          <!-- stats-85: ECI reference column — same panel, different role.
               The checkboxes above drive the Score blend AND column
               visibility; the ECI checkbox is display-only (the index never
               feeds the Score, stats-82 contract). Default checked — ECI
               leads the table; unchecking hides the column, nothing else. -->
          <hr class="dropdown-divider" />
          <div class="avg-bench-row" style="padding:0 .9rem">
            <b-checkbox
              :model-value="showEci"
              @update:model-value="showEci = $event"
            >
              {{ SHORT['Epoch ECI'] }}&nbsp;<b-tag size="is-small" type="is-info is-light" rounded>index</b-tag>
            </b-checkbox>
            <p class="cell-sub" style="margin:.15rem 0 .2rem 1.75rem">
              Reference column only — never feeds the Score (Epoch AI, CC-BY 4.0). Uncheck to hide it from the table.
            </p>
          </div>

          <hr class="dropdown-divider" />
          <div style="padding:.4rem .9rem .7rem">
            <button class="button is-small is-fullwidth" type="button" :disabled="!isCustomAvg" @click="resetAvgSelection">
              <i class="fas fa-rotate-left"></i>&nbsp;Reset to default
            </button>
            <p class="cell-sub" style="margin:.45rem 0 0">Your pick drives Score, CL and the min-coverage filter. At least one benchmark stays selected.</p>
          </div>
        </b-dropdown>
      </div>
    </div>

    <!-- The table — older models render inline (dimmed, unranked) when toggled on;
         stats-90: the new & unranked census merges inline the same way while revealed -->
    <div class="mt">
      <PivotTable :rows="rows" :tier="tier" />
    </div>

    <p class="cell-sub mt-sm" style="text-align:center">
      Columns follow the Avg set — shown: {{ coreBenchmarks.map(b => SHORT[b] || b).join(', ') }}<span v-if="nonCoreBenchmarks.length">; hidden (opt in via the Avg set dropdown): {{ nonCoreBenchmarks.map(b => SHORT[b] || b).join(', ') }}</span>. The ECI reference column has its own checkbox in the same panel (stats-85: display-only, never in the Score).
      For the visual take, open the <router-link :to="{ name: 'value' }">Value map</router-link>.
      <router-link class="meth-link" :to="{ name: 'methodology', query: { s: 'score' } }">How to read every measure<i class="fas fa-arrow-up-right-from-square"></i></router-link>
    </p>

    <ComparePanel />

    <!-- Category leaders -->
    <div class="mt">
      <h2 class="section-title">Category leaders</h2>
      <p class="section-sub">Computed live from this snapshot. Click a card to open the model page.</p>
      <div class="grid-4">
        <div class="model-tile" v-for="card in leaders" :key="card.bench" @click="openModel(card.model)">
          <div class="tile-top">
            <div class="tag-lab">{{ card.short }}</div>
            <span class="av" :style="{ background: providerColor(card.model).color }">{{ initials(card.model) }}</span>
          </div>
          <h3 style="margin:.7rem 0 .15rem">{{ card.model }}</h3>
          <div style="color:var(--muted);font-size:.84rem">
            {{ providerColor(card.model).name }} · {{ card.count }} models scored
          </div>
          <div class="score-xl num mt-sm">{{ fmtScore(card.score) }}</div>
        </div>
      </div>
    </div>

    <p class="cell-sub" style="text-align:center">
      Decision support, not an official ranking.
      <router-link class="meth-link" :to="{ name: 'methodology', query: { s: 'honesty' } }">How this site works, honesty rules &amp; the full math<i class="fas fa-arrow-up-right-from-square"></i></router-link>
    </p>
  </section>
</template>
