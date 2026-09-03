<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue';
import { useTheme } from './composables/useTheme';

const { isDark, toggleTheme } = useTheme();

// ── Data ──────────────────────────────────────────────────────────────
const rawData = ref(null);
const loading = ref(true);
const error = ref(null);
const activeTab = ref('pivot');      // pivot | per-bench
const modelType = ref('closed');     // closed | open
const searchQuery = ref('');
const compareMode = ref(false);
const compareRows = ref([]);
const openBenches = reactive({});

// Short labels for benchmark columns
const SHORT = {
  'Artificial Analysis': 'AA',
  'BenchLM.ai': 'BenchLM',
  'Arena.ai Text': 'Arena',
  'SimpleBench.com': 'SimpleB',
  'ARC-AGI-2': 'ARC-2',
  'Design Arena': 'Design',
  'DeepSWE': 'DeepSWE',
  'VendingBench': 'Vending',
  'SWE-Marathon': 'SWE-M',
  'FrontierSWE': 'Frontier',
  'CyberGem': 'CyberG',
};

const CORE_BENCHMARKS = [
  'Artificial Analysis', 'BenchLM.ai', 'Arena.ai Text',
  'SimpleBench.com', 'ARC-AGI-2', 'Design Arena',
  'SWE-Marathon', 'FrontierSWE',
];

onMounted(async () => {
  try {
    const res = await fetch('benchmark_results.json');
    rawData.value = await res.json();
    // Explicit false so the BCollapse default (true) doesn't open everything
    benchmarks.value.forEach(b => { openBenches[b] = false; });
    if (benchmarks.value.length) openBenches[benchmarks.value[0]] = true;
  } catch (e) {
    error.value = 'Failed to load benchmark data.';
  } finally {
    loading.value = false;
  }
});

// ── Computed ──────────────────────────────────────────────────────────
const benchmarks = computed(() => rawData.value?.benchmarks ?? []);
const coreBenchmarks = computed(() =>
  benchmarks.value.filter(b => CORE_BENCHMARKS.includes(b))
);

const pivotData = computed(() => {
  const key = modelType.value === 'closed' ? 'unified_closed' : 'unified_open';
  let rows = rawData.value?.[key] || [];
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase();
    rows = rows.filter(r => r.name.toLowerCase().includes(q));
  }
  return rows;
});

const perBenchData = computed(() => rawData.value?.per_benchmark || {});

const stats = computed(() => ({
  closed: rawData.value?.unified_closed?.length ?? 0,
  open: rawData.value?.unified_open?.length ?? 0,
  totalBenchmarks: benchmarks.value.length,
  coreBenchmarks: coreBenchmarks.value.length,
  lastUpdated: rawData.value?.timestamp || '—',
}));

// ── Helpers ──────────────────────────────────────────────────────────
function fmtScore(val) {
  if (val === null || val === undefined) return '—';
  return Number.isInteger(val) ? val : val.toFixed(1);
}

function avgForModel(row) {
  const vals = coreBenchmarks.value
    .map(b => row[b])
    .filter(v => v !== null && v !== undefined);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

// Score → Bulma text color helpers (heat map without custom CSS)
function scoreText(val) {
  if (val === null || val === undefined) return 'has-text-grey-light';
  if (val >= 90) return 'has-text-success has-text-weight-bold';
  if (val >= 75) return 'has-text-success';
  if (val >= 60) return 'has-text-warning has-text-weight-semibold';
  if (val >= 40) return 'has-text-warning';
  return 'has-text-danger';
}

function scoreTag(val) {
  if (val === null || val === undefined) return 'is-dark is-light';
  if (val >= 90) return 'is-success';
  if (val >= 75) return 'is-success is-light';
  if (val >= 60) return 'is-warning';
  if (val >= 40) return 'is-warning is-light';
  return 'is-danger is-light';
}

function clTag(cl) {
  if (cl === null || cl === undefined) return 'is-dark is-light';
  if (cl >= 100) return 'is-success';
  if (cl >= 62.5) return 'is-success is-light';
  if (cl >= 37.5) return 'is-warning is-light';
  return 'is-danger is-light';
}

// Sorter for the computed Avg column (nulls always sink to the bottom)
function byAvg(a, b, isAsc) {
  const av = avgForModel(a);
  const bv = avgForModel(b);
  if (av === null && bv === null) return 0;
  if (av === null) return 1;
  if (bv === null) return -1;
  return isAsc ? av - bv : bv - av;
}

// Full benchmark name as native tooltip on column headers
// (stable method reference — receives the column, reads its field)
function benchThAttrs(column) {
  const b = column.field;
  if (!b || b === 'avg') return {};
  const core = coreBenchmarks.value.includes(b);
  return { title: b + (core ? ' (core — counted in Avg)' : ' (not counted in Avg)') };
}

// ── Compare ──────────────────────────────────────────────────────────
// Match checked rows by name so selection survives switching Closed/Open
const isSameModel = (a, b) => a.name === b.name;
const canCheck = row =>
  compareRows.value.some(r => r.name === row.name) || compareRows.value.length < 5;

watch(compareMode, (on) => {
  if (!on) compareRows.value = [];
});

function toRows(list) {
  return list.map(([model, score]) => ({ model, score }));
}
</script>

<template>
  <div class="container is-fluid">
    <!-- Loading overlay -->
    <b-loading :model-value="loading" :is-full-page="true" />

    <!-- Header -->
    <header class="is-flex is-justify-content-space-between is-align-items-center pt-5 pb-2">
      <div>
        <h1 class="title is-4 mb-1">&#9876;&#65039; Benchmark Arena</h1>
        <p class="subtitle is-6 has-text-grey mb-0">
          LLM performance across {{ stats.totalBenchmarks }} public leaderboards
        </p>
      </div>
      <div class="is-flex is-align-items-center">
        <b-tag type="is-info is-light" class="mr-3 is-hidden-mobile">{{ stats.lastUpdated }}</b-tag>
        <b-button
          rounded
          size="is-small"
          :icon-left="isDark ? 'sun' : 'moon'"
          @click="toggleTheme"
        >
          {{ isDark ? 'Light' : 'Dark' }}
        </b-button>
      </div>
    </header>

    <!-- Error -->
    <b-message
      v-if="error"
      type="is-danger"
      has-icon
      icon="triangle-exclamation"
      title="Error"
    >{{ error }}</b-message>

    <!-- Main content -->
    <template v-else-if="!loading">
      <!-- Stats -->
      <nav class="level is-mobile mb-4">
        <div class="level-item has-text-centered">
          <div>
            <p class="heading">Closed models</p>
            <p class="title is-5">{{ stats.closed }}</p>
          </div>
        </div>
        <div class="level-item has-text-centered">
          <div>
            <p class="heading">Open-weight models</p>
            <p class="title is-5">{{ stats.open }}</p>
          </div>
        </div>
        <div class="level-item has-text-centered">
          <div>
            <p class="heading">Benchmarks</p>
            <p class="title is-5">{{ stats.totalBenchmarks }}</p>
          </div>
        </div>
        <div class="level-item has-text-centered">
          <div>
            <p class="heading">Core (in Avg)</p>
            <p class="title is-5">{{ stats.coreBenchmarks }}</p>
          </div>
        </div>
      </nav>

      <b-tabs v-model="activeTab">
        <!-- ═══ PIVOT TABLE VIEW ═══ -->
        <b-tab-item value="pivot" label="Pivot Table" icon="table">
          <b-field grouped group-multiline class="mb-3">
            <b-field has-addons class="mr-0 mb-0">
              <p class="control">
                <b-button
                  size="is-small"
                  :type="modelType === 'closed' ? 'is-primary' : 'is-primary is-light'"
                  @click="modelType = 'closed'"
                >Closed-Source</b-button>
              </p>
              <p class="control">
                <b-button
                  size="is-small"
                  :type="modelType === 'open' ? 'is-primary' : 'is-primary is-light'"
                  @click="modelType = 'open'"
                >Open-Weight</b-button>
              </p>
            </b-field>
            <b-field class="mb-0">
              <b-input
                v-model="searchQuery"
                placeholder="Filter models…"
                icon="magnifying-glass"
                size="is-small"
                rounded
              />
            </b-field>
            <b-field class="mb-0">
              <b-switch v-model="compareMode" size="is-small" type="is-info" left-label>
                Compare
                <b-tag v-if="compareRows.length" type="is-info" size="is-small" rounded>{{ compareRows.length }}</b-tag>
              </b-switch>
            </b-field>
          </b-field>

          <b-table
            :data="pivotData"
            narrowed
            hoverable
            scrollable
            :mobile-cards="false"
            :checkable="compareMode"
            v-model:checked-rows="compareRows"
            :header-checkable="false"
            :is-row-checkable="canCheck"
            :custom-is-checked="isSameModel"
            checkbox-position="left"
            :default-sort="['avg', 'desc']"
          >
            <b-table-column
              field="name"
              label="Model"
              sticky
              width="220"
              sortable
              v-slot="props"
            >
              <span class="has-text-weight-medium">{{ props.row.name }}</span>
            </b-table-column>

            <b-table-column
              field="avg"
              label="Avg"
              width="90"
              centered
              numeric
              sortable
              :custom-sort="byAvg"
              header-class="has-text-weight-semibold"
              v-slot="props"
            >
              <span :class="scoreText(avgForModel(props.row))">
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
              sortable
              :header-class="coreBenchmarks.includes(b) ? 'core-col' : 'noncore-col'"
              :cell-class="coreBenchmarks.includes(b) ? '' : 'noncore-cell'"
              :th-attrs="benchThAttrs"
              v-slot="props"
            >
              <span :class="scoreText(props.row[b])">{{ fmtScore(props.row[b]) }}</span>
            </b-table-column>

            <b-table-column
              field="cl"
              label="CL"
              width="80"
              centered
              sortable
              v-slot="props"
            >
              <b-tag
                v-if="props.row.cl !== null && props.row.cl !== undefined"
                size="is-small"
                :type="clTag(props.row.cl)"
              >{{ Math.round(props.row.cl) }}%</b-tag>
              <span v-else class="has-text-grey-light">—</span>
            </b-table-column>

            <template #empty>
              <div class="has-text-centered has-text-grey py-5">
                <b-icon icon="magnifying-glass" size="is-medium" />
                <p class="mt-2">No models match your filter.</p>
              </div>
            </template>
          </b-table>

          <p class="help has-text-centered mt-2">
            CL = Coverage Level (core benchmarks present / {{ stats.coreBenchmarks }} core).
            Core: {{ coreBenchmarks.map(b => SHORT[b] || b).join(', ') }}.
            Non-core columns (not averaged):
            {{ benchmarks.filter(b => !coreBenchmarks.includes(b)).map(b => SHORT[b] || b).join(', ') }}.
          </p>

          <!-- ═══ COMPARE PANEL ═══ -->
          <div v-if="compareRows.length" class="box mt-5">
            <div class="is-flex is-justify-content-space-between is-align-items-center mb-3">
              <h3 class="title is-5 mb-0">Comparison · {{ compareRows.length }}/5</h3>
              <b-button size="is-small" icon-left="xmark" @click="compareRows = []">Clear</b-button>
            </div>
            <b-table :data="compareRows" narrowed hoverable scrollable :mobile-cards="false">
              <b-table-column field="name" label="Model" width="220" v-slot="props">
                <span class="has-text-weight-medium">{{ props.row.name }}</span>
              </b-table-column>
              <b-table-column field="avg" label="Avg" width="90" centered numeric v-slot="props">
                <span :class="scoreText(avgForModel(props.row))">
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
                :header-class="coreBenchmarks.includes(b) ? 'core-col' : 'noncore-col'"
                :cell-class="coreBenchmarks.includes(b) ? '' : 'noncore-cell'"
                v-slot="props"
              >
                <span :class="scoreText(props.row[b])">{{ fmtScore(props.row[b]) }}</span>
              </b-table-column>
            </b-table>
          </div>
        </b-tab-item>

        <!-- ═══ PER-BENCHMARK VIEW ═══ -->
        <b-tab-item value="per-bench" label="Per-Benchmark" icon="list">
          <b-collapse
            v-for="(benchData, benchName) in perBenchData"
            :key="benchName"
            v-model="openBenches[benchName]"
            class="card block"
            animation="slide"
          >
            <template #trigger="{ open }">
              <div class="card-header" role="button">
                <p class="card-header-title">{{ benchName }}</p>
                <div class="card-header-icon is-flex is-align-items-center">
                  <b-tag type="is-link is-light" size="is-small" class="mr-2">
                    {{ benchData.closed.length }} closed
                  </b-tag>
                  <b-tag type="is-primary is-light" size="is-small" class="mr-3">
                    {{ benchData.open.length }} open
                  </b-tag>
                  <b-icon :icon="open ? 'angle-up' : 'angle-down'" />
                </div>
              </div>
            </template>

            <div class="card-content">
              <div class="columns">
                <div v-if="benchData.closed.length" class="column">
                  <h4 class="heading mb-2">Closed-Source</h4>
                  <b-table :data="toRows(benchData.closed)" hoverable narrowed striped :mobile-cards="false" :default-sort="['score', 'desc']">
                    <b-table-column label="#" width="48" numeric v-slot="props">
                      {{ props.index + 1 }}
                    </b-table-column>
                    <b-table-column field="model" label="Model" sortable v-slot="props">
                      {{ props.row.model }}
                    </b-table-column>
                    <b-table-column field="score" label="Score" centered numeric sortable width="90" v-slot="props">
                      <b-tag size="is-small" :type="scoreTag(props.row.score)">{{ fmtScore(props.row.score) }}</b-tag>
                    </b-table-column>
                  </b-table>
                </div>
                <div v-if="benchData.open.length" class="column">
                  <h4 class="heading mb-2">Open-Weight</h4>
                  <b-table :data="toRows(benchData.open)" hoverable narrowed striped :mobile-cards="false" :default-sort="['score', 'desc']">
                    <b-table-column label="#" width="48" numeric v-slot="props">
                      {{ props.index + 1 }}
                    </b-table-column>
                    <b-table-column field="model" label="Model" sortable v-slot="props">
                      {{ props.row.model }}
                    </b-table-column>
                    <b-table-column field="score" label="Score" centered numeric sortable width="90" v-slot="props">
                      <b-tag size="is-small" :type="scoreTag(props.row.score)">{{ fmtScore(props.row.score) }}</b-tag>
                    </b-table-column>
                  </b-table>
                </div>
              </div>
            </div>
          </b-collapse>
        </b-tab-item>
      </b-tabs>
    </template>

    <!-- Footer -->
    <footer class="has-text-centered has-text-grey is-size-7 mt-6 pb-6">
      <p>
        Data scraped from {{ stats.totalBenchmarks }} public leaderboards.
        Scores are normalized to 0–100 where possible. Not an official ranking.
      </p>
    </footer>
  </div>
</template>

<style>
/* Tiny touch-ups on top of Bulma defaults (rendered by b-table, needs :global) */
th.core-col {
  box-shadow: inset 0 -3px 0 var(--bulma-primary, #00d1b2);
}
th.noncore-col,
td.noncore-cell {
  opacity: 0.75;
}
</style>
