<script setup>
// The global pivot table — one row per model, one column per benchmark.
// Reused by every leaderboard tier tab (all / closed / open). Older models
// (superseded / stale) render INLINE when the Older-versions toggle is on:
// they interleave at their natural score position, dimmed (is-older-row),
// with no rank number and a small "older" chip on the name.
import { SHORT } from '../lib/constants.js';
import { fmtScore, fmtUsd, fmtValue, scoreColor, barWidth, clTag, covClass, rankClass, providerColor, initials, slugify } from '../lib/format.js';
import { isNewModel, newBadgeTitle } from '../lib/newFlag.js';
import { useData } from '../stores/data.js';
import { useLeaderboard } from '../stores/leaderboard.js';
import { usePageSize } from '../lib/pager.js';
import AppPager from './AppPager.vue';
import { computed, ref, watch } from 'vue';

const props = defineProps({
  rows: { type: Array, required: true },
  tier: { type: String, default: 'all' },
});

// ── Pagination (stats-20, unified in stats-21) ────────────────────────────────────────────
// Client-side paging over the already-filtered leaderboard rows. The page
// size is the app-wide shared setting (lib/pager.js — same options, same
// default and the same value on every table); 0 = All (full scroll).
const pageSize = usePageSize();
const page = ref(1);
const perPage = computed(() => (pageSize.value === 0
  ? Math.max(props.rows.length, 1) : pageSize.value));
// filter/tab changes reshape the list — land back on the first page
watch(() => props.rows.length, () => { page.value = 1; });

const { stats, coreBenchmarks, scoreForModel, avgForModel, clForModel, coveredCountForModel, rankOf, tierOf, benchThAttrs, isOlder, supersededBy, metaFor, releaseDateOf, priceFor, valueFor, hfIdFor, hfUrlFor, availableAtFor, hasFreeListingFor } = useData();
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

// stats-27: NEW badge — release date (models_meta.created) within the
// user-adjustable window (lib/newFlag.js singleton, default 7 days). No
// date on record → no badge, honest gap.
const isNewRow = (row) => isNewModel(releaseDateOf(row));

// The model's short API id (org/model) — stats-19: listings present only the
// full name; the id lives on the model card and in hover tooltips.
const apiIdOf = (row) => metaFor(row)?.or_id || null;
const modelLinkTitle = (row) =>
  `Open ${row.name}'s score card${apiIdOf(row) ? ' · API id: ' + apiIdOf(row) : ''}`;
// stats-26: the ★ alias note merges into the link's Buefy tooltip — a nested
// tooltip on the star would open two tooltips at once when hovered
const linkTip = (row) =>
  modelLinkTitle(row) + (aliasNote(row) ? ' · ★ ' + aliasNote(row) : '');
// stats-26: full benchmark name as the header tooltip (same text benchThAttrs
// produced, reused so the wording lives in exactly one place)
const benchThLabel = (b) => benchThAttrs({ field: b }).title || b;

// ── Availability chips ("available at" layer, stats-18) ────────────────
// free chip: the row has a FREE LISTING at some seller — free ≠ unlimited,
// the tooltip carries the rate-limit caveat and names the free sellers.
// sellers chip: shown when the model reaches ≥2 catalogs, or sits in exactly
// one catalog that is NOT OpenRouter (available despite no router match) —
// OpenRouter-only rows stay chip-free so the default table stays quiet.
const FREE_CAVEAT = 'free tier — rate limits apply, not unlimited';
function freeTitle(row) {
  const sellers = availableAtFor(row).filter(a => a.free).map(a => a.n);
  return `Free listing at ${sellers.join(' · ')} — ${FREE_CAVEAT}`;
}
function availCount(row) {
  const n = availableAtFor(row).length;
  if (n < 2) {
    const orOnly = n === 1 && availableAtFor(row)[0].p === 'openrouter';
    return orOnly ? null : (n === 1 ? 1 : null);
  }
  return n;
}
function availTitle(row) {
  const list = availableAtFor(row)
    .map(a => (a.free ? `${a.n} (free listing)` : a.n));
  return `Available at ${list.length} seller${list.length === 1 ? '' : 's'}: ${list.join(' · ')}. Full per-seller view on the model page.`;
}

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

// Tooltip for the Price cell: source (AA list price when available — the
// lab's own price, no routing margin — else the OpenRouter snapshot) + the
// full in / out / cache breakdown
function priceTitle(row) {
  const p = priceFor(row);
  if (!p) return 'No API price on record for this row';
  const src = p.source === 'aa'
    ? 'Artificial Analysis list price — the lab\u2019s own price, no routing margin'
    : 'OpenRouter snapshot — router list price';
  const cache = p.cache_read != null ? ` · cache read ${fmtUsd(p.cache_read)}` : '';
  return `API list price — input ${fmtUsd(p.input)} · output ${fmtUsd(p.output)}${cache} per 1M tokens (${src}; sorted by a 3:1 in:out blend). Compare sellers on the Providers page.`;
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
    paginated
    :per-page="perPage"
    v-model:current-page="page"
    pagination-position="bottom"
    aria-next-label="Next page"
    aria-previous-label="Previous page"
    aria-page-label="Page"
    aria-current-label="Current page"
  >
    <b-table-column field="rank" label="#" width="56" centered v-slot="props">
      <div class="rank" :class="rankClass(rankOf(tier, props.row))">{{ rankOf(tier, props.row) ?? '—' }}</div>
    </b-table-column>

    <b-table-column field="name" label="Model" sticky width="240" sortable>
      <template #default="props">
      <div class="model-cell">
        <span class="av" :style="{ background: providerColor(props.row.name).color }">
          {{ initials(props.row.name) }}
        </span>
        <div>
          <!-- stats-26: Buefy tooltip — link info + the ★ alias note merged
               into one label (nested tooltips would fire together) -->
          <b-tooltip :label="linkTip(props.row)" type="is-dark" multilined :delay="100" append-to-body>
            <router-link
              class="model-link has-text-weight-semibold"
              :to="{ name: 'model', params: { slug: slugify(props.row.name) } }"
            >{{ props.row.name }}<span v-if="aliasNote(props.row)" class="alias-star">★</span></router-link>
          </b-tooltip>
          <div class="cell-sub">
            {{ providerColor(props.row.name).name }}
            <span v-if="tier === 'all'" class="tier-chip" :class="tierOf(props.row)">{{ tierOf(props.row) === 'closed' ? 'closed' : 'open' }}</span>
            <b-tooltip v-if="isNewRow(props.row)" :label="newBadgeTitle(releaseDateOf(props.row))" type="is-dark" multilined :delay="100" append-to-body><span class="new-chip">NEW</span></b-tooltip>
            <b-tooltip v-if="isOlder(props.row)" :label="olderTitle(props.row)" type="is-dark" multilined :delay="100" append-to-body><span class="older-chip">older</span></b-tooltip>
            <b-tooltip v-if="hfUrlFor(props.row)" :label="'Hugging Face: ' + hfIdFor(props.row)" type="is-dark" :delay="100" append-to-body><a class="hf-chip" :href="hfUrlFor(props.row)" target="_blank" rel="noopener noreferrer" @click.stop>HF</a></b-tooltip>
            <b-tooltip v-if="hasFreeListingFor(props.row)" :label="freeTitle(props.row)" type="is-dark" multilined :delay="100" append-to-body><span class="free-chip">free</span></b-tooltip>
            <b-tooltip v-if="availCount(props.row)" :label="availTitle(props.row)" type="is-dark" multilined :delay="100" append-to-body><span class="avail-chip">{{ availCount(props.row) }} sellers</span></b-tooltip>
          </div>
        </div>
      </div>
      </template>
    </b-table-column>

    <b-table-column field="avg" label="Score" width="120" centered numeric sortable :custom-sort="byScore">
      <template #header>
        <!-- stats-26: header hint as Buefy tooltip (native th title retired) -->
        <b-tooltip label="CL-weighted global score — raw sparse avg blended toward a neutral 50 in proportion to benchmark coverage (CL). Full coverage = raw avg." type="is-dark" multilined :delay="100" append-to-body>Score</b-tooltip>
      </template>
      <template #default="props">
        <div class="num" :style="{ color: scoreColor(scoreForModel(props.row)), fontWeight: 600 }">
          <b-tooltip :label="scoreTitle(props.row)" type="is-dark" multilined :delay="100" append-to-body>{{ fmtScore(scoreForModel(props.row)) }}</b-tooltip>
        </div>
        <div class="bar" style="margin-top:.3rem"><i :style="{ width: barWidth(scoreForModel(props.row)) }"></i></div>
      </template>
    </b-table-column>

    <!-- Price: per-model API metadata (not a benchmark), always visible.
         AA list price when available (the lab's own, no routing margin),
         else the OpenRouter snapshot; models with no price on record show
         an honest dash. -->
    <b-table-column field="price" label="Price" width="115" centered sortable :custom-sort="byPrice">
      <template #header>
        <b-tooltip label="API list price, USD per 1M tokens — input / output. Artificial Analysis list price when available (no routing margin); OpenRouter snapshot otherwise. Sorted by a 3:1 in:out blend. — = no price on record." type="is-dark" multilined :delay="100" append-to-body>Price</b-tooltip>
      </template>
      <template #default="props">
        <b-tooltip v-if="priceFor(props.row)" :label="priceTitle(props.row)" type="is-dark" multilined :delay="100" append-to-body><span class="price-cell">{{ fmtUsd(priceFor(props.row).input) }}<span class="price-sep">/</span>{{ fmtUsd(priceFor(props.row).output) }}</span></b-tooltip>
        <b-tooltip v-else :label="priceTitle(props.row)" type="is-dark" multilined :delay="100" append-to-body><span class="cell-sub">—</span></b-tooltip>
      </template>
    </b-table-column>

    <!-- Value lens: Score per 1M blended tokens (Score ÷ 3:1-blended $/1M).
         Higher = more benchmark score per dollar. Always-visible identity
         metadata, like Price — not a benchmark, never feeds the Score.
         Rows with no score / no price (and free tiers) show an honest dash. -->
    <b-table-column field="value" label="Value" width="90" centered numeric sortable :custom-sort="byValue">
      <template #header>
        <b-tooltip label="Value lens — Score per 1M blended tokens (Score ÷ blended $/1M, 3:1 in:out). Higher = more benchmark score per dollar. — = no Score or no API price; free tiers excluded." type="is-dark" multilined :delay="100" append-to-body>Value</b-tooltip>
      </template>
      <template #default="props">
        <b-tooltip v-if="valueFor(props.row) !== null" :label="valueTitle(props.row)" type="is-dark" multilined :delay="100" append-to-body><span class="num value-cell" style="font-weight:600">{{ fmtValue(valueFor(props.row)) }}</span></b-tooltip>
        <b-tooltip v-else :label="valueTitle(props.row)" type="is-dark" multilined :delay="100" append-to-body><span class="cell-sub value-cell">—</span></b-tooltip>
      </template>
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
    >
      <template #header>
        <!-- stats-26: full benchmark name as a Buefy header tooltip -->
        <b-tooltip :label="benchThLabel(b)" type="is-dark" multilined :delay="100" append-to-body>{{ SHORT[b] || b }}</b-tooltip>
      </template>
      <template #default="props">
        <span :style="{ color: scoreColor(props.row[b]), fontWeight: 500 }">{{ fmtScore(props.row[b]) }}</span>
      </template>
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

    <!-- stats-21: the one pager — bottom-right, page numbers between the
         arrows, shared app-wide page size -->
    <template #pagination>
      <AppPager v-model:page="page" :total="rows.length" aria-label="Leaderboard pagination" />
    </template>
  </b-table>
  </div>
</template>
