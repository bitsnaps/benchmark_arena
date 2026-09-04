<script setup>
// Home = the leaderboard. Compact snapshot header, tier tabs, the global
// pivot table, compare panel, then context: category leaders, methodology.
// Tier tabs live in the URL as ?tier= (all | closed | open).
import { computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { TIERS, SHORT } from '../lib/constants.js';
import { slugify, fmtScore, providerColor, initials } from '../lib/format.js';
import { useData } from '../stores/data.js';
import { useLeaderboard } from '../stores/leaderboard.js';
import PivotTable from '../components/PivotTable.vue';
import ComparePanel from '../components/ComparePanel.vue';

const route = useRoute();
const router = useRouter();

const { pivotFor, stats, topOverall, topOpen, scoreForModel, leaders, coreBenchmarks, nonCoreBenchmarks, isOlder } = useData();
const { searchQuery, compareMode, compareRows, showOlder, minCl } = useLeaderboard();

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

// ── Rows for the active tab ───────────────────────────────────────────
// One ranked listing. Older releases — superseded versions of the same
// product line plus stale generations (9+ months old, no successor in the
// data) — are hidden by default; the Older-versions toggle interleaves them
// INLINE at their natural score position (dimmed, no rank, "older" chip),
// so there is no separate section to scroll to. Both modes respect the
// search box and the min-CL slider; nothing is deleted.
const applyFilters = (list) => {
  const q = searchQuery.value.toLowerCase();
  return list.filter(r =>
    (r.cl ?? 0) >= minCl.value && (!q || r.name.toLowerCase().includes(q)));
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
        <div class="sub">Score {{ topOverall ? fmtScore(scoreForModel(topOverall)) : '—' }} · CL-weighted, {{ topOverall ? Math.round(topOverall.cl) : '—' }}% coverage</div>
      </div>
      <div class="stat">
        <div class="lbl">Top open-weight</div>
        <div class="val" style="font-size:1.15rem">{{ topOpen ? topOpen.name : '—' }}</div>
        <div class="sub">Score {{ topOpen ? fmtScore(scoreForModel(topOpen)) : '—' }} · CL-weighted, {{ topOpen ? Math.round(topOpen.cl) : '—' }}% coverage</div>
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
            max="100"
            step="12.5"
            v-model.number="minCl"
            aria-label="Minimum coverage level (CL%)"
          />
          <b-tag size="is-small" :type="minCl ? 'is-info' : 'is-dark is-light'" rounded>
            {{ minCl ? 'CL ≥ ' + minCl + '%' : 'any CL' }}
          </b-tag>
        </div>
        <span class="cell-sub">Row opacity = benchmark coverage — hover a row to solidify it</span>
      </div>
    </div>

    <!-- The table — older models render inline (dimmed, unranked) when toggled on -->
    <div class="mt">
      <PivotTable :rows="rows" :tier="tier" />
    </div>

    <p class="cell-sub mt-sm" style="text-align:center">
      CL = Coverage Level (core benchmarks present / {{ stats.coreBenchmarks }}).
      Core: {{ coreBenchmarks.map(b => SHORT[b] || b).join(', ') }}.
      Context-only: {{ nonCoreBenchmarks.map(b => SHORT[b] || b).join(', ') }}.
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
          Score is the raw average over the core benchmarks a model actually reports,
          CL-weighted: it is blended toward a neutral 50 baseline in proportion to the
          model's Coverage Level (CL). A fully-covered model (CL 100%) keeps its plain
          average; a model covering 2 of 8 core evals only keeps 25% of its edge above
          50. This offsets selection bias — without it, models evaluated on a few
          favorable leaderboards outrank frontier models tested across the board.
          Missing evals are treated as “no evidence” (neutral), never as a zero.
        </p>
      </div>
      <div class="panel-lab" style="padding:1.2rem">
        <h3 style="margin:0 0 .4rem">Core benchmarks in the average</h3>
        <div class="chips mt-sm">
          <span class="tag-lab teal" v-for="b in coreBenchmarks" :key="b">{{ SHORT[b] || b }}</span>
          <span class="tag-lab" v-for="b in nonCoreBenchmarks" :key="b">{{ SHORT[b] || b }}</span>
        </div>
        <p class="cell-sub mt-sm">Teal = counted in the global Score. Grey = reported for context only.</p>
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
