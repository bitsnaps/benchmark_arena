<script setup>
// Providers page — two tabs over one catalog (providers.json):
//   Tab 1 "By provider" — the original per-provider cards ("who sells what").
//   Tab 2 "Compare"     — stats-18 pivot: one row per canonical model, one
//                         column per selected provider, so the same model's
//                         prices sit side by side and the cheapest seller is
//                         pickable at a glance. Rows are joined by
//                         src/lib/pivot.js (org-strip normalization + free-
//                         twin attach; see the lib header for discipline).
// Filters compose inside the Compare tab: search (shared), provider picker,
// free-only toggle, max-price slider. Free ≠ unlimited — every free chip
// carries the rate-limit caveat, and unpriced catalogs (NVIDIA NIM rows,
// OpenCode Zen) render honest dashes, never fabricated prices.
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { fmtUsd, fmtCtx } from '../lib/format.js';
import {
  buildMatrix, sortMatrixRows, filterMatrix, rowBlend, cellBlend, cheapestPid,
  latencyClass, DEFAULT_COLUMNS,
} from '../lib/pivot.js';
import { useProviders } from '../stores/providers.js';

const { rawData, loading, error, ensureProvidersLoaded } = useProviders();
onMounted(ensureProvidersLoaded);

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

// ── Tab 1: per-provider cards ─────────────────────────────────────────
// Filter across all providers at once: a row survives when the model id (or
// display name) matches; a provider survives while ≥1 of its rows does.
// Matching the provider name keeps every row of that provider (browse mode).
const filtered = computed(() => {
  const all = rawData.value?.providers || [];
  const term = norm(q.value).trim();
  if (!term) return all.map(p => ({ ...p, shown: p.models }));
  return all
    .map(p => {
      if (norm(p.name).includes(term)) return { ...p, shown: p.models };
      const shown = p.models.filter(m =>
        norm(m.id).includes(term) || (m.name && norm(m.name).includes(term)));
      return shown.length ? { ...p, shown } : null;
    })
    .filter(Boolean);
});

const grouped = computed(() => kinds.value
  .map(kind => ({ kind, providers: filtered.value.filter(p => p.kind === kind) }))
  .filter(g => g.providers.length));

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

const freeOnly = ref(false);

const matrix = computed(() => {
  if (!rawData.value || !selected.value) return null;
  const built = buildMatrix(allProviders.value, [...selected.value]);
  return { ...built, rows: sortMatrixRows(built.rows) };
});

// Price slider: 0..100 mapped CUBICALLY onto the row-blend range so the
// interesting sub-$10 zone gets most of the track; 100 (default) = no cap.
const SLIDER_EXP = 3;
const sliderVal = ref(100);
const sliderMaxPrice = computed(() => {
  if (!matrix.value) return 1;
  let m = 1;
  for (const r of matrix.value.rows) {
    const b = rowBlend(r);
    if (b != null && b > m) m = b;
  }
  return Math.max(1, Math.ceil(m));
});
const maxPrice = computed(() => {
  if (sliderVal.value >= 100) return null;
  return Math.round(sliderMaxPrice.value * Math.pow(sliderVal.value / 100, SLIDER_EXP) * 100) / 100;
});
const maxPriceLabel = computed(() =>
  maxPrice.value == null ? 'any price' : `≤ ${fmtUsd(maxPrice.value)}/1M blended`);

const visibleRows = computed(() => matrix.value
  ? filterMatrix(matrix.value.rows, { q: q.value, freeOnly: freeOnly.value, maxPrice: maxPrice.value })
  : []);

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

function cellTitle(r, pid) {
  const c = r.cells[pid];
  if (!c) return '';
  const who = byId.value[pid]?.name || pid;
  if (c.in != null) {
    const ctx = c.ctx ? ` · ctx ${fmtCtx(c.ctx)}` : '';
    const fr = c.free ? ' · free tier available (rate-limited)' : '';
    return `${who} — ${fmtUsd(c.in)} in / ${fmtUsd(c.out)} out per 1M tokens${ctx}${fr}`;
  }
  if (c.free) return `${who} — free tier, rate limits apply (not unlimited); the API exposes no price`;
  return `${who} — listed; the API exposes no price`;
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
          Browse seller by seller under "By provider", or switch to "Compare" for the
          pivot view: one row per model, one column per seller, cheapest cell highlighted.
        </p>
      </div>
      <span v-if="asOf" class="tag-lab">prices as of {{ asOf }}</span>
    </div>

    <div class="row mt" style="gap:.6rem;align-items:center">
      <b-input v-model="q" placeholder="Filter models or providers — e.g. opus, qwen, fireworks"
        icon="magnifying-glass" size="is-small" style="max-width:380px" />
      <span class="cell-sub">{{ totalShown }} of {{ totalRows }} catalog rows · {{ totalFree }} free listings</span>
    </div>

    <b-message v-if="error" type="is-danger" has-icon icon="triangle-exclamation" title="Error">
      {{ error }}
    </b-message>
    <b-loading :model-value="loading" :is-full-page="false" />

    <b-tabs v-model="tab" class="mt" size="is-small">

      <!-- ── Tab 1: the original per-provider listing ─────────────────── -->
      <b-tab-item label="By provider">
        <template v-if="!loading && !error">
          <div v-for="g in grouped" :key="g.kind" class="mt">
            <div class="row" style="gap:.6rem;align-items:baseline">
              <h2 class="prov-kind-title">{{ KIND_LABEL[g.kind] || g.kind }}</h2>
              <span class="cell-sub">{{ KIND_BLURB[g.kind] }} · {{ g.providers.length }} providers</span>
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
                  <tr v-for="m in p.shown" :key="p.id + m.id">
                    <td class="left">
                      <span class="prov-model">{{ m.name || m.id }}</span>
                      <span v-if="m.name && m.id !== m.name" class="prov-id">{{ m.id }}</span>
                      <span v-if="isFreeRow(m, p)" class="free-chip" :title="freeTitle(m)">free</span>
                    </td>
                    <td class="num">{{ fmtUsd(m.in) }}</td>
                    <td class="num">{{ fmtUsd(m.out) }}</td>
                    <td class="num cell-sub">{{ fmtCtx(m.ctx) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </template>
      </b-tab-item>

      <!-- ── Tab 2: Compare pivot — models × providers ────────────────── -->
      <b-tab-item label="Compare">
        <template v-if="!loading && !error && selected">
          <div class="row pm-controls mt">
            <span class="cell-sub">Columns:</span>
            <button v-for="p in allProviders" :key="p.id" type="button"
              class="pm-chip" :class="{ 'is-on': selected.has(p.id) }"
              :title="`${p.kind} · ${p.models.length} catalog rows${p.free_tier ? ' · whole catalog free, rate-limited' : ''}`"
              @click="toggleProvider(p.id)">
              {{ p.name }}<span class="pm-chip-n">{{ p.models.length }}</span>
            </button>
            <button type="button" class="pm-chip" title="Restore the default shortlist" @click="resetColumns">reset</button>
          </div>

          <div class="row pm-controls mt-sm" style="align-items:center">
            <b-switch v-model="freeOnly" size="is-small">free only</b-switch>
            <span class="cell-sub" style="margin-left:.4rem">max price</span>
            <b-slider v-model="sliderVal" :min="0" :max="100" :step="1" size="is-small"
              :tooltip="false" aria-label="maximum blended price per 1M tokens" style="max-width:240px" />
            <span class="cell-sub pm-price-label">{{ maxPriceLabel }}</span>
            <span class="is-flex-grow-1"></span>
            <span class="cell-sub pm-coverage">
              {{ matrix ? matrix.coverage.models : 0 }} canonical models ·
              {{ selProviders.length }} columns ·
              {{ matrix ? matrix.coverage.collapsed : 0 }} duplicate ids collapsed ·
              {{ visibleRows.length }} shown
            </span>
          </div>

          <div class="pm-wrap">
            <table class="prov-table pm-table">
              <thead>
                <tr>
                  <th class="left pm-model-col">Model</th>
                  <th v-for="p in selProviders" :key="p.id" class="pm-h"
                    :class="{ 'is-sorted': sortPid === p.id }"
                    :title="colHeaderTitle(p)" @click="sortBy(p.id)">
                    {{ p.name }}<span v-if="sortPid === p.id" class="pm-sort-arrow">{{ sortAsc ? ' ↑' : ' ↓' }}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in sortedRows" :key="r.key">
                  <td class="left pm-model-col">
                    <span class="prov-model">{{ r.name || r.key }}</span>
                    <span v-if="r.name && r.firstId && r.firstId !== r.name" class="prov-id">{{ r.firstId }}</span>
                  </td>
                  <td v-for="p in selProviders" :key="p.id" class="num pm-cell"
                    :class="[latencyClass(r.cells[p.id] && r.cells[p.id].latency), { 'is-cheapest': isCheapest(r, p.id) }]">
                    <template v-if="r.cells[p.id]">
                      <span v-if="r.cells[p.id].in != null" class="price-cell" :title="cellTitle(r, p.id)">
                        {{ fmtUsd(r.cells[p.id].in) }}<span class="price-sep">/</span>{{ fmtUsd(r.cells[p.id].out) }}
                      </span>
                      <span v-else class="cell-sub" :title="cellTitle(r, p.id)">—</span>
                      <span v-if="r.cells[p.id].free" class="free-chip" :title="freeTitle(r.cells[p.id])">free</span>
                    </template>
                    <span v-else class="pm-absent" :title="`${p.name} — not carried`">·</span>
                  </td>
                </tr>
                <tr v-if="!sortedRows.length">
                  <td :colspan="selProviders.length + 1" class="cell-sub" style="text-align:center;padding:1.2rem">
                    No models match the current filters — relax the search, price cap or column set.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <p class="cell-sub mt-sm" style="max-width:88ch">
            Rows are canonical models joined across sellers by normalized id — org prefix and
            punctuation stripped; <code>-free</code>/<code>:free</code> twins attach to their
            base model as a free tier. The highlighted cell is the cheapest known blend (3:1
            in:out) per row. NVIDIA NIM is a free tier (rate-limited); OpenCode Zen lists
            without prices. Latency coloring is wired but idle — none of these catalogs
            publishes per-model latency yet, so values stay gray until a real source exists.
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
