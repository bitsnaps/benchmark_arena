<script setup>
// The global pivot table — one row per model, one column per benchmark.
// Reused by every leaderboard tier tab (all / closed / open) and by the
// "Older versions" section (variant="older": rank badge suppressed, rows
// carry an extra dimming class).
import { SHORT } from '../lib/constants.js';
import { fmtScore, scoreColor, barWidth, clTag, covClass, rankClass, providerColor, initials, slugify } from '../lib/format.js';
import { useData } from '../stores/data.js';
import { useLeaderboard } from '../stores/leaderboard.js';

const props = defineProps({
  rows: { type: Array, required: true },
  tier: { type: String, default: 'all' },
  variant: { type: String, default: 'main' }, // 'main' | 'older'
});

const { benchmarks, nonCoreBenchmarks, stats, avgForModel, rankOf, tierOf, isCore, benchThAttrs } = useData();
const { compareMode, compareRows, isSameModel, canCheck } = useLeaderboard();

// Opacity bands from benchmark coverage + extra dimming for older versions.
// Hover restores full opacity (see .cov-table rules in main.css).
const rowCls = (row) =>
  [covClass(row.cl), props.variant === 'older' ? 'is-older-row' : ''].join(' ').trim();

// Sorter for the computed Avg column (nulls always sink to the bottom)
function byAvg(a, b, isAsc) {
  const av = avgForModel(a);
  const bv = avgForModel(b);
  if (av === null && bv === null) return 0;
  if (av === null) return 1;
  if (bv === null) return -1;
  return isAsc ? av - bv : bv - av;
}
</script>

<template>
  <div class="cov-table" :class="{ 'is-older-table': variant === 'older' }">
  <b-table
    :data="rows"
    narrowed
    hoverable
    scrollable
    :mobile-cards="false"
    :row-class="rowCls"
    :checkable="compareMode"
    v-model:checked-rows="compareRows"
    :header-checkable="false"
    :is-row-checkable="canCheck"
    :custom-is-checked="isSameModel"
    checkbox-position="left"
    :default-sort="['avg', 'desc']"
  >
    <b-table-column field="rank" label="#" width="56" centered v-slot="props">
      <div class="rank" :class="rankClass(rankOf(tier, props.row))">{{ rankOf(tier, props.row) ?? '—' }}</div>
    </b-table-column>

    <b-table-column field="name" label="Model" sticky width="240" sortable v-slot="props">
      <div class="model-cell">
        <span class="av" :style="{ background: providerColor(props.row.name).color }">
          {{ initials(props.row.name) }}
        </span>
        <div>
          <router-link
            class="model-link has-text-weight-semibold"
            :to="{ name: 'model', params: { slug: slugify(props.row.name) } }"
            :title="'Open ' + props.row.name + '\'s score card'"
          >{{ props.row.name }}</router-link>
          <div class="cell-sub">
            {{ providerColor(props.row.name).name }}
            <span v-if="tier === 'all'" class="tier-chip" :class="tierOf(props.row)">{{ tierOf(props.row) === 'closed' ? 'closed' : 'open' }}</span>
          </div>
        </div>
      </div>
    </b-table-column>

    <b-table-column field="avg" label="Avg" width="120" centered numeric sortable :custom-sort="byAvg" v-slot="props">
      <div class="num" :style="{ color: scoreColor(avgForModel(props.row)), fontWeight: 600 }">
        {{ fmtScore(avgForModel(props.row)) }}
      </div>
      <div class="bar" style="margin-top:.3rem"><i :style="{ width: barWidth(avgForModel(props.row)) }"></i></div>
    </b-table-column>

    <b-table-column
      v-for="b in benchmarks"
      :key="b"
      :field="b"
      :label="SHORT[b] || b"
      width="85"
      centered
      numeric
      sortable
      :header-class="isCore(b) ? 'core-col' : 'noncore-col'"
      :cell-class="isCore(b) ? '' : 'noncore-cell'"
      :th-attrs="benchThAttrs"
      v-slot="props"
    >
      <span :style="{ color: scoreColor(props.row[b]), fontWeight: 500 }">{{ fmtScore(props.row[b]) }}</span>
    </b-table-column>

    <b-table-column field="cl" label="CL" width="80" centered sortable v-slot="props">
      <b-tag
        v-if="props.row.cl !== null && props.row.cl !== undefined"
        size="is-small"
        :type="clTag(props.row.cl)"
      >{{ Math.round(props.row.cl) }}%</b-tag>
      <span v-else class="cell-sub">—</span>
    </b-table-column>

    <template #empty>
      <div class="has-text-centered has-text-grey py-5">
        <b-icon icon="magnifying-glass" size="is-medium" />
        <p class="mt-2">No models match your filter.</p>
      </div>
    </template>
  </b-table>
  </div>
</template>
