<script setup>
// Side-by-side comparison of the checked models (up to 5).
import { SHORT } from '../lib/constants.js';
import { fmtScore, scoreColor, providerColor, initials } from '../lib/format.js';
import { useData } from '../stores/data.js';
import { useLeaderboard } from '../stores/leaderboard.js';

const { benchmarks, avgForModel, isCore } = useData();
const { compareRows, clearCompare, isBest } = useLeaderboard();
</script>

<template>
  <div v-if="compareRows.length" class="panel-lab mt" style="padding:1.1rem">
    <div class="row" style="justify-content:space-between;margin-bottom:.6rem">
      <h3 class="section-title" style="margin:0;font-size:1.15rem">
        Side by side · {{ compareRows.length }}/5
      </h3>
      <b-button size="is-small" icon-left="xmark" @click="clearCompare">Clear</b-button>
    </div>
    <b-table :data="compareRows" narrowed hoverable scrollable :mobile-cards="false">
      <b-table-column field="name" label="Model" width="220" sticky v-slot="props">
        <div class="model-cell">
          <span class="av" :style="{ background: providerColor(props.row.name).color }">
            {{ initials(props.row.name) }}
          </span>
          <span class="has-text-weight-semibold">{{ props.row.name }}</span>
        </div>
      </b-table-column>
      <b-table-column field="avg" label="Avg" width="90" centered numeric v-slot="props">
        <span class="num" :style="{ color: scoreColor(avgForModel(props.row)), fontWeight: 600 }">
          {{ fmtScore(avgForModel(props.row)) }}
        </span>
      </b-table-column>
      <b-table-column
        v-for="b in benchmarks"
        :key="b"
        :field="b"
        :label="SHORT[b] || b"
        width="85"
        centered
        numeric
        :header-class="isCore(b) ? 'core-col' : 'noncore-col'"
        :cell-class="isCore(b) ? '' : 'noncore-cell'"
        v-slot="props"
      >
        <span :class="isBest(b, props.row) ? 'winner' : ''" :style="{ fontWeight: isBest(b, props.row) ? 700 : 500 }">
          {{ fmtScore(props.row[b]) }}
        </span>
      </b-table-column>
    </b-table>
    <p class="cell-sub mt-sm">Teal = best in the row across the selected models.</p>
  </div>
</template>
