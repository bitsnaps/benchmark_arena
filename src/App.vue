<script setup>
import { ref, computed, onMounted } from 'vue';

// ── Data ──────────────────────────────────────────────────────────────
const rawData = ref(null);
const loading = ref(true);
const error = ref(null);
const activeTab = ref('pivot');      // pivot | per-bench
const modelType = ref('closed');      // closed | open
const searchQuery = ref('');
const compareMode = ref(false);
const compareList = ref([]);
const expandedBench = ref(null);

// Short labels for benchmark columns
const SHORT = {
  'Artificial Analysis': 'AA',
  'BenchLM.ai': 'BenchLM',
  'Arena.ai Text': 'Arena',
  'SimpleBench.com': 'SimpleB',
  'ARC Prize': 'ARC',
  'Design Arena': 'Design',
  'DeepSWE': 'DeepSWE',
  'VendingBench': 'Vending',
  'SWE-Marathon': 'SWE-M',
  'FrontierSWE': 'Frontier',
  'CyberGem': 'CyberG',
};

const CORE_BENCHMARKS = [
  'Artificial Analysis', 'BenchLM.ai', 'Arena.ai Text',
  'SimpleBench.com', 'ARC Prize', 'Design Arena',
  'SWE-Marathon', 'FrontierSWE',
];

onMounted(async () => {
  try {
    const res = await fetch('benchmark_results.json');
    rawData.value = await res.json();
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
  if (!rawData.value) return [];
  const key = modelType.value === 'closed' ? 'unified_closed' : 'unified_open';
  let rows = rawData.value[key] || [];
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase();
    rows = rows.filter(r => r.name.toLowerCase().includes(q));
  }
  return rows;
});

const perBenchData = computed(() => {
  if (!rawData.value) return {};
  return rawData.value.per_benchmark || {};
});

const stats = computed(() => {
  if (!rawData.value) return {};
  return {
    closed: rawData.value.unified_closed?.length ?? 0,
    open: rawData.value.unified_open?.length ?? 0,
    totalBenchmarks: benchmarks.value.length,
    coreBenchmarks: CORE_BENCHMARKS.length,
    lastUpdated: rawData.value.timestamp || '—',
  };
});

// ── Helpers ──────────────────────────────────────────────────────────
function scoreClass(val) {
  if (val === null || val === undefined) return 'cell-empty';
  if (val >= 90) return 'cell-90';
  if (val >= 75) return 'cell-75';
  if (val >= 60) return 'cell-60';
  if (val >= 40) return 'cell-40';
  return 'cell-low';
}

function fmtScore(val) {
  if (val === null || val === undefined) return '—';
  return Number.isInteger(val) ? val : val.toFixed(1);
}

function toggleCompare(name) {
  if (compareList.value.includes(name)) {
    compareList.value = compareList.value.filter(n => n !== name);
  } else if (compareList.value.length < 5) {
    compareList.value.push(name);
  }
}

function isCompared(name) {
  return compareList.value.includes(name);
}

function avgForModel(row) {
  const vals = coreBenchmarks.value
    .map(b => row[b])
    .filter(v => v !== null && v !== undefined);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

const compareData = computed(() => {
  if (compareList.value.length === 0) return null;
  const allModels = [...(rawData.value?.unified_closed ?? []), ...(rawData.value?.unified_open ?? [])];
  const selected = compareList.value
    .map(name => allModels.find(m => m.name === name))
    .filter(Boolean);
  if (selected.length === 0) return null;
  return selected;
});

function compareAvg(model) {
  return avgForModel(model);
}

function rankLabel(row, index) {
  return `#${index + 1}`;
}
</script>

<template>
  <div class="app">
    <!-- Header -->
    <header class="header">
      <div class="header-inner">
        <h1 class="title">
          <span class="title-icon">&#x2694;</span> Benchmark Arena
        </h1>
        <p class="subtitle">LLM model performance across 11 leaderboards</p>
      </div>
    </header>

    <!-- Loading / Error -->
    <div v-if="loading" class="loading">
      <div class="spinner"></div>
      <p>Loading benchmark data...</p>
    </div>
    <div v-else-if="error" class="error-msg">{{ error }}</div>

    <!-- Main Content -->
    <template v-else>
      <!-- Stats Bar -->
      <div class="stats-bar">
        <div class="stat-chip">
          <span class="stat-num">{{ stats.closed }}</span>
          <span class="stat-label">Closed</span>
        </div>
        <div class="stat-chip">
          <span class="stat-num">{{ stats.open }}</span>
          <span class="stat-label">Open-Weight</span>
        </div>
        <div class="stat-chip">
          <span class="stat-num">{{ stats.totalBenchmarks }}</span>
          <span class="stat-label">Benchmarks</span>
        </div>
        <div class="stat-chip stat-date">
          <span class="stat-label">Updated</span>
          <span class="stat-num">{{ stats.lastUpdated }}</span>
        </div>
      </div>

      <!-- View Tabs -->
      <div class="view-tabs">
        <button
          :class="['tab-btn', { active: activeTab === 'pivot' }]"
          @click="activeTab = 'pivot'"
        >Pivot Table</button>
        <button
          :class="['tab-btn', { active: activeTab === 'per-bench' }]"
          @click="activeTab = 'per-bench'"
        >Per-Benchmark</button>
        <button
          :class="['tab-btn compare-btn', { active: compareMode }]"
          @click="compareMode = !compareMode; if (!compareMode) compareList = []"
        >{{ compareMode ? 'Exit Compare' : 'Compare' }}
          <span v-if="compareList.length" class="compare-badge">{{ compareList.length }}</span>
        </button>
      </div>

      <!-- ═══ PIVOT TABLE VIEW ═══ -->
      <div v-if="activeTab === 'pivot'" class="view">
        <!-- Type Tabs + Search -->
        <div class="controls-row">
          <div class="type-tabs">
            <button
              :class="['type-btn', { active: modelType === 'closed' }]"
              @click="modelType = 'closed'"
            >Closed-Source</button>
            <button
              :class="['type-btn', { active: modelType === 'open' }]"
              @click="modelType = 'open'"
            >Open-Weight</button>
          </div>
          <input
            v-model="searchQuery"
            class="search-input"
            type="text"
            placeholder="Filter models..."
          />
        </div>

        <!-- Pivot Table -->
        <div class="table-wrap">
          <table class="pivot-table">
            <thead>
              <tr>
                <th class="th-rank" v-if="compareMode"></th>
                <th class="th-model">Model</th>
                <th class="th-avg">Avg (Core)</th>
                <th
                  v-for="b in benchmarks"
                  :key="b"
                  :class="['th-score', { 'th-core': coreBenchmarks.includes(b) }]"
                  :title="b"
                >{{ SHORT[b] || b }}</th>
                <th class="th-cl">CL</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, i) in pivotData" :key="row.name">
                <td v-if="compareMode" class="td-compare">
                  <input
                    type="checkbox"
                    :checked="isCompared(row.name)"
                    @change="toggleCompare(row.name)"
                    :disabled="!isCompared(row.name) && compareList.length >= 5"
                  />
                </td>
                <td class="td-model">{{ row.name }}</td>
                <td class="td-avg">{{ fmtScore(avgForModel(row)) }}</td>
                <td
                  v-for="b in benchmarks"
                  :key="b"
                  :class="['td-score', scoreClass(row[b])]"
                >{{ fmtScore(row[b]) }}</td>
                <td class="td-cl">
                  <span class="cl-badge" :style="{ '--cl-pct': (row.cl || 0) + '%' }">
                    {{ row.cl ? row.cl + '%' : '—' }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-if="!pivotData.length" class="empty-msg">No models match your filter.</p>
        </div>
        <p class="table-note">
          CL = Coverage Level (core benchmarks present / total core benchmarks).
          Core benchmarks ({{ stats.coreBenchmarks }}): {{ CORE_BENCHMARKS.join(', ') }}.
          Non-core (shown but not averaged): DeepSWE, VendingBench, CyberGem.
        </p>
      </div>

      <!-- ═══ PER-BENCHMARK VIEW ═══ -->
      <div v-if="activeTab === 'per-bench'" class="view">
        <div v-for="(benchData, benchName) in perBenchData" :key="benchName" class="bench-section">
          <button
            class="bench-header"
            @click="expandedBench = expandedBench === benchName ? null : benchName"
          >
            <span class="bench-arrow" :class="{ open: expandedBench === benchName }">&#9654;</span>
            <span class="bench-name">{{ benchName }}</span>
            <span class="bench-count">{{ benchData.closed.length }}c / {{ benchData.open.length }}o</span>
          </button>

          <div v-if="expandedBench === benchName" class="bench-body">
            <!-- Closed -->
            <div v-if="benchData.closed.length" class="bench-group">
              <h4 class="group-label">Closed-Source</h4>
              <table class="bench-table">
                <thead><tr><th>#</th><th>Model</th><th>Score</th></tr></thead>
                <tbody>
                  <tr v-for="(item, i) in benchData.closed" :key="i">
                    <td class="rank-cell">{{ i + 1 }}</td>
                    <td>{{ item[0] }}</td>
                    <td :class="['score-cell', scoreClass(item[1])]">{{ fmtScore(item[1]) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <!-- Open -->
            <div v-if="benchData.open.length" class="bench-group">
              <h4 class="group-label">Open-Weight</h4>
              <table class="bench-table">
                <thead><tr><th>#</th><th>Model</th><th>Score</th></tr></thead>
                <tbody>
                  <tr v-for="(item, i) in benchData.open" :key="i">
                    <td class="rank-cell">{{ i + 1 }}</td>
                    <td>{{ item[0] }}</td>
                    <td :class="['score-cell', scoreClass(item[1])]">{{ fmtScore(item[1]) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <!-- ═══ COMPARE PANEL ═══ -->
      <div v-if="compareMode && compareData" class="compare-panel">
        <h3 class="compare-title">Model Comparison</h3>
        <table class="compare-table">
          <thead>
            <tr>
              <th class="th-model">Model</th>
              <th class="th-avg">Avg</th>
              <th v-for="b in benchmarks" :key="b" class="th-score" :title="b">
                {{ SHORT[b] || b }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="model in compareData" :key="model.name">
              <td class="td-model">{{ model.name }}</td>
              <td class="td-avg">{{ fmtScore(compareAvg(model)) }}</td>
              <td
                v-for="b in benchmarks"
                :key="b"
                :class="['td-score', scoreClass(model[b])]"
              >{{ fmtScore(model[b]) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Footer -->
      <footer class="footer">
        <p>Data scraped from 11 public leaderboards. Scores are normalized to 0-100 where possible. Not an official ranking.</p>
      </footer>
    </template>
  </div>
</template>

<style scoped>
/* ── Layout ──────────────────────────────────────────────────────── */
.app {
  max-width: 1400px;
  margin: 0 auto;
  padding: 0 24px 60px;
}

/* ── Header ─────────────────────────────────────────────────────── */
.header {
  text-align: center;
  padding: 48px 0 32px;
}
.title {
  font-size: 2.2rem;
  font-weight: 700;
  margin: 0 0 8px;
  letter-spacing: -0.5px;
  color: #f1f5f9;
}
.title-icon {
  margin-right: 8px;
}
.subtitle {
  color: #94a3b8;
  font-size: 1rem;
  margin: 0;
}

/* ── Stats Bar ──────────────────────────────────────────────────── */
.stats-bar {
  display: flex;
  gap: 12px;
  justify-content: center;
  flex-wrap: wrap;
  margin-bottom: 28px;
}
.stat-chip {
  background: rgba(99, 102, 241, 0.1);
  border: 1px solid rgba(99, 102, 241, 0.2);
  border-radius: 12px;
  padding: 10px 20px;
  text-align: center;
  min-width: 100px;
}
.stat-num {
  display: block;
  font-size: 1.4rem;
  font-weight: 700;
  color: #c7d2fe;
}
.stat-label {
  font-size: 0.75rem;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.stat-date {
  min-width: 140px;
}
.stat-date .stat-num {
  font-size: 0.9rem;
  font-weight: 500;
}

/* ── Tabs ───────────────────────────────────────────────────────── */
.view-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 24px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.15);
  padding-bottom: 0;
}
.tab-btn {
  background: none;
  border: none;
  color: #94a3b8;
  font-size: 0.95rem;
  padding: 10px 20px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
}
.tab-btn:hover {
  color: #e2e8f0;
}
.tab-btn.active {
  color: #a5b4fc;
  border-bottom-color: #6366f1;
}
.compare-btn {
  margin-left: auto;
}
.compare-badge {
  background: #6366f1;
  color: white;
  font-size: 0.7rem;
  padding: 1px 6px;
  border-radius: 999px;
  margin-left: 4px;
  vertical-align: middle;
}

/* ── Controls Row ───────────────────────────────────────────────── */
.controls-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.type-tabs {
  display: flex;
  gap: 4px;
  background: rgba(30, 32, 48, 0.6);
  border-radius: 10px;
  padding: 4px;
}
.type-btn {
  background: none;
  border: none;
  color: #94a3b8;
  padding: 8px 18px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.9rem;
  transition: all 0.2s;
}
.type-btn:hover { color: #e2e8f0; }
.type-btn.active {
  background: rgba(99, 102, 241, 0.25);
  color: #c7d2fe;
}
.search-input {
  background: rgba(30, 32, 48, 0.6);
  border: 1px solid rgba(148, 163, 184, 0.15);
  color: #e2e8f0;
  padding: 8px 16px;
  border-radius: 10px;
  font-size: 0.9rem;
  width: 220px;
  outline: none;
  transition: border-color 0.2s;
}
.search-input:focus {
  border-color: rgba(99, 102, 241, 0.5);
}
.search-input::placeholder {
  color: #64748b;
}

/* ── Pivot Table ────────────────────────────────────────────────── */
.table-wrap {
  overflow-x: auto;
  border-radius: 16px;
  border: 1px solid rgba(148, 163, 184, 0.1);
  background: rgba(15, 16, 28, 0.6);
}
.pivot-table,
.bench-table,
.compare-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
}
.pivot-table th,
.bench-table th,
.compare-table th {
  position: sticky;
  top: 0;
  background: rgba(22, 24, 40, 0.95);
  color: #94a3b8;
  font-weight: 600;
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  padding: 12px 14px;
  text-align: left;
  white-space: nowrap;
  border-bottom: 1px solid rgba(148, 163, 184, 0.1);
}
.th-core {
  color: #a5b4fc;
}
.th-model {
  min-width: 180px;
}
.th-avg,
.td-avg {
  font-weight: 700;
  color: #fbbf24;
  text-align: center;
  min-width: 60px;
}
.th-score,
.td-score {
  text-align: center;
  min-width: 65px;
  padding: 10px 8px;
}
.th-rank,
.td-compare {
  width: 40px;
  text-align: center;
}
.th-cl,
.td-cl {
  text-align: center;
  min-width: 50px;
}

.pivot-table td,
.compare-table td {
  padding: 10px 8px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.05);
}
.pivot-table tbody tr:hover,
.compare-table tbody tr:hover {
  background: rgba(99, 102, 241, 0.06);
}
.td-model {
  color: #e2e8f0;
  font-weight: 500;
  white-space: nowrap;
}

/* Score heat */
.cell-90 { color: #4ade80; font-weight: 600; }
.cell-75 { color: #86efac; }
.cell-60 { color: #fde68a; }
.cell-40 { color: #fdba74; }
.cell-low { color: #f87171; }
.cell-empty { color: #475569; }

/* CL badge */
.cl-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 0.78rem;
  font-weight: 600;
  background: rgba(99, 102, 241, calc(var(--cl-pct, 0%) * 0.01 * 0.4));
  border: 1px solid rgba(99, 102, 241, calc(var(--cl-pct, 0%) * 0.01 * 0.6));
  color: #c7d2fe;
}

.table-note {
  color: #64748b;
  font-size: 0.78rem;
  margin-top: 12px;
  text-align: center;
}
.empty-msg {
  text-align: center;
  color: #64748b;
  padding: 40px;
}

/* ── Per-Benchmark ──────────────────────────────────────────────── */
.bench-section {
  margin-bottom: 8px;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid rgba(148, 163, 184, 0.08);
  background: rgba(15, 16, 28, 0.4);
}
.bench-header {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 20px;
  background: none;
  border: none;
  color: #e2e8f0;
  font-size: 0.95rem;
  cursor: pointer;
  transition: background 0.15s;
  text-align: left;
}
.bench-header:hover {
  background: rgba(99, 102, 241, 0.08);
}
.bench-arrow {
  font-size: 0.7rem;
  transition: transform 0.2s;
  color: #64748b;
}
.bench-arrow.open {
  transform: rotate(90deg);
  color: #a5b4fc;
}
.bench-name {
  font-weight: 600;
}
.bench-count {
  color: #64748b;
  font-size: 0.8rem;
  margin-left: auto;
}
.bench-body {
  padding: 0 20px 16px;
}
.bench-group {
  margin-bottom: 16px;
}
.bench-group:last-child { margin-bottom: 0; }
.group-label {
  font-size: 0.78rem;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 0 0 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.08);
}
.bench-table {
  font-size: 0.85rem;
}
.bench-table th {
  background: transparent;
  padding: 6px 12px;
  font-size: 0.72rem;
}
.bench-table td {
  padding: 7px 12px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.04);
}
.rank-cell {
  color: #64748b;
  font-weight: 600;
  width: 36px;
}
.score-cell {
  font-weight: 600;
  text-align: center;
}

/* ── Compare Panel ──────────────────────────────────────────────── */
.compare-panel {
  margin-top: 32px;
  padding: 24px;
  background: rgba(15, 16, 28, 0.6);
  border-radius: 16px;
  border: 1px solid rgba(99, 102, 241, 0.2);
}
.compare-title {
  margin: 0 0 16px;
  color: #a5b4fc;
  font-size: 1.1rem;
}
.compare-table {
  font-size: 0.85rem;
}

/* ── Footer ─────────────────────────────────────────────────────── */
.footer {
  text-align: center;
  margin-top: 48px;
  padding-top: 24px;
  border-top: 1px solid rgba(148, 163, 184, 0.1);
  color: #475569;
  font-size: 0.8rem;
}

/* ── Loading / Error ────────────────────────────────────────────── */
.loading {
  text-align: center;
  padding: 80px 20px;
  color: #94a3b8;
}
.spinner {
  width: 40px;
  height: 40px;
  border: 3px solid rgba(99, 102, 241, 0.2);
  border-top-color: #6366f1;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin: 0 auto 16px;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
.error-msg {
  text-align: center;
  color: #f87171;
  padding: 40px;
}
</style>
