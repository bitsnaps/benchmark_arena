<script setup>
// Side-by-side comparison of the checked models (up to 5) + CTA to the
// full comparison page (specs, pricing, modalities) at #/compare.
// stats-55: benchmark columns follow the Avg-set selection 1:1 — the same
// columns as the leaderboard above (a deselected benchmark is one click
// away on the full comparison page, which still shows every leaderboard).
// Every column is sortable; the sorters sink missing cells to the bottom
// in BOTH directions (Buefy's default would float them to the top on desc).
import { useRouter } from 'vue-router';
import { SHORT } from '../lib/constants.js';
import { sinkLast } from '../lib/compareSort.js';
import { fmtScore, scoreColor, providerColor, initials, slugify } from '../lib/format.js';
import { useData } from '../stores/data.js';
import { useLeaderboard } from '../stores/leaderboard.js';

const router = useRouter();
const { benchmarks, coreBenchmarks, scoreForModel } = useData();
const { compareRows, clearCompare, isBest } = useLeaderboard();

// Score sorts by the live CL-weighted Score (follows the Avg set exactly
// like the leaderboard column); benchmark columns sort by the raw cell.
const byScore = sinkLast((r) => scoreForModel(r));
const byBench = (b) => sinkLast((r) => r[b] ?? null);
</script>

<template>
  <div v-if="compareRows.length" class="panel-lab mt cmp-panel" style="padding:1.1rem">
    <div class="row" style="justify-content:space-between;margin-bottom:.6rem">
      <h3 class="section-title" style="margin:0;font-size:1.15rem">
        Side by side · {{ compareRows.length }}/5
      </h3>
      <div class="row" style="gap:.5rem">
        <b-button size="is-small" type="is-primary" icon-left="table-columns" @click="router.push({ name: 'compare' })">
          Full comparison
        </b-button>
        <b-button size="is-small" icon-left="xmark" @click="clearCompare">Clear</b-button>
      </div>
    </div>
    <b-table :data="compareRows" narrowed hoverable scrollable :mobile-cards="false">
      <b-table-column field="name" label="Model" width="220" sticky sortable v-slot="props">
        <div class="model-cell">
          <span class="av" :style="{ background: providerColor(props.row.name).color }">
            {{ initials(props.row.name) }}
          </span>
          <router-link
            class="model-link has-text-weight-semibold"
            :to="{ name: 'model', params: { slug: slugify(props.row.name) } }"
          >{{ props.row.name }}</router-link>
        </div>
      </b-table-column>
      <b-table-column field="avg" label="Score" width="90" centered numeric sortable :custom-sort="byScore" v-slot="props">
        <span class="num" :style="{ color: scoreColor(scoreForModel(props.row)), fontWeight: 600 }">
          {{ fmtScore(scoreForModel(props.row)) }}
        </span>
      </b-table-column>
      <b-table-column
        v-for="b in coreBenchmarks"
        :key="b"
        :field="b"
        :label="SHORT[b] || b"
        width="85"
        centered
        numeric
        sortable
        header-class="core-col"
        :custom-sort="byBench(b)"
        v-slot="props"
      >
        <span :class="isBest(b, props.row) ? 'winner' : ''" :style="{ fontWeight: isBest(b, props.row) ? 700 : 500 }">
          {{ fmtScore(props.row[b]) }}
        </span>
      </b-table-column>
    </b-table>
    <p class="cell-sub mt-sm">
      Teal = best in the row across the selected models.
      Columns follow the Avg set — {{ coreBenchmarks.length }} of {{ benchmarks.length }} leaderboards shown; hidden ones stay on the full comparison page.
    </p>
  </div>
</template>
