<script setup>
// Home = the leaderboard. Compact snapshot header, tier tabs, the global
// pivot table, compare panel, then context: category leaders, methodology.
// Tier tabs live in the URL as ?tier=, search as ?q=, the custom average
// mix as ?avg= (comma-separated benchmark slugs), and the availability
// filters as ?free=1 / ?price=<max blend> / ?seller=<provider slug>.
import { computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { TIERS, SHORT, AVG_PRESETS } from '../lib/constants.js';
import { slugify, fmtScore, fmtUsd, providerColor, initials } from '../lib/format.js';
import { useData } from '../stores/data.js';
import { useLeaderboard } from '../stores/leaderboard.js';
import PivotTable from '../components/PivotTable.vue';
import ComparePanel from '../components/ComparePanel.vue';

const route = useRoute();
const router = useRouter();

const { pivotFor, pivotAll, stats, topOverall, topOpen, scoreForModel, clForModel, leaders, coreBenchmarks, nonCoreBenchmarks, benchmarks, avgSelection, isCustomAvg, avgPresetId, applyPreset, toggleAvgBench, resetAvgSelection, applyAvgParam, loading, isOlder, priceFor, availableAtFor, hasFreeListingFor, filterPriceFor } = useData();
const { searchQuery, compareMode, compareRows, showOlder, minCl, freeOnly, maxPrice, sellerId } = useLeaderboard();

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

// Free-listing count for the toggle tag: current tier, current generation
const freeCount = computed(() =>
  pivotFor(tier.value).filter(r => !isOlder(r) && hasFreeListingFor(r)).length);

// Seller dropdown options: every seller that lists at least one
// current-generation model, busiest first (tier-independent)
const sellerOptions = computed(() => {
  const counts = new Map();
  for (const r of pivotAll.value) {
    if (isOlder(r)) continue;
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
    if (mp != null) {
      // free listings count as $0 so a free row survives any cap
      const p = filterPriceFor(r);
      if (p === null || p > mp) return false;
    }
    return true;
  });
};

const rows = computed(() => {
  const all = applyFilters(pivotFor(tier.value));
  if (!showOlder.value) return all.filter(r => !isOlder(r));
  // Toggle on: pre-sort the merged list by the CL-weighted score so older
  // models sit at their true rank position (the table's interactive sort
  // takes over from there).
  return [...all].sort((a, b) => (scoreForModel(b) ?? -1) - (scoreForModel(a) ?? -1));
});

const olderCount = computed(() =>
  pivotFor(tier.value).filter(r => isOlder(r)).length);

const openModel = (name) =>
  router.push({ name: 'model', params: { slug: slugify(name) } });
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

        <span class="cell-sub">Row opacity = benchmark coverage — hover a row to solidify it</span>

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

    <!-- The table — older models render inline (dimmed, unranked) when toggled on -->
    <div class="mt">
      <PivotTable :rows="rows" :tier="tier" />
    </div>

    <p class="cell-sub mt-sm" style="text-align:center">
      CL = Coverage Level (core benchmarks present / {{ stats.coreBenchmarks }}).
      Columns follow the Avg set — shown: {{ coreBenchmarks.map(b => SHORT[b] || b).join(', ') }}.
      <span v-if="nonCoreBenchmarks.length">Hidden (opt in via the Avg set dropdown): {{ nonCoreBenchmarks.map(b => SHORT[b] || b).join(', ') }}.</span>
      Price = API list price per 1M tokens, in / out (OpenRouter snapshot) — <router-link :to="{ name: 'providers' }">compare sellers</router-link>.
      Value = Score per 1M blended tokens (3:1 in:out) — sort by it for the cost-efficiency view; free tiers and unpriced rows show a dash.
      <span class="hf-chip" style="cursor:default">HF</span> = the model's Hugging Face repo (open-weight models with a verified repo).
      <b-tooltip label="Free tier — rate limits apply, not unlimited" type="is-dark" :delay="100"><span class="free-chip" style="cursor:default">free</span></b-tooltip> = a free listing at some seller (hover for where);
      <span class="avail-chip" style="cursor:default">N sellers</span> = other catalogs listing the model — the full per-seller view is on its model page.
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

    <!-- Methodology -->
    <div class="grid-2 mt">
      <div class="panel-lab" style="padding:1.2rem">
        <h3 style="margin:0 0 .4rem">How the Score column works</h3>
        <p style="color:var(--muted);font-size:.92rem">
          Score is the raw average over the benchmarks in the current avg set ({{ avgLabel.toLowerCase() }}) that a
          model actually reports, CL-weighted: it is blended toward a neutral 50 baseline in proportion to the
          model's Coverage Level (CL). A fully-covered model (CL 100%) keeps its plain
          average; a model covering 2 of {{ selectedCount }} selected evals only keeps {{ Math.round((2 / selectedCount) * 100) }}% of its edge above
          50. This offsets selection bias — without it, models evaluated on a few
          favorable leaderboards outrank frontier models tested across the board.
          Missing evals are treated as “no evidence” (neutral), never as a zero.
          Use the “Avg set” dropdown in the toolbar to swap which benchmarks feed the Score —
          the shipped default is unchanged for everyone who never touches it.
        </p>
      </div>
      <div class="panel-lab" style="padding:1.2rem">
        <h3 style="margin:0 0 .4rem">Benchmarks in the average</h3>
        <div class="chips mt-sm">
          <span class="tag-lab teal" v-for="b in coreBenchmarks" :key="b">{{ SHORT[b] || b }}</span>
          <span class="tag-lab" v-for="b in nonCoreBenchmarks" :key="b">{{ SHORT[b] || b }}</span>
        </div>
        <p class="cell-sub mt-sm">Teal = counted in the global Score and shown as a table column. Grey = hidden from the table until selected in the Avg set dropdown (still on the Benchmarks page, model cards and compare panel).</p>
      </div>
    </div>

    <div class="notice mt">
      <i class="fas fa-circle-info"></i>
      Scores are aggregated from public leaderboards and normalized where possible.
      This is decision support, not an official ranking — verify the source leaderboard
      before committing budget.
    </div>
  </section>
</template>
