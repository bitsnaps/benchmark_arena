<script setup>
// The global pivot table — one row per model, one column per benchmark.
// Reused by every leaderboard tier tab (all / closed / open). Older models
// (superseded / stale) render INLINE when the Older-versions toggle is on:
// they interleave at their natural score position, dimmed (is-older-row),
// with no rank number and a small "older" chip on the name.
import { SHORT } from '../lib/constants.js';
import { fmtScore, fmtUsd, fmtValue, scoreColor, barWidth, clTag, covClass, rankClass, providerColor, initials, slugify } from '../lib/format.js';
import { useData } from '../stores/data.js';
import { useLeaderboard } from '../stores/leaderboard.js';

const props = defineProps({
  rows: { type: Array, required: true },
  tier: { type: String, default: 'all' },
});

const { stats, coreBenchmarks, scoreForModel, avgForModel, clForModel, coveredCountForModel, rankOf, tierOf, benchThAttrs, isOlder, supersededBy, metaFor, priceFor, valueFor } = useData();
const { compareMode, compareRows, isSameModel, canCheck } = useLeaderboard();

// Opacity bands from benchmark coverage + extra dimming for older versions.
// Coverage is recomputed against the current avg-set selection, so a custom
// mix re-scores row opacity too. Hover restores full opacity (see .cov-table).
const rowCls = (row) =>
  [covClass(clForModel(row)), isOlder(row) ? 'is-older-row' : ''].join(' ').trim();

// Tooltip for the inline "older" chip — why this row sits outside the ranking
const olderTitle = (row) =>
  supersededBy(row)
    ? `superseded by ${supersededBy(row)} — hidden by default, excluded from the ranking`
    : 'stale generation (9+ months old, no successor in the data) — hidden by default, excluded from the ranking';

// ★ footnote: source sites list this model under a different (e.g. HF repo) name
const aliasNote = (row) => metaFor(row)?.alias_note || null;

// Sorter for the global Score column (nulls always sink to the bottom)
function byScore(a, b, isAsc) {
  const av = scoreForModel(a);
  const bv = scoreForModel(b);
  if (av === null && bv === null) return 0;
  if (av === null) return 1;
  if (bv === null) return -1;
  return isAsc ? av - bv : bv - av;
}

// Sorter for the Price column — 3:1 in:out blend; no-catalog rows sink last
function byPrice(a, b, isAsc) {
  const av = priceFor(a)?.blend ?? null;
  const bv = priceFor(b)?.blend ?? null;
  if (av === null && bv === null) return 0;
  if (av === null) return 1;
  if (bv === null) return -1;
  return isAsc ? av - bv : bv - av;
}

// Sorter for the Value column — score per 1M blended tokens; rows without a
// value (no score or no price, free tiers) sink last in BOTH directions
function byValue(a, b, isAsc) {
  const av = valueFor(a);
  const bv = valueFor(b);
  if (av === null && bv === null) return 0;
  if (av === null) return 1;
  if (bv === null) return -1;
  return isAsc ? av - bv : bv - av;
}

// Tooltip for the Price cell: full in / out / cache breakdown
function priceTitle(row) {
  const p = priceFor(row);
  if (!p) return 'No API price in the OpenRouter catalog snapshot for this row';
  const cache = p.cache_read != null ? ` · cache read ${fmtUsd(p.cache_read)}` : '';
  return `API list price — input ${fmtUsd(p.input)} · output ${fmtUsd(p.output)}${cache} per 1M tokens (OpenRouter snapshot; sorted by a 3:1 in:out blend). Compare sellers on the Providers page.`;
}

// Tooltip for the Value cell: the exact division behind the number
function valueTitle(row) {
  const p = priceFor(row);
  if (!p || !p.blend || p.blend <= 0) return 'No API price for this row — value needs a blended cost (free tiers are excluded)';
  const s = scoreForModel(row);
  if (s === null || s === undefined) return 'No score in the selected avg set — value needs a Score';
  return `Value lens — Score ${s.toFixed(1)} ÷ blended ${fmtUsd(p.blend)}/1M tokens (3:1 in:out) = ${fmtValue(valueFor(row))} score points per 1M blended tokens. Higher = more benchmark score per dollar. Free tiers are excluded (infinite value is meaningless).`;
}

// Tooltip: raw sparse avg + coverage behind the CL-weighted score
function scoreTitle(row) {
  const raw = avgForModel(row);
  const w = scoreForModel(row);
  const cl = clForModel(row);
  if (raw === null || raw === undefined) return 'No scores in the selected avg set';
  return `Raw avg ${raw.toFixed(1)} · CL ${Math.round(cl)}% (${coveredCountForModel(row)} of ${coreBenchmarks.value.length} selected) → CL-weighted ${w !== null && w !== undefined ? w.toFixed(1) : '—'} (uncovered selected benches count as neutral 50)`;
}
</script>

<template>
  <div class="cov-table">
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
          >{{ props.row.name }}<span v-if="aliasNote(props.row)" class="alias-star" :title="aliasNote(props.row)">★</span></router-link>
          <div class="cell-sub">
            {{ providerColor(props.row.name).name }}
            <span v-if="tier === 'all'" class="tier-chip" :class="tierOf(props.row)">{{ tierOf(props.row) === 'closed' ? 'closed' : 'open' }}</span>
            <span v-if="isOlder(props.row)" class="older-chip" :title="olderTitle(props.row)">older</span>
          </div>
        </div>
      </div>
    </b-table-column>

    <b-table-column field="avg" label="Score" width="120" centered numeric sortable :custom-sort="byScore" :th-attrs="() => ({ title: 'CL-weighted global score — raw sparse avg blended toward a neutral 50 in proportion to benchmark coverage (CL). Full coverage = raw avg.' })" v-slot="props">
      <div class="num" :style="{ color: scoreColor(scoreForModel(props.row)), fontWeight: 600 }" :title="scoreTitle(props.row)">
        {{ fmtScore(scoreForModel(props.row)) }}
      </div>
      <div class="bar" style="margin-top:.3rem"><i :style="{ width: barWidth(scoreForModel(props.row)) }"></i></div>
    </b-table-column>

    <!-- Price: per-model API metadata (not a benchmark), always visible.
         OpenRouter list price from models_meta.pricing_usd_per_1m; models
         without a catalog match show an honest dash. -->
    <b-table-column field="price" label="Price" width="115" centered sortable :custom-sort="byPrice"
      :th-attrs="() => ({ title: 'API list price, USD per 1M tokens — input / output (OpenRouter snapshot). Sorted by a 3:1 in:out blend. — = no catalog match.' })"
      v-slot="props"
    >
      <span v-if="priceFor(props.row)" class="price-cell" :title="priceTitle(props.row)">{{ fmtUsd(priceFor(props.row).input) }}<span class="price-sep">/</span>{{ fmtUsd(priceFor(props.row).output) }}</span>
      <span v-else class="cell-sub" :title="priceTitle(props.row)">—</span>
    </b-table-column>

    <!-- Value lens: Score per 1M blended tokens (Score ÷ 3:1-blended $/1M).
         Higher = more benchmark score per dollar. Always-visible identity
         metadata, like Price — not a benchmark, never feeds the Score.
         Rows with no score / no price (and free tiers) show an honest dash. -->
    <b-table-column field="value" label="Value" width="90" centered numeric sortable :custom-sort="byValue"
      :th-attrs="() => ({ title: 'Value lens — Score per 1M blended tokens (Score ÷ blended $/1M, 3:1 in:out). Higher = more benchmark score per dollar. — = no Score or no API price; free tiers excluded.' })"
      v-slot="props"
    >
      <span v-if="valueFor(props.row) !== null" class="num value-cell" style="font-weight:600" :title="valueTitle(props.row)">{{ fmtValue(valueFor(props.row)) }}</span>
      <span v-else class="cell-sub value-cell" :title="valueTitle(props.row)">—</span>
    </b-table-column>

    <!-- Hide/Show columns: benchmark columns follow the Avg-set selection 1:1.
         Identity columns (# / Model / Score / CL) are always visible. Hidden
         benchmarks stay fully available on the Benchmarks page, model cards
         and the compare panel — hiding is purely display, nothing is deleted. -->
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
      :th-attrs="benchThAttrs"
      v-slot="props"
    >
      <span :style="{ color: scoreColor(props.row[b]), fontWeight: 500 }">{{ fmtScore(props.row[b]) }}</span>
    </b-table-column>

    <b-table-column field="cl" label="CL" width="80" centered sortable v-slot="props">
      <b-tag
        v-if="props.row.cl !== null && props.row.cl !== undefined"
        size="is-small"
        :type="clTag(clForModel(props.row))"
      >{{ Math.round(clForModel(props.row)) }}%</b-tag>
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
