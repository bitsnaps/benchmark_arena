<script setup>
// Providers page — two tabs over one catalog (providers.json):
//   Tab 1 "By provider" — the original per-provider cards ("who sells what").
//   Tab 2 "Compare"     — stats-18 pivot: one row per canonical model, one
//                         column per selected provider, so the same model's
//                         prices sit side by side and the cheapest seller is
//                         pickable at a glance. Rows are joined by
//                         src/lib/pivot.js (org-strip normalization + free-
//                         twin attach; see the lib header for discipline).
// Filters compose on both tabs: search is shared, and the pricing filters
// (free-only toggle + max-price slider) are ONE reusable widget bound to a
// single shared state (lib/priceFilter.js, stats-23) — the By-provider tab
// and the Compare tab always agree. The Compare tab adds the provider
// picker and the batch-variants toggle. Free ≠ unlimited — every free chip
// carries the rate-limit caveat, and unpriced catalogs (NVIDIA NIM rows,
// OpenCode Zen) render honest dashes, never fabricated prices.
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { fmtUsd, fmtCtx, fmtSec } from '../lib/format.js';
import { passesPricing, priceUniverseBlend, usePriceFilter } from '../lib/priceFilter.js';
import { usePageSize } from '../lib/pager.js';
import { useData } from '../stores/data.js';
import AppPager from '../components/AppPager.vue';
import PriceFilterControls from '../components/PriceFilterControls.vue';
import {
  buildMatrix, sortMatrixRows, filterMatrix, cellBlend, cheapestPid,
  latencyClass, isBatchRow, DEFAULT_COLUMNS,
} from '../lib/pivot.js';
import { useProviders } from '../stores/providers.js';

const { rawData, loading, error, ensureProvidersLoaded } = useProviders();
onMounted(ensureProvidersLoaded);
// stats-24: AA TTFT lives in benchmark_results.json (models_meta), not in
// providers.json — pull the data store too (module singleton; the fetch is
// shared with the home view and happens once per session).
const { rawData: benchRaw, ensureLoaded } = useData();
onMounted(ensureLoaded);

const asOf = computed(() => rawData.value?.as_of || null);
const sources = computed(() => rawData.value?.sources || {});
const kinds = computed(() => rawData.value?.kinds || []);

const q = ref('');
const norm = (s) => String(s).toLowerCase();

// ── Tabs (deep-linkable: #/providers?view=compare) ────────────────────
const route = useRoute();
const router = useRouter();
const tab = ref(route.query.view === 'compare' ? 1 : 0);
watch(tab, (t) => {
  const next = { ...route.query };
  if (t === 1) next.view = 'compare';
  else delete next.view;
  if ((next.view || undefined) !== (route.query.view || undefined))
    router.replace({ query: next });
});
watch(() => route.query.view, (v) => { tab.value = v === 'compare' ? 1 : 0; });

// ── Pricing filters (stats-23): one shared state for both tabs ────────
// The free-only toggle and the max-price slider are the SAME widget on
// both tabs (PriceFilterControls → lib/priceFilter.js singleton), so a
// cap set on either tab applies everywhere. The slider's $ scale spans
// the whole catalog — the superset both tabs draw from — so one slider
// position means the same cap on either tab.
const { freeOnly, sliderVal, maxPrice } = usePriceFilter();
// 3:1 in:out blend for one catalog row — the same cellBlend convention the
// Compare pivot uses (free → $0, unpriced → null, never fabricated).
const rowBlendOf = (m, p) => cellBlend({ in: m.in, out: m.out, free: isFreeRow(m, p) });
const catalogMaxBlend = computed(() => {
  let m = 1;
  for (const p of (rawData.value?.providers || []))
    for (const mod of p.models) {
      const b = rowBlendOf(mod, p);
      if (b != null && b > m) m = b;
    }
  return Math.max(1, Math.ceil(m));
});
watch(catalogMaxBlend, (v) => { priceUniverseBlend.value = v; }, { immediate: true });

// ── Tab 1: per-provider cards ─────────────────────────────────────────
// Filter across all providers at once: a row survives when it passes the
// pricing filters AND — given a search term — the model id (or display
// name) matches; a provider survives while ≥1 of its rows does. A provider
// whose NAME matches keeps every surviving row of its own (browse mode).
// With no filter active the catalog returns untouched (fast path).
const filtered = computed(() => {
  const all = rawData.value?.providers || [];
  const term = norm(q.value).trim();
  const pricing = { freeOnly: freeOnly.value, maxPrice: maxPrice.value };
  const pass = (p, m) => passesPricing(m,
    { blend: rowBlendOf(m, p), free: isFreeRow(m, p) }, pricing);
  if (!term && !pricing.freeOnly && pricing.maxPrice == null)
    return all.map(p => ({ ...p, shown: p.models }));
  return all
    .map(p => {
      const browse = !!term && norm(p.name).includes(term);
      const shown = p.models.filter(m => pass(p, m) &&
        (browse || !term || norm(m.id).includes(term) ||
          (m.name && norm(m.name).includes(term))));
      // a provider with no surviving rows drops off the page — pricing
      // filters can empty even a name-matched (browse mode) seller
      return shown.length ? { ...p, shown } : null;
    })
    .filter(Boolean);
});

// ── stats-22: labs vs providers regroup ──────────────────────────────
// The approved taxonomy split: third-party "Providers" (cloud / serverless /
// aggregator kinds, still sub-grouped) come first; first-party "Labs" — the
// lab's own API, the reference price for each model — sit in their own
// section below. Unknown kinds (a future catalog addition) land on the
// provider side under their raw label, so a fresh scrape can't break the
// page structure.
const LAB_KIND = 'first-party';
const superGroups = computed(() => {
  const kindGroups = kinds.value
    .filter(k => k !== LAB_KIND)
    .map(kind => ({ kind, providers: filtered.value.filter(p => p.kind === kind) }))
    .filter(g => g.providers.length);
  const labs = filtered.value.filter(p => p.kind === LAB_KIND);
  const out = [];
  if (kindGroups.length) {
    const providers = kindGroups.flatMap(g => g.providers);
    out.push({
      id: 'providers', title: 'Providers',
      blurb: 'Third-party operators serving many labs\u2019 models',
      noun: 'providers', providers,
      rows: providers.reduce((a, p) => a + p.models.length, 0),
      free: providers.reduce((a, p) => a + freeCount(p), 0),
      groups: kindGroups.map(g => ({
        kind: g.kind, label: KIND_LABEL[g.kind] || g.kind,
        blurb: KIND_BLURB[g.kind] || '', providers: g.providers,
      })),
    });
  }
  if (labs.length) {
    out.push({
      id: 'labs', title: 'Labs',
      blurb: KIND_BLURB[LAB_KIND], noun: 'labs',
      providers: labs,
      rows: labs.reduce((a, p) => a + p.models.length, 0),
      free: labs.reduce((a, p) => a + freeCount(p), 0),
      groups: [{ kind: LAB_KIND, label: '', blurb: '', providers: labs }],
    });
  }
  return out;
});

// ── stats-22 (round 2): collapsible sections — Ibrahim: "place them
// (providers, labs...) in collapsible content with a brief summary stats at
// the header and expand/collapse all buttons". Each section folds to its
// header (which carries the stats); state persists per device; an active
// search force-expands so matches are never hidden.
const GROUPS_KEY = 'arena.providers.groups';
const collapsed = ref({ providers: false, labs: false });
try {
  const savedGroups = JSON.parse(localStorage.getItem(GROUPS_KEY) || '{}');
  for (const key of ['providers', 'labs'])
    if (typeof savedGroups[key] === 'boolean') collapsed.value[key] = savedGroups[key];
} catch { /* fresh visit / private mode */ }
function persistGroups() {
  try { localStorage.setItem(GROUPS_KEY, JSON.stringify(collapsed.value)); } catch { /* private mode */ }
}
function toggleSection(key) {
  collapsed.value = { ...collapsed.value, [key]: !collapsed.value[key] };
  persistGroups();
}
const expandAll = () => {
  collapsed.value = { providers: false, labs: false };
  persistGroups();
};
const collapseAll = () => {
  collapsed.value = { providers: true, labs: true };
  persistGroups();
};
const allExpanded = computed(() => superGroups.value.every(s => !collapsed.value[s.id]));
const allCollapsed = computed(() => superGroups.value.every(s => !!collapsed.value[s.id]));
// Search overlay: while the term is non-empty the sections display as
// expanded regardless of the stored state (header clicks keep writing to
// the store, so the choice applies once the search is cleared).
const searching = computed(() => !!norm(q.value).trim());
const isCollapsed = (key) => (searching.value ? false : !!collapsed.value[key]);

// Compare picker: chips clustered Providers / Labs in the same order.
const pickerProviders = computed(() => allProviders.value.filter(p => p.kind !== LAB_KIND));
const pickerLabs = computed(() => allProviders.value.filter(p => p.kind === LAB_KIND));

const totalShown = computed(() => filtered.value.reduce((a, p) => a + p.shown.length, 0));
const totalRows = computed(() => (rawData.value?.providers || []).reduce((a, p) => a + p.models.length, 0));
const totalFree = computed(() => (rawData.value?.providers || [])
  .reduce((a, p) => a + p.models.filter(m => isFreeRow(m, p)).length, 0));

// A row is a free listing when the catalog marked it ('-free'/':free' suffix
// or zero price) or the PROVIDER is a free tier (NVIDIA NIM — whole catalog
// free, rate-limited). Free ≠ unlimited — the tooltip carries the caveat.
function isFreeRow(m, p) {
  return !!m.free || !!p?.free_tier || (m.in === 0 && (m.out ?? 0) === 0);
}
function freeCount(p) {
  return p.shown.filter(m => isFreeRow(m, p)).length;
}
function freeTitle(mOrCell) {
  const base = mOrCell.base || mOrCell.freeBase;
  return `Free tier — rate limits apply, not unlimited${base ? ` — free listing of ${base}` : ''}`;
}

const KIND_LABEL = {
  'first-party': 'First-party labs',
  'cloud': 'Cloud platforms',
  'serverless': 'Serverless hosts',
  'aggregator': 'Aggregators & gateways',
};
const KIND_BLURB = {
  'first-party': 'The lab\u2019s own API — the reference price for each model.',
  'cloud': 'Enterprise platforms hosting many labs\u2019 models behind enterprise terms.',
  'serverless': 'Specialist GPU hosts competing on price and speed for open-weight models.',
  'aggregator': 'One API over many sellers — convenient, usually with a routing margin on top.',
};

// ── Tab 2: Compare pivot (models × providers) ─────────────────────────
const PICKER_KEY = 'providers-compare-columns';
const allProviders = computed(() => rawData.value?.providers || []);
const byId = computed(() => Object.fromEntries(allProviders.value.map(p => [p.id, p])));
// stats-24: AA median TTFT lives in models_meta (bench_scraper.py mining);
// fed into the pivot join so the pre-built latency color ladder activates.
const modelsMeta = computed(() => benchRaw.value?.models_meta || {});

const selected = ref(null); // Set<providerId>
const initSelected = () => {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(PICKER_KEY) || '[]'); } catch { /* fresh */ }
  const valid = saved.filter(id => byId.value[id]);
  selected.value = new Set(valid.length ? valid : DEFAULT_COLUMNS.filter(id => byId.value[id]));
};
watch(rawData, (v) => { if (v && !selected.value) initSelected(); }, { immediate: true });

function toggleProvider(id) {
  const next = new Set(selected.value);
  if (next.has(id)) {
    if (next.size <= 1) return; // keep at least one column
    next.delete(id);
  } else {
    next.add(id);
  }
  selected.value = next;
  try { localStorage.setItem(PICKER_KEY, JSON.stringify([...next])); } catch { /* private mode */ }
}
function resetColumns() {
  selected.value = new Set(DEFAULT_COLUMNS.filter(id => byId.value[id]));
  try { localStorage.removeItem(PICKER_KEY); } catch { /* private mode */ }
}

// stats-19: pricing-mode variants (OpenRouter ':batch' ids — async endpoints
// of the SAME model at a discount) are hidden by default so the default view
// compares standard endpoints; the toggle reveals them. (The pricing filters
// themselves live once, above — freeOnly/sliderVal/maxPrice are shared.)
const showBatch = ref(false);

const matrix = computed(() => {
  if (!rawData.value || !selected.value) return null;
  const built = buildMatrix(allProviders.value, [...selected.value], modelsMeta.value);
  return { ...built, rows: sortMatrixRows(built.rows) };
});

const visibleRows = computed(() => {
  if (!matrix.value) return [];
  const rows = filterMatrix(matrix.value.rows,
    { q: q.value, freeOnly: freeOnly.value, maxPrice: maxPrice.value });
  return showBatch.value ? rows : rows.filter(r => !isBatchRow(r));
});
// Batch rows currently hidden by the default (toggle off) — surfaced in the
// coverage line so the hidden rows stay accounted for.
const batchHidden = computed(() => matrix.value
  ? matrix.value.rows.filter(r => isBatchRow(r)).length : 0);

const selProviders = computed(() =>
  (selected.value ? [...selected.value].map(id => byId.value[id]).filter(Boolean) : []));

// rows carried per selected column (header tooltips)
const colCounts = computed(() => {
  const counts = {};
  if (!matrix.value) return counts;
  for (const r of matrix.value.rows)
    for (const pid of Object.keys(r.cells)) counts[pid] = (counts[pid] || 0) + 1;
  return counts;
});

// column sorting: default = coverage desc (sortMatrixRows); clicking a
// provider header sorts by that column's blend (cheapest first), again to
// flip, a third time back to the default.
const sortPid = ref(null);
const sortAsc = ref(true);
function sortBy(pid) {
  if (sortPid.value === pid) {
    if (sortAsc.value) sortAsc.value = false;
    else { sortPid.value = null; sortAsc.value = true; }
  } else {
    sortPid.value = pid;
    sortAsc.value = true;
  }
  page.value = 1; // sorted order changes — start from the top
}
const sortedRows = computed(() => {
  const rows = visibleRows.value;
  if (!sortPid.value) return rows;
  const pid = sortPid.value;
  return [...rows].sort((a, b) => {
    const av = cellBlend(a.cells[pid]);
    const bv = cellBlend(b.cells[pid]);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return sortAsc.value ? av - bv : bv - av;
  });
});

// ── Pagination (stats-20, unified in stats-21) ────────────────────────────────────────
// Manual client-side paging over the sorted pivot rows (plain table, no
// b-table here). The page size is the app-wide shared setting from
// lib/pager.js; 0 = All (the pre-pagination full scroll). Any
// filter/search/sort change lands back on page 1.
const pageSize = usePageSize();
const page = ref(1);
const pagedRows = computed(() => (pageSize.value === 0
  ? sortedRows.value
  : sortedRows.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value)));
watch([q, freeOnly, showBatch, sliderVal, selected], () => { page.value = 1; });

// Per-provider cards (tab 1) page their own model tables with the same
// pager and the same app-wide page size; cards that fit on one page stay
// quiet. Each card owns its page pointer; any search/size change wipes them
// so nobody lands on an empty page.
const cardPages = ref({});
const pageOf = (p) => cardPages.value[p.id] || 1;
const setCardPage = (p, n) => { cardPages.value = { ...cardPages.value, [p.id]: n }; };
const pagedShown = (p) => (pageSize.value === 0
  ? p.shown
  : p.shown.slice((pageOf(p) - 1) * pageSize.value, pageOf(p) * pageSize.value));
const needsPager = (p) => pageSize.value !== 0 && p.shown.length > pageSize.value;
// filter changes (search, size, pricing) wipe card page pointers so
// nobody lands on an empty page after the list reshapes
watch([q, pageSize, freeOnly, sliderVal], () => { cardPages.value = {} });

function cellTitle(r, pid) {
  const c = r.cells[pid];
  if (!c) return '';
  const who = byId.value[pid]?.name || pid;
  // stats-24: AA median TTFT (per-model — the same value on every seller cell)
  const lat = c.latency != null ? ` · AA TTFT ${fmtSec(c.latency)} (median, Artificial Analysis)` : '';
  if (c.in != null) {
    const ctx = c.ctx ? ` · ctx ${fmtCtx(c.ctx)}` : '';
    const fr = c.free ? ' · free tier available (rate-limited)' : '';
    return `${who} — ${fmtUsd(c.in)} in / ${fmtUsd(c.out)} out per 1M tokens${ctx}${fr}${lat}`;
  }
  if (c.free) return `${who} — free tier, rate limits apply (not unlimited); the API exposes no price${lat}`;
  return `${who} — listed; the API exposes no price${lat}`;
}
// Row hover tooltip: the full name is the only displayed format (stats-19);
// the raw API id(s) behind this canonical row surface here instead.
function rowTitle(r) {
  const ids = (r.ids || []).filter(Boolean);
  const idBit = ids.length ? `API id: ${ids.join(', ')}` : `Row key: ${r.key}`;
  const batch = isBatchRow(r) ? ' (batch pricing variant)' : '';
  return `${r.name || r.key}${batch} — ${idBit}`;
}
const isCheapest = (r, pid) => {
  const cp = cheapestPid(r);
  return cp !== null && cp === pid && Object.keys(r.cells).length > 1;
};
const colHeaderTitle = (p) => {
  const bits = [`${p.name} — ${colCounts.value[p.id] || 0} matched models in view`];
  if (p.free_tier) bits.push('whole catalog free, rate-limited');
  if (p.edge_rtt_ms != null)
    bits.push(`edge RTT ${p.edge_rtt_ms} ms from scrape node (network round-trip, NOT model latency)`);
  return bits.join(' · ');
};
// stats-26: column-picker chip hover (kind + catalog size + free-tier note)
const pickerTitle = (p) =>
  `${p.kind} · ${p.models.length} catalog rows${p.free_tier ? ' · whole catalog free, rate-limited' : ''}`;
</script>

<template>
  <section>
    <div class="crumbs">
      <router-link class="crumb" :to="{ name: 'home' }"><i class="fas fa-arrow-left"></i> Leaderboard</router-link>
      <span class="crumb-sep">/</span>
      <span class="crumb current">Providers</span>
    </div>

    <div class="row" style="justify-content:space-between;align-items:flex-end">
      <div>
        <h1 class="section-title" style="margin:0">AI Providers &amp; Pricing</h1>
        <p class="cell-sub mt-sm" style="max-width:64ch">
          Who sells which model, at what price — USD per 1M tokens, input / output.
          Sellers are grouped into third-party <b>Providers</b> (cloud, serverless,
          aggregators) and first-party <b>Labs</b> — the reference price for each model.
          The free-only and max-price filters sit on both tabs and stay in sync.
          Or switch to "Compare" for the pivot view: one row per model, one column
          per seller, cheapest cell highlighted.
        </p>
      </div>
      <span v-if="asOf" class="tag-lab">prices as of {{ asOf }}</span>
    </div>

    <div class="row mt" style="gap:.6rem;align-items:center">
      <b-input v-model="q" placeholder="Filter models or providers — e.g. opus, qwen, fireworks"
        icon="magnifying-glass" size="is-small" style="max-width:380px" />
      <span class="cell-sub">{{ totalShown }} of {{ totalRows }} catalog rows · {{ totalFree }} free listings</span>
      <span class="is-flex-grow-1"></span>
      <!-- stats-21: one app-wide page size — this view inherits it; the
           cards below render their own pagers without repeating the control -->
      <div class="prov-size" style="display:flex;align-items:center;gap:.45rem">
        <span class="cell-sub">rows per page</span>
        <b-select v-model.number="pageSize" size="is-small" aria-label="rows per page">
          <option :value="20">20</option>
          <option :value="50">50</option>
          <option :value="100">100</option>
          <option :value="0">All</option>
        </b-select>
      </div>
    </div>

    <b-message v-if="error" type="is-danger" has-icon icon="triangle-exclamation" title="Error">
      {{ error }}
    </b-message>
    <b-loading :model-value="loading" :is-full-page="false" />

    <b-tabs v-model="tab" class="mt" size="is-small">

      <!-- ── Tab 1: the original per-provider listing ─────────────────── -->
      <b-tab-item label="By provider">
        <template v-if="!loading && !error">
          <!-- stats-23: the pricing filters — the SAME reusable widget as the
               Compare tab (PriceFilterControls → lib/priceFilter.js), one
               shared state, so both tabs always agree -->
          <div v-if="superGroups.length" class="row pv-controls mt-sm">
            <PriceFilterControls />
          </div>

          <!-- stats-22 round 2: expand/collapse all -->
          <div v-if="superGroups.length" class="row mt-sm" style="gap:.45rem;align-items:center">
            <button type="button" class="prov-expbtn" :disabled="allExpanded" @click="expandAll">Expand all</button>
            <button type="button" class="prov-expbtn" :disabled="allCollapsed" @click="collapseAll">Collapse all</button>
          </div>

          <!-- stats-22: labs vs providers regroup — collapsible sections,
              each header carries brief summary stats -->
          <div v-for="sg in superGroups" :key="sg.id" class="prov-super mt">
            <button type="button" class="prov-section-head" @click="toggleSection(sg.id)"
              :aria-expanded="!isCollapsed(sg.id)">
              <i class="fas prov-chevron" :class="isCollapsed(sg.id) ? 'fa-chevron-right' : 'fa-chevron-down'"></i>
              <h2 class="prov-super-title">{{ sg.title }}</h2>
              <span class="prov-sec-n">{{ sg.providers.length }}</span>
              <span class="cell-sub prov-sec-stats">{{ sg.rows }} models · {{ sg.free }} free</span>
              <span class="prov-sec-desc">{{ sg.blurb }}</span>
            </button>

            <div v-show="!isCollapsed(sg.id)" class="prov-section-body">
              <template v-for="g in sg.groups" :key="sg.id + ':' + g.kind">
                <div v-if="g.label" class="row mt" style="gap:.6rem;align-items:baseline">
                  <h3 class="prov-kind-title">{{ g.label }}</h3>
                  <span class="cell-sub">{{ g.blurb }} · {{ g.providers.length }} providers</span>
                </div>

                <div v-for="p in g.providers" :key="p.id" class="panel-lab prov-card">
                  <div class="row" style="justify-content:space-between">
                    <h3 class="prov-name">{{ p.name }}</h3>
                    <span class="cell-sub">{{ p.shown.length }} model{{ p.shown.length === 1 ? '' : 's' }}<template v-if="freeCount(p)"> · {{ freeCount(p) }} free</template></span>
                  </div>
                  <table class="prov-table">
                    <thead>
                      <tr>
                        <th class="left">Model</th>
                        <th>$/1M in</th>
                        <th>$/1M out</th>
                        <th>Context</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="m in pagedShown(p)" :key="p.id + m.id">
                        <td class="left">
                          <span class="prov-model">{{ m.name || m.id }}</span>
                          <span v-if="m.name && m.id !== m.name" class="prov-id">{{ m.id }}</span>
                          <b-tooltip v-if="isFreeRow(m, p)" :label="freeTitle(m)" type="is-dark" :delay="100">
                            <span class="free-chip">free</span>
                          </b-tooltip>
                        </td>
                        <td class="num">{{ fmtUsd(m.in) }}</td>
                        <td class="num">{{ fmtUsd(m.out) }}</td>
                        <td class="num cell-sub">{{ fmtCtx(m.ctx) }}</td>
                      </tr>
                    </tbody>
                  </table>

                  <!-- stats-21: oversized cards page their model table with the
                       one pager (bottom-right, numbers between the arrows); the
                       rows-per-page control lives once, at the top of this tab -->
                  <AppPager v-if="needsPager(p)" :show-size="false"
                    :total="p.shown.length" :page="pageOf(p)" @update:page="setCardPage(p, $event)"
                    :aria-label="p.name + ' pagination'" />
                </div>
              </template>
            </div>
          </div>
        </template>
      </b-tab-item>

      <!-- ── Tab 2: Compare pivot — models × providers ────────────────── -->
      <b-tab-item label="Compare">
        <template v-if="!loading && !error && selected">
          <!-- stats-22: chips clustered Providers / Labs, same order as tab 1 -->
          <div class="row pm-controls mt">
            <span class="cell-sub">Columns:</span>
            <span class="pm-chip-group">Providers</span>
            <b-tooltip v-for="p in pickerProviders" :key="p.id" :label="pickerTitle(p)"
              type="is-dark" multilined :delay="100">
              <button type="button" class="pm-chip" :class="{ 'is-on': selected.has(p.id) }"
                @click="toggleProvider(p.id)">
                {{ p.name }}<span class="pm-chip-n">{{ p.models.length }}</span>
              </button>
            </b-tooltip>
            <span class="pm-chip-group">Labs</span>
            <b-tooltip v-for="p in pickerLabs" :key="p.id" :label="pickerTitle(p)"
              type="is-dark" multilined :delay="100">
              <button type="button" class="pm-chip" :class="{ 'is-on': selected.has(p.id) }"
                @click="toggleProvider(p.id)">
                {{ p.name }}<span class="pm-chip-n">{{ p.models.length }}</span>
              </button>
            </b-tooltip>
            <b-tooltip label="Restore the default shortlist" type="is-dark" :delay="100">
              <button type="button" class="pm-chip" @click="resetColumns">reset</button>
            </b-tooltip>
          </div>

          <div class="row pm-controls mt-sm" style="align-items:center">
            <!-- stats-23: the same pricing widget as the By-provider tab —
                 one shared state, the tabs always agree -->
            <PriceFilterControls />
            <b-tooltip label="Show ':batch' pricing variants — async endpoints of the same model at a discounted price"
              type="is-dark" multilined :delay="100">
              <b-switch v-model="showBatch" size="is-small">batch variants</b-switch>
            </b-tooltip>
            <span class="is-flex-grow-1"></span>
            <span class="cell-sub pm-coverage">
              {{ matrix ? matrix.coverage.models : 0 }} canonical models ·
              {{ selProviders.length }} columns ·
              {{ matrix ? matrix.coverage.collapsed : 0 }} duplicate ids collapsed ·
              {{ visibleRows.length }} shown<span v-if="!showBatch && batchHidden"> · {{ batchHidden }} batch variants hidden</span>
            </span>
          </div>

          <div class="pm-wrap">
            <table class="prov-table pm-table">
              <thead>
                <tr>
                  <th class="left pm-model-col">Model</th>
                  <th v-for="p in selProviders" :key="p.id" class="pm-h"
                    :class="{ 'is-sorted': sortPid === p.id }"
                    @click="sortBy(p.id)">
                    <!-- stats-26: inline tooltip (no append-to-body — is-auto
                         opens it downward INSIDE the scroll wrap, and every
                         teleported instance is quadratic-cost at "All" size) -->
                    <b-tooltip :label="colHeaderTitle(p)" type="is-dark" multilined :delay="100">
                      {{ p.name }}<span v-if="sortPid === p.id" class="pm-sort-arrow">{{ sortAsc ? ' ↑' : ' ↓' }}</span>
                    </b-tooltip>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in pagedRows" :key="r.key">
                  <td class="left pm-model-col">
                    <!-- one name format: the full model name; the raw API id
                         lives in the hover tooltip (stats-19) -->
                    <!-- stats-26: inline tooltip — see the header note on the
                         append-to-body cost tradeoff -->
                    <b-tooltip :label="rowTitle(r)" type="is-dark" multilined :delay="100">
                      <span class="prov-model">{{ r.name || r.key }}</span>
                    </b-tooltip>
                  </td>
                  <td v-for="p in selProviders" :key="p.id" class="num pm-cell"
                    :class="[latencyClass(r.cells[p.id] && r.cells[p.id].latency), { 'is-cheapest': isCheapest(r, p.id) }]">
                    <template v-if="r.cells[p.id]">
                      <!-- stats-25/26: EVERY cell hover is a Buefy tooltip —
                           native titles need a ~1s OS hover and never show on
                           touch; append-to-body escapes the scroll wrapper,
                           is-auto picks the safest side near viewport edges.
                           Priced cells, dashes, chips, row names and column
                           headers all share the same recipe. -->
                      <b-tooltip v-if="r.cells[p.id].in != null"
                        :label="cellTitle(r, p.id)" type="is-dark" multilined
                        :delay="100" append-to-body>
                        <span class="price-cell">
                          {{ fmtUsd(r.cells[p.id].in) }}<span class="price-sep">/</span>{{ fmtUsd(r.cells[p.id].out) }}
                        </span>
                      </b-tooltip>
                      <b-tooltip v-else :label="cellTitle(r, p.id)" type="is-dark" multilined
                        :delay="100" append-to-body>
                        <span class="cell-sub">—</span>
                      </b-tooltip>
                      <b-tooltip v-if="r.cells[p.id].free" :label="freeTitle(r.cells[p.id])"
                        type="is-dark" :delay="100" append-to-body>
                        <span class="free-chip">free</span>
                      </b-tooltip>
                    </template>
                    <!-- stats-26 tradeoff: the absent dot is the one marker that
                         KEEPS its native title — at "All" page size the Compare
                         grid would mount ~4.5k extra append-to-body tooltip
                         instances (each with its own ResizeObserver + teleported
                         node) and Buefy's appendToBody machinery deadlocks the
                         renderer at that scale; a dot tooltip is not worth it -->
                    <span v-else class="pm-absent" :title="`${p.name} — not carried`">·</span>
                  </td>
                </tr>
                <tr v-if="!pagedRows.length">
                  <td :colspan="selProviders.length + 1" class="cell-sub" style="text-align:center;padding:1.2rem">
                    No models match the current filters — relax the search, price cap or column set.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- stats-21: unified bottom-right pager — totals stay in the
               coverage line above -->
          <div class="pm-pager mt-sm" v-if="sortedRows.length">
            <AppPager v-model:page="page" :total="sortedRows.length" aria-label="Compare pagination" />
          </div>

          <p class="cell-sub mt-sm" style="max-width:88ch">
            Rows are canonical models joined across sellers by normalized id — org prefix and
            punctuation stripped; <code>-free</code>/<code>:free</code> twins attach to their
            base model as a free tier. The highlighted cell is the cheapest known blend (3:1
            in:out) per row. <code>:batch</code> pricing variants (async endpoints of the same
            model at a discount) are hidden behind the <b>batch variants</b> toggle. NVIDIA NIM
            is a free tier (rate-limited); OpenCode Zen lists without prices.
            <b>Latency tint</b> (stats-24): price cells are colored by AA's median
            time-to-first-token — measured by Artificial Analysis, 60 models —
            <span class="lat-fast legend-chip">&lt; 1.5 s</span>
            <span class="lat-ok legend-chip">1.5–3.5 s</span>
            <span class="lat-slow legend-chip">≥ 3.5 s</span>;
            hover any cell for the exact value. Unmeasured models stay gray.
          </p>
        </template>
      </b-tab-item>
    </b-tabs>

    <p class="cell-sub mt" style="text-align:center">
      Catalog: {{ sources.catalog }} · Aggregator section: {{ sources.aggregator }}<template v-if="sources.apis"> · {{ sources.apis }}</template>.
      Prices move often — refresh the snapshot before budgeting anything serious.
      Free listings are rate-limited, not unlimited.
    </p>
  </section>
</template>
