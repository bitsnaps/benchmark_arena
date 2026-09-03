<script setup>
// Benchmarks — per-eval explorer: blurb, top-3 glance and bar ranking.
import { ref, computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import { SHORT, BLURBS } from '../lib/constants.js';
import { fmtScore, rankClass, trackColor } from '../lib/format.js';
import { useData } from '../stores/data.js';

const router = useRouter();
const { benchmarks, perBenchData, isCore } = useData();

const activeBench = ref('');
const benchFilter = ref('all');       // all | closed | open

// Data is guaranteed loaded before views mount (App guards on loading),
// but keep a watcher for safety on direct navigation.
watch(benchmarks, (b) => {
  if (!activeBench.value && b.length) activeBench.value = b[0];
}, { immediate: true });

const benchInfo = computed(() => {
  const d = perBenchData.value[activeBench.value] || { closed: [], open: [] };
  return { closed: d.closed.length, open: d.open.length };
});

const rankingRows = computed(() => {
  const d = perBenchData.value[activeBench.value] || { closed: [], open: [] };
  let rows = [];
  if (benchFilter.value !== 'open') rows = rows.concat(d.closed.map(([model, score]) => ({ name: model, score, tier: 'closed' })));
  if (benchFilter.value !== 'closed') rows = rows.concat(d.open.map(([model, score]) => ({ name: model, score, tier: 'open' })));
  rows = rows.filter(r => r.score !== null && r.score !== undefined).sort((a, b) => b.score - a.score);
  const max = rows.length ? rows[0].score : 1;
  rows.forEach(r => { r.pct = (r.score / max) * 100; });
  return rows;
});

// Open the model in the leaderboard (All tab so either tier matches)
const searchForModel = (name) =>
  router.push({ name: 'leaderboard', params: { tier: 'all' }, query: { q: name } });
</script>

<template>
  <section>
    <div class="page-head">
      <div class="kicker">Performance by eval</div>
      <h1 class="section-title">Benchmarks</h1>
      <p class="section-sub">One leaderboard lies. Eleven argue. Use the eval that matches the work.</p>
    </div>

    <div class="chips" style="margin-bottom:1rem">
      <span class="chip" v-for="b in benchmarks" :key="b" :class="{ on: activeBench === b }" @click="activeBench = b">
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
        <div class="kv" v-for="(r, i) in rankingRows.slice(0, 3)" :key="r.tier + r.name">
          <span class="k">
            <span class="rank" :class="rankClass(i)" style="display:inline-grid;margin-right:.45rem">{{ i + 1 }}</span>
            {{ r.name }}
          </span>
          <span class="num">{{ fmtScore(r.score) }}</span>
        </div>
      </div>
    </div>

    <div class="panel-lab mt" style="padding:1.2rem">
      <div class="row" style="justify-content:space-between;margin-bottom:.6rem">
        <h3 style="margin:0;font-size:1.05rem">Ranking</h3>
        <div class="chips">
          <span class="chip" :class="{ on: benchFilter === 'all' }" @click="benchFilter = 'all'">All</span>
          <span class="chip" :class="{ on: benchFilter === 'closed' }" @click="benchFilter = 'closed'">Closed</span>
          <span class="chip" :class="{ on: benchFilter === 'open' }" @click="benchFilter = 'open'">Open</span>
        </div>
      </div>
      <div style="max-height:520px;overflow:auto">
        <div v-for="(r, i) in rankingRows" :key="r.tier + r.name" class="hbar row-click"
          :title="'Open ' + r.name + ' in the leaderboard'" @click="searchForModel(r.name)">
          <div class="name">
            <span class="rank" :class="rankClass(i)" style="display:inline-grid;margin-right:.45rem">{{ i + 1 }}</span>
            {{ r.name }}
          </div>
          <div class="track"><i :style="{ width: r.pct + '%', background: trackColor(i) }"></i></div>
          <div class="num" :style="{ color: i === 0 ? 'var(--teal)' : 'inherit' }">{{ fmtScore(r.score) }}</div>
        </div>
      </div>
    </div>
  </section>
</template>
