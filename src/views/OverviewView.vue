<script setup>
// Overview — landing page: hero, snapshot stats, shortcuts, leader cards.
import { useRouter } from 'vue-router';
import { SHORT } from '../lib/constants.js';
import { fmtScore, providerColor, initials } from '../lib/format.js';
import { useData } from '../stores/data.js';
import { useLeaderboard } from '../stores/leaderboard.js';

const router = useRouter();
const { stats, topOverall, topOpen, avgForModel, leaders, coreBenchmarks, nonCoreBenchmarks } = useData();
const { compareMode } = useLeaderboard();

const goLeaderboard = () => router.push({ name: 'leaderboard', params: { tier: 'all' } });
const goBenchmarks = () => router.push({ name: 'benchmarks' });

const goCompare = () => {
  compareMode.value = true;
  router.push({ name: 'leaderboard', params: { tier: 'all' } });
};

// Jump to the leaderboard pre-filtered on a model
const searchForModel = (name) =>
  router.push({ name: 'leaderboard', params: { tier: 'all' }, query: { q: name } });
</script>

<template>
  <section>
    <section class="hero-lab">
      <div class="mesh"></div>
      <div class="kicker">Benchmark cockpit · snapshot {{ stats.lastUpdated }}</div>
      <h1 class="display">Stop tab-hopping<br>between leaderboards.</h1>
      <p class="lede">
        Benchmark Arena merges {{ stats.totalBenchmarks }} public LLM evals into one sortable
        cockpit — global averages, per-benchmark ranks and side-by-side comparisons,
        refreshed regularly from live sources.
      </p>
      <div class="row mt">
        <b-button type="is-primary" icon-left="ranking-star" @click="goLeaderboard">
          Open the leaderboard
        </b-button>
        <b-button icon-left="chart-simple" @click="goBenchmarks">
          Browse benchmarks
        </b-button>
        <b-button class="btn-ghost" icon-left="code-compare" @click="goCompare">
          Start comparing
        </b-button>
      </div>
    </section>

    <div class="grid-4 mt">
      <div class="stat">
        <div class="lbl">Models tracked</div>
        <div class="val num">{{ stats.closed + stats.open }}</div>
        <div class="sub">{{ stats.closed }} closed · {{ stats.open }} open weights</div>
      </div>
      <div class="stat">
        <div class="lbl">Public leaderboards</div>
        <div class="val num">{{ stats.totalBenchmarks }}</div>
        <div class="sub">{{ stats.coreBenchmarks }} of them counted in Avg</div>
      </div>
      <div class="stat">
        <div class="lbl">Top overall</div>
        <div class="val" style="font-size:1.15rem">{{ topOverall ? topOverall.name : '—' }}</div>
        <div class="sub">Avg {{ topOverall ? fmtScore(avgForModel(topOverall)) : '—' }} across core evals</div>
      </div>
      <div class="stat">
        <div class="lbl">Top open-weight</div>
        <div class="val" style="font-size:1.15rem">{{ topOpen ? topOpen.name : '—' }}</div>
        <div class="sub">Avg {{ topOpen ? fmtScore(avgForModel(topOpen)) : '—' }} across core evals</div>
      </div>
    </div>

    <div class="mt">
      <h2 class="section-title">Start from the decision, not the model</h2>
      <p class="section-sub">Three shortcuts people actually need. Everything else lives in the leaderboard.</p>
      <div class="grid-3">
        <div class="model-tile" @click="goLeaderboard">
          <div class="tag-lab teal">Overall</div>
          <h3 style="margin:.6rem 0 .3rem">Global pivot</h3>
          <p style="color:var(--muted);font-size:.9rem">
            One sortable table with every model in a single ranking — closed and open weights
            side by side, with coverage flags and a composite average.
          </p>
        </div>
        <div class="model-tile" @click="goBenchmarks">
          <div class="tag-lab indigo">Evals</div>
          <h3 style="margin:.6rem 0 .3rem">Per-benchmark ranks</h3>
          <p style="color:var(--muted);font-size:.9rem">
            Pick an eval and read the bar-by-bar ranking. SWE-Marathon if you ship code,
            ARC-AGI-2 if you reason, Arena if you chat.
          </p>
        </div>
        <div class="model-tile" @click="goCompare">
          <div class="tag-lab gold">Side-by-side</div>
          <h3 style="margin:.6rem 0 .3rem">Compare models</h3>
          <p style="color:var(--muted);font-size:.9rem">
            Pick up to five models and line their scores up row by row —
            per-eval winners light up teal.
          </p>
        </div>
      </div>
    </div>

    <div class="mt">
      <h2 class="section-title">Category leaders</h2>
      <p class="section-sub">Computed live from this snapshot. Click a card to filter the leaderboard.</p>
      <div class="grid-4">
        <div class="model-tile" v-for="card in leaders" :key="card.bench" @click="searchForModel(card.model)">
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

    <div class="grid-2 mt">
      <div class="panel-lab" style="padding:1.2rem">
        <h3 style="margin:0 0 .4rem">How the Avg column works</h3>
        <p style="color:var(--muted);font-size:.92rem">
          Avg is a plain mean over the core benchmarks a model actually reports, normalized to 0–100.
          Models are never punished for missing evals — the CL tag shows how much of the core set each
          model covers, so weigh coverage against the score when two averages look close.
        </p>
      </div>
      <div class="panel-lab" style="padding:1.2rem">
        <h3 style="margin:0 0 .4rem">Core benchmarks in the average</h3>
        <div class="chips mt-sm">
          <span class="tag-lab teal" v-for="b in coreBenchmarks" :key="b">{{ SHORT[b] || b }}</span>
          <span class="tag-lab" v-for="b in nonCoreBenchmarks" :key="b">{{ SHORT[b] || b }}</span>
        </div>
        <p class="cell-sub mt-sm">Teal = counted in Avg. Grey = reported for context only.</p>
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
