<script setup>
// Model detail — full score card for one model: ranks, Avg, coverage,
// per-benchmark bars with rank-in-benchmark, and a compare shortcut.
import { computed, watchEffect } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { SHORT, BASE_TITLE } from '../lib/constants.js';
import { fmtScore, scoreColor, barWidth, rankClass, providerColor, initials, slugify } from '../lib/format.js';
import { useData } from '../stores/data.js';
import { useLeaderboard } from '../stores/leaderboard.js';

const route = useRoute();
const router = useRouter();

const { benchmarks, benchRankIndex, modelSlugIndex, avgForModel, rankMaps, rankOf, tierOf, isCore, stats } = useData();
const { compareMode, compareRows } = useLeaderboard();

const model = computed(() => modelSlugIndex.value.get(route.params.slug) || null);

watchEffect(() => {
  document.title = model.value ? `${model.value.name} · Benchmark Arena` : BASE_TITLE;
});

const provider = computed(() => model.value ? providerColor(model.value.name) : null);
const tier = computed(() => model.value ? tierOf(model.value) : null);
const avg = computed(() => model.value ? avgForModel(model.value) : null);

// Scored / missing benchmarks
const scored = computed(() => !model.value ? [] : benchmarks.value
  .map(b => {
    const info = benchRankIndex.value[b] || { ranks: new Map(), count: 0, best: null };
    return { bench: b, score: model.value[b] ?? null, rank: info.ranks.get(model.value.name), count: info.count, best: info.best };
  })
  .filter(s => s.score !== null && s.score !== undefined));
const missing = computed(() => !model.value ? [] : benchmarks.value
  .filter(b => model.value[b] === null || model.value[b] === undefined));

const covered = computed(() => scored.value.length);
const wins = computed(() => scored.value.filter(s => s.rank === 1).length);
const best = computed(() => scored.value.slice().sort((a, b) => b.score - a.score)[0] || null);

const overallRank = computed(() => (model.value ? rankMaps.value.all.get(model.value.name) : null));
const tierRank = computed(() => (model.value && tier.value ? rankMaps.value[tier.value].get(model.value.name) : null));

// Compare shortcut
const inCompare = computed(() => !!model.value && compareRows.value.some(r => r.name === model.value.name));
const compareFull = computed(() => compareRows.value.length >= 5 && !inCompare.value);

function addToCompare() {
  if (!model.value || inCompare.value || compareFull.value) return;
  compareRows.value.push(model.value);
  compareMode.value = true;
  router.push({ name: 'compare' });
}
</script>

<template>
  <section v-if="model">
    <div class="crumbs">
      <router-link class="crumb" :to="{ name: 'home' }"><i class="fas fa-arrow-left"></i> Leaderboard</router-link>
      <span class="crumb-sep">/</span>
      <span class="crumb current">{{ model.name }}</span>
    </div>

    <!-- Header card -->
    <div class="panel-lab model-head">
      <span class="av lg" :style="{ background: provider.color }">{{ initials(model.name) }}</span>
      <div class="grow">
        <h1 class="section-title" style="margin:0">{{ model.name }}</h1>
        <div class="row mt-sm" style="gap:.4rem">
          <span class="tag-lab">{{ provider.name }}</span>
          <span class="tag-lab" :class="tier === 'closed' ? 'rose' : 'teal'">{{ tier === 'closed' ? 'Closed-source' : 'Open-weight' }}</span>
          <span v-if="overallRank" class="tag-lab gold">#{{ overallRank }} overall</span>
          <span v-if="tierRank" class="tag-lab">#{{ tierRank }} in {{ tier === 'closed' ? 'closed' : 'open' }}</span>
        </div>
      </div>
      <div class="row" style="gap:.6rem">
        <b-button type="is-primary" size="is-small" icon-left="code-compare"
          :disabled="compareFull" @click="addToCompare">
          {{ inCompare ? 'In compare (' + compareRows.length + '/5)' : 'Add to compare' }}
        </b-button>
      </div>
    </div>

    <!-- Stat tiles -->
    <div class="grid-4 mt">
      <div class="stat">
        <div class="lbl">Composite Avg</div>
        <div class="val num" :style="{ color: scoreColor(avg) }">{{ fmtScore(avg) }}</div>
        <div class="bar mt-sm"><i :style="{ width: barWidth(avg) }"></i></div>
      </div>
      <div class="stat">
        <div class="lbl">Coverage Level</div>
        <div class="val num">{{ model.cl === null || model.cl === undefined ? '—' : Math.round(model.cl) + '%' }}</div>
        <div class="sub">of the {{ stats.coreBenchmarks }} core benchmarks</div>
      </div>
      <div class="stat">
        <div class="lbl">Benchmarks scored</div>
        <div class="val num">{{ covered }}<span class="sub" style="font-size:1rem"> / {{ benchmarks.length }}</span></div>
        <div class="sub">missing evals never punished</div>
      </div>
      <div class="stat">
        <div class="lbl">Benchmark wins</div>
        <div class="val num" :style="{ color: wins ? 'var(--gold)' : 'var(--faint)' }">{{ wins }}</div>
        <div class="sub">{{ best ? 'best: ' + fmtScore(best.score) + ' on ' + (SHORT[best.bench] || best.bench) : '—' }}</div>
      </div>
    </div>

    <!-- Per-benchmark bars -->
    <div class="panel-lab mt" style="padding:1.2rem">
      <div class="row" style="justify-content:space-between;margin-bottom:.6rem">
        <h3 style="margin:0;font-size:1.05rem">Scores across leaderboards</h3>
        <span class="cell-sub">rank badge = position among all {{ stats.closed + stats.open }} tracked models</span>
      </div>

      <router-link
        v-for="s in scored"
        :key="s.bench"
        class="hbar row-click"
        :to="{ name: 'benchmarks', params: { slug: slugify(s.bench) } }"
        :title="'Open the ' + s.bench + ' explorer'"
      >
        <div class="name">
          <span class="rank" :class="rankClass(s.rank)" v-if="s.rank" style="display:inline-grid;margin-right:.45rem">{{ s.rank }}</span>
          <span v-else class="rank" style="display:inline-grid;margin-right:.45rem">—</span>
          {{ SHORT[s.bench] || s.bench }}
          <span v-if="s.rank === 1" class="crown"><i class="fas fa-crown"></i> leads</span>
        </div>
        <div class="track"><i :style="{ width: barWidth(s.score), background: 'linear-gradient(90deg,#4f6dff,#2ee6c7)' }"></i></div>
        <div class="num" :style="{ color: scoreColor(s.score), fontWeight: s.rank === 1 ? 700 : 500 }">{{ fmtScore(s.score) }}</div>
      </router-link>

      <div v-for="b in missing" :key="b" class="hbar missing">
        <div class="name">
          <span class="rank" style="display:inline-grid;margin-right:.45rem">—</span>
          {{ SHORT[b] || b }}
        </div>
        <div class="track"></div>
        <div class="num cell-sub">—</div>
      </div>

      <p class="cell-sub mt-sm" v-if="missing.length">
        Not reported on: {{ missing.map(b => SHORT[b] || b).join(', ') }}.
      </p>
    </div>
  </section>

  <!-- Unknown slug -->
  <b-message v-else type="is-warning" has-icon icon="circle-question" title="Model not found">
    No model matches this link.
    <router-link :to="{ name: 'home' }">Back to the leaderboard</router-link>.
  </b-message>
</template>
