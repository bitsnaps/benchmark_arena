<script setup>
// Leaderboard — global pivot table with tier tabs.
// Tabs are synced to the route (/leaderboard/all|closed|open) so each
// slice is deep-linkable and the browser back button works.
import { computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { TIERS, SHORT } from '../lib/constants.js';
import { useData } from '../stores/data.js';
import { useLeaderboard } from '../stores/leaderboard.js';
import PivotTable from '../components/PivotTable.vue';
import ComparePanel from '../components/ComparePanel.vue';

const route = useRoute();
const router = useRouter();

const { pivotFor, stats, coreBenchmarks, nonCoreBenchmarks } = useData();
const { searchQuery, compareMode, compareRows } = useLeaderboard();

// ── Tier tab ⇄ route param ────────────────────────────────────────────
const tier = computed(() =>
  TIERS.some(t => t.value === route.params.tier) ? route.params.tier : 'all');

const activeTier = computed({
  get: () => tier.value,
  set: (v) => {
    if (!v || v === tier.value) return;
    router.push({ name: 'leaderboard', params: { tier: v }, query: route.query });
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

// ── Rows for the active tab ───────────────────────────────────────────
const rows = computed(() => {
  const base = pivotFor(tier.value);
  if (!searchQuery.value) return base;
  const q = searchQuery.value.toLowerCase();
  return base.filter(r => r.name.toLowerCase().includes(q));
});
</script>

<template>
  <section>
    <div class="page-head">
      <div class="kicker">Global overall</div>
      <h1 class="section-title">Leaderboard</h1>
      <p class="section-sub">
        Every model in one table, or sliced by license. Click a row's checkbox to line models up side by side.
      </p>
    </div>

    <b-tabs v-model="activeTier" type="is-toggle" multiline class="tier-tabs">
      <b-tab-item
        v-for="t in TIERS"
        :key="t.value"
        :value="t.value"
        :label="t.label"
        :icon="t.icon"
      />
    </b-tabs>

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
    </div>

    <div class="mt">
      <PivotTable :rows="rows" :tier="tier" />
    </div>

    <p class="cell-sub mt-sm" style="text-align:center">
      CL = Coverage Level (core benchmarks present / {{ stats.coreBenchmarks }}).
      Core: {{ coreBenchmarks.map(b => SHORT[b] || b).join(', ') }}.
      Context-only: {{ nonCoreBenchmarks.map(b => SHORT[b] || b).join(', ') }}.
    </p>

    <ComparePanel />
  </section>
</template>
