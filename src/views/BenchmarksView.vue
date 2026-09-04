<script setup>
// Benchmarks — per-eval explorer: blurb, top-3 glance and bar ranking.
// The selected benchmark is deep-linkable: /benchmarks/:slug
import { ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { SHORT, BLURBS } from '../lib/constants.js';
import { fmtScore, rankClass, trackColor, slugify } from '../lib/format.js';
import { useData } from '../stores/data.js';
import { useLeaderboard } from '../stores/leaderboard.js';

const route = useRoute();
const router = useRouter();
const { benchmarks, perBenchData, benchSlugIndex, modelSlugIndex, isCore, isOlder } = useData();
const { showOlder } = useLeaderboard();

const benchFilter = ref('all');       // all | closed | open

// Active benchmark comes from the URL slug (falls back to the first one)
const activeBench = computed(() => {
  const slug = typeof route.params.slug === 'string' ? route.params.slug : '';
  return (slug && benchSlugIndex.value.get(slug)) || benchmarks.value[0] || '';
});

const pick = (b) => router.push({ name: 'benchmarks', params: { slug: slugify(b) } });

const benchInfo = computed(() => {
  const d = perBenchData.value[activeBench.value] || { closed: [], open: [] };
  return { closed: d.closed.length, open: d.open.length };
});

// Same freshness rule as the home leaderboard: older releases (superseded
// versions + stale generations) are hidden by default behind the shared
// "Older versions" toggle; when shown they rank after current models with
// no rank number and a dimmed bar. Top-3 glance always uses current models.
const rankingRows = computed(() => {
  const d = perBenchData.value[activeBench.value] || { closed: [], open: [] };
  let rows = [];
  if (benchFilter.value !== 'open') rows = rows.concat(d.closed.map(([model, score]) => ({ name: model, score, tier: 'closed' })));
  if (benchFilter.value !== 'closed') rows = rows.concat(d.open.map(([model, score]) => ({ name: model, score, tier: 'open' })));
  rows = rows.filter(r => r.score !== null && r.score !== undefined).sort((a, b) => b.score - a.score);
  const max = rows.length ? rows[0].score : 1;
  rows.forEach(r => { r.pct = (r.score / max) * 100; r.older = isOlder(r); });
  const current = rows.filter(r => !r.older);
  const older = rows.filter(r => r.older);
  current.forEach((r, i) => { r.rank = i + 1; });
  older.forEach(r => { r.rank = null; });
  return showOlder.value ? current.concat(older) : current;
});

const currentTop3 = computed(() =>
  rankingRows.value.filter(r => !r.older).slice(0, 3));

const olderCountHere = computed(() => {
  const d = perBenchData.value[activeBench.value] || { closed: [], open: [] };
  return d.closed.concat(d.open).filter(([model]) => isOlder({ name: model })).length;
});

// Open the model's score card; models that never made it into the
// unified pivot fall back to a pre-filtered leaderboard search.
const openModel = (name) => {
  const slug = slugify(name);
  if (modelSlugIndex.value.has(slug)) {
    router.push({ name: 'model', params: { slug } });
  } else {
    router.push({ name: 'home', query: { q: name } });
  }
};
</script>

<template>
  <section>
    <div class="crumbs">
      <router-link class="crumb" :to="{ name: 'home' }"><i class="fas fa-arrow-left"></i> Leaderboard</router-link>
    </div>

    <div class="page-head">
      <div class="kicker">Performance by eval</div>
      <h1 class="section-title">Benchmarks</h1>
      <p class="section-sub">One leaderboard lies. Eleven argue. Use the eval that matches the work.</p>
    </div>

    <div class="chips" style="margin-bottom:1rem">
      <span class="chip" v-for="b in benchmarks" :key="b" :class="{ on: activeBench === b }" @click="pick(b)">
        {{ SHORT[b] || b }}
      </span>
    </div>

    <div class="grid-2">
      <div class="panel-lab" style="padding:1.2rem">
        <div class="row" style="justify-content:space-between">
          <h2 style="margin:0;font-size:1.2rem">{{ activeBench }}</h2>
          <span class="tag-lab" :class="isCore(activeBench) ? 'teal' : ''">
            {{ isCore(activeBench) ? 'Core — in Avg' : 'Context only' }}
          </span>
        </div>
        <p style="color:var(--muted)" class="mt-sm">{{ BLURBS[activeBench] }}</p>
        <p class="cell-sub mt-sm">
          Higher is better · {{ benchInfo.closed }} closed / {{ benchInfo.open }} open models scored
        </p>
      </div>
      <div class="panel-lab" style="padding:1.2rem">
        <div class="lbl">Top 3 at a glance</div>
        <div class="kv row-click" v-for="(r, i) in currentTop3" :key="r.tier + r.name"
          :title="'Open ' + r.name + '\'s score card'" @click="openModel(r.name)">
          <span class="k">
            <span class="rank" :class="rankClass(i + 1)" style="display:inline-grid;margin-right:.45rem">{{ i + 1 }}</span>
            {{ r.name }}
          </span>
          <span class="num">{{ fmtScore(r.score) }}</span>
        </div>
      </div>
    </div>

    <div class="panel-lab mt" style="padding:1.2rem">
      <div class="row" style="justify-content:space-between;margin-bottom:.6rem;gap:1rem;flex-wrap:wrap">
        <h3 style="margin:0;font-size:1.05rem">Ranking</h3>
        <div class="row" style="gap:1rem;align-items:center;flex-wrap:wrap">
          <div class="chips">
            <span class="chip" :class="{ on: benchFilter === 'all' }" @click="benchFilter = 'all'">All</span>
            <span class="chip" :class="{ on: benchFilter === 'closed' }" @click="benchFilter = 'closed'">Closed</span>
            <span class="chip" :class="{ on: benchFilter === 'open' }" @click="benchFilter = 'open'">Open</span>
          </div>
          <b-switch v-model="showOlder" size="is-small" type="is-warning" left-label>
            Older versions
            <b-tag v-if="olderCountHere" size="is-small" type="is-warning is-light" rounded>{{ olderCountHere }}</b-tag>
          </b-switch>
        </div>
      </div>
      <div style="max-height:520px;overflow:auto">
        <div v-for="(r, i) in rankingRows" :key="r.tier + r.name" class="hbar row-click"
          :class="{ 'is-older-row': r.older }"
          :title="'Open ' + r.name + '\'s score card'" @click="openModel(r.name)">
          <div class="name">
            <span class="rank" :class="rankClass(r.rank)" style="display:inline-grid;margin-right:.45rem">{{ r.rank ?? '—' }}</span>
            {{ r.name }}
          </div>
          <div class="track"><i :style="{ width: r.pct + '%', background: trackColor(r.older ? 1 : i) }"></i></div>
          <div class="num" :style="{ color: !r.older && i === 0 ? 'var(--teal)' : 'inherit' }">{{ fmtScore(r.score) }}</div>
        </div>
      </div>
    </div>
  </section>
</template>
