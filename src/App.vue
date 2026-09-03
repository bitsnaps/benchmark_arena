<script setup>
import { ref, computed, watch, onMounted } from 'vue';

// ── Static config ─────────────────────────────────────────────────────
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

const LEADER_BENCHES = ['Artificial Analysis', 'Arena.ai Text', 'ARC-AGI-2', 'SWE-Marathon'];

const BLURBS = {
  'Artificial Analysis': 'Composite intelligence index blending reasoning, knowledge, math and code into one headline number.',
  'BenchLM.ai': 'Independent multi-task evaluation suite scoring applied accuracy.',
  'Arena.ai Text': 'Blind human preference battles on everyday prompts — the "does it feel smart" proxy.',
  'SimpleBench.com': 'Practical scenarios where agents must use tools, files and judgement, not just recall.',
  'ARC-AGI-2': 'Abstraction and reasoning puzzles designed to be Google-proof and memorization-resistant.',
  'Design Arena': 'Frontend and UI generation judged on real rendered output.',
  'DeepSWE': 'Agentic software engineering exercised on real repositories.',
  'VendingBench': 'Long-horizon planning and bookkeeping in a simulated vending-machine business.',
  'SWE-Marathon': 'Long, multi-step engineering sessions — stamina for real codebases.',
  'FrontierSWE': 'Hard, frontier-grade software engineering issues.',
  'CyberGem': 'Cybersecurity challenges in capture-the-flag style.',
};

const PROVIDER_MATCHERS = [
  { re: /claude|anthropic/i, name: 'Anthropic', color: '#d97757' },
  { re: /gpt|openai|chatgpt/i, name: 'OpenAI', color: '#10a37f' },
  { re: /gemini|gemma|google/i, name: 'Google', color: '#4285f4' },
  { re: /grok/i, name: 'xAI', color: '#cfd3dc' },
  { re: /deepseek/i, name: 'DeepSeek', color: '#4f6dff' },
  { re: /kimi|moonshot/i, name: 'Moonshot', color: '#14b8a6' },
  { re: /glm|zhipu/i, name: 'Z.ai', color: '#38bdf8' },
  { re: /minimax/i, name: 'MiniMax', color: '#ff4d6d' },
  { re: /qwen|qwq/i, name: 'Alibaba', color: '#c73b5f' },
  { re: /llama|meta/i, name: 'Meta', color: '#0668E1' },
  { re: /mistral|mixtral/i, name: 'Mistral', color: '#ff7000' },
  { re: /hunyuan/i, name: 'Tencent', color: '#0052d9' },
  { re: /ernie|baidu/i, name: 'Baidu', color: '#2932e1' },
  { re: /nova|amazon|aws/i, name: 'Amazon', color: '#ff9900' },
  { re: /phi|microsoft/i, name: 'Microsoft', color: '#00a4ef' },
  { re: /cohere|command/i, name: 'Cohere', color: '#39594d' },
];

// ── Data ──────────────────────────────────────────────────────────────
const rawData = ref(null);
const loading = ref(true);
const error = ref(null);

const view = ref('overview');         // overview | leaderboard | benchmarks
const menuOpen = ref(false);

// leaderboard state
const modelType = ref('closed');      // closed | open
const searchQuery = ref('');
const compareMode = ref(false);
const compareRows = ref([]);

// per-benchmark state
const activeBench = ref('');
const benchFilter = ref('all');       // all | closed | open

onMounted(async () => {
  try {
    const res = await fetch('benchmark_results.json');
    rawData.value = await res.json();
    activeBench.value = benchmarks.value[0] || '';
  } catch (e) {
    error.value = 'Failed to load benchmark data.';
  } finally {
    loading.value = false;
  }
});

// ── Computed ──────────────────────────────────────────────────────────
const benchmarks = computed(() => rawData.value?.benchmarks ?? []);
const coreBenchmarks = computed(() => benchmarks.value.filter(b => CORE_BENCHMARKS.includes(b)));
const nonCoreBenchmarks = computed(() => benchmarks.value.filter(b => !CORE_BENCHMARKS.includes(b)));

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

const topOverall = computed(() =>
  [...(rawData.value?.unified_closed || [])].sort((a, b) => (avgForModel(b) ?? -1) - (avgForModel(a) ?? -1))[0] || null);
const topOpen = computed(() =>
  [...(rawData.value?.unified_open || [])].sort((a, b) => (avgForModel(b) ?? -1) - (avgForModel(a) ?? -1))[0] || null);

const leaders = computed(() => LEADER_BENCHES.map(bench => {
  const rows = [
    ...(rawData.value?.unified_closed || []),
    ...(rawData.value?.unified_open || []),
  ].filter(r => r[bench] !== null && r[bench] !== undefined);
  const top = rows.reduce((acc, r) =>
    acc === null || (r[bench] ?? -1) > (acc[bench] ?? -1) ? r : acc, null);
  return { bench, short: SHORT[bench] || bench, model: top?.name ?? '—', score: top?.[bench] ?? null, count: rows.length };
}));

// ── Helpers ───────────────────────────────────────────────────────────
function fmtScore(val) {
  if (val === null || val === undefined) return '—';
  return Number.isInteger(val) ? String(val) : val.toFixed(1);
}

function avgForModel(row) {
  const vals = coreBenchmarks.value
    .map(b => row[b])
    .filter(v => v !== null && v !== undefined);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function scoreColor(val) {
  if (val === null || val === undefined) return 'var(--faint)';
  if (val >= 80) return 'var(--teal)';
  if (val >= 60) return 'var(--indigo)';
  if (val >= 40) return 'var(--gold)';
  return 'var(--rose)';
}

function barWidth(val) {
  if (val === null || val === undefined) return '0%';
  return Math.min(100, Math.max(0, val)) + '%';
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

// Rank (by Avg) within each model list, independent of current search/sort
const rankMap = computed(() => {
  const build = (list) => [...list]
    .sort((a, b) => (avgForModel(b) ?? -1) - (avgForModel(a) ?? -1))
    .reduce((map, r, i) => map.set(r.name, i + 1), new Map());
  return {
    closed: build(rawData.value?.unified_closed || []),
    open: build(rawData.value?.unified_open || []),
  };
});
const rankOf = (row) => rankMap.value[modelType.value]?.get(row.name);
const rankClass = (r) => (r === 1 ? 'g' : r === 2 ? 's' : r === 3 ? 'b' : '');

// Full benchmark name as native tooltip on column headers
function benchThAttrs(column) {
  const b = column.field;
  if (!b || b === 'avg' || b === 'rank') return {};
  const core = coreBenchmarks.value.includes(b);
  return { title: b + (core ? ' (core — counted in Avg)' : ' (not counted in Avg)') };
}

// ── Provider avatars ─────────────────────────────────────────────────
function providerColor(name) {
  const hit = PROVIDER_MATCHERS.find(p => p.re.test(name));
  return hit ? { name: hit.name, color: hit.color } : { name: 'Independent', color: '#8b9bb8' };
}
function initials(name) {
  const words = String(name).split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!words.length) return '??';
  const w0 = words[0];
  if (w0.length >= 3) return w0.slice(0, 2).toUpperCase();
  return (w0 + (words[1] || '')).slice(0, 2).toUpperCase();
}

// ── Compare ───────────────────────────────────────────────────────────
const isSameModel = (a, b) => a.name === b.name;
const canCheck = row =>
  compareRows.value.some(r => r.name === row.name) || compareRows.value.length < 5;

watch(compareMode, (on) => {
  if (!on) compareRows.value = [];
});

function isBest(bench, row) {
  if (row[bench] === null || row[bench] === undefined) return false;
  const max = Math.max(...compareRows.value.map(r => r[bench] ?? -1));
  return max > 0 && row[bench] === max;
}

// ── Per-benchmark explorer ───────────────────────────────────────────
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

const trackColor = (i) => i === 0
  ? 'linear-gradient(90deg,#f5c15a,#2ee6c7)'
  : 'linear-gradient(90deg,#4f6dff,#2ee6c7)';

const isCore = (b) => coreBenchmarks.value.includes(b);

// ── Navigation ────────────────────────────────────────────────────────
function go(v) {
  view.value = v;
  menuOpen.value = false;
  window.scrollTo({ top: 0 });
}
function goCompare() {
  compareMode.value = true;
  go('leaderboard');
}
function searchForModel(name) {
  searchQuery.value = name;
  go('leaderboard');
}

function toRows(list) {
  return list.map(([model, score]) => ({ model, score }));
}
</script>

<template>
  <div>
    <b-loading :model-value="loading" :is-full-page="true" />

    <!-- ── Navbar ─────────────────────────────────────────────── -->
    <nav class="navbar is-fixed-top lab-nav" role="navigation" aria-label="main navigation">
      <div class="wrap" style="display:flex;width:min(1240px,calc(100% - 2rem));">
        <div class="navbar-brand">
          <a class="navbar-item" href="#" @click.prevent="go('overview')">
            <span class="brand-mark"><i class="fas fa-ranking-star"></i></span>
            <span class="brand-word">Benchmark <span>Arena</span></span>
          </a>
          <a role="button" class="navbar-burger" :class="{ 'is-active': menuOpen }" aria-label="menu"
            :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">
            <span aria-hidden="true"></span><span aria-hidden="true"></span><span aria-hidden="true"></span>
          </a>
        </div>
        <div class="navbar-menu" :class="{ 'is-active': menuOpen }">
          <div class="navbar-start">
            <a class="navbar-item" :class="{ 'is-active': view === 'overview' }" @click="go('overview')">Overview</a>
            <a class="navbar-item" :class="{ 'is-active': view === 'leaderboard' }" @click="go('leaderboard')">Leaderboard</a>
            <a class="navbar-item" :class="{ 'is-active': view === 'benchmarks' }" @click="go('benchmarks')">Benchmarks</a>
          </div>
          <div class="navbar-end">
            <a class="navbar-item compare-pill" @click="goCompare">
              <i class="fas fa-code-compare"></i>&nbsp; Compare ({{ compareRows.length }})
            </a>
          </div>
        </div>
      </div>
    </nav>

    <main class="shell">
      <div class="wrap">
        <!-- Error -->
        <b-message v-if="error" type="is-danger" has-icon icon="triangle-exclamation" title="Error">
          {{ error }}
        </b-message>

        <template v-else-if="!loading">
          <!-- ═══ OVERVIEW ═══ -->
          <section v-show="view === 'overview'">
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
                <b-button type="is-primary" icon-left="ranking-star" @click="go('leaderboard')">
                  Open the leaderboard
                </b-button>
                <b-button icon-left="chart-simple" @click="go('benchmarks')">
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
                <div class="model-tile" @click="go('leaderboard')">
                  <div class="tag-lab teal">Overall</div>
                  <h3 style="margin:.6rem 0 .3rem">Global pivot</h3>
                  <p style="color:var(--muted);font-size:.9rem">
                    One sortable table across every eval — closed and open weights side by side,
                    with coverage flags and a composite average.
                  </p>
                </div>
                <div class="model-tile" @click="go('benchmarks')">
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

          <!-- ═══ LEADERBOARD ═══ -->
          <section v-show="view === 'leaderboard'">
            <div class="page-head">
              <div class="kicker">Global overall</div>
              <h1 class="section-title">Leaderboard</h1>
              <p class="section-sub">
                Sortable scores across every source. Click a row's checkbox to line models up side by side.
              </p>
            </div>

            <div class="panel-lab" style="padding:1rem">
              <div class="row">
                <b-field class="mb-0" style="flex:1;min-width:220px">
                  <b-input v-model="searchQuery" placeholder="Filter models…" icon="magnifying-glass" rounded />
                </b-field>
                <b-field has-addons class="mb-0">
                  <p class="control">
                    <b-button :type="modelType === 'closed' ? 'is-primary' : 'is-primary is-light'"
                      @click="modelType = 'closed'">Closed-source</b-button>
                  </p>
                  <p class="control">
                    <b-button :type="modelType === 'open' ? 'is-primary' : 'is-primary is-light'"
                      @click="modelType = 'open'">Open-weight</b-button>
                  </p>
                </b-field>
                <b-field class="mb-0">
                  <b-switch v-model="compareMode" type="is-primary" left-label>
                    Compare
                    <b-tag v-if="compareRows.length" type="is-warning" size="is-small" rounded>
                      {{ compareRows.length }}/5
                    </b-tag>
                  </b-switch>
                </b-field>
              </div>
            </div>

            <div class="mt">
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
                <b-table-column field="rank" label="#" width="56" centered v-slot="props">
                  <div class="rank" :class="rankClass(rankOf(props.row))">{{ rankOf(props.row) ?? '—' }}</div>
                </b-table-column>

                <b-table-column field="name" label="Model" sticky width="240" sortable v-slot="props">
                  <div class="model-cell">
                    <span class="av" :style="{ background: providerColor(props.row.name).color }">
                      {{ initials(props.row.name) }}
                    </span>
                    <div>
                      <div class="has-text-weight-semibold">{{ props.row.name }}</div>
                      <div class="cell-sub">{{ providerColor(props.row.name).name }}</div>
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

            <p class="cell-sub mt-sm" style="text-align:center">
              CL = Coverage Level (core benchmarks present / {{ stats.coreBenchmarks }}).
              Core: {{ coreBenchmarks.map(b => SHORT[b] || b).join(', ') }}.
              Context-only: {{ nonCoreBenchmarks.map(b => SHORT[b] || b).join(', ') }}.
            </p>

            <!-- Compare panel -->
            <div v-if="compareRows.length" class="panel-lab mt" style="padding:1.1rem">
              <div class="row" style="justify-content:space-between;margin-bottom:.6rem">
                <h3 class="section-title" style="margin:0;font-size:1.15rem">
                  Side by side · {{ compareRows.length }}/5
                </h3>
                <b-button size="is-small" icon-left="xmark" @click="compareRows = []">Clear</b-button>
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
          </section>

          <!-- ═══ BENCHMARKS ═══ -->
          <section v-show="view === 'benchmarks'">
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

        <!-- Footer -->
        <footer class="footer-lab mt">
          <div class="row" style="justify-content:space-between">
            <span>Benchmark Arena · Vue 3 + Buefy/Bulma · snapshot {{ stats.lastUpdated }}</span>
            <span>Data from {{ stats.totalBenchmarks }} public leaderboards · not an official ranking</span>
          </div>
        </footer>
      </div>
    </main>
  </div>
</template>

<style>
/* Secondary hero button — transparent ghost variant on top of Bulma */
.btn-ghost {
  background: transparent !important;
  border-color: var(--line-2) !important;
  color: var(--text) !important;
}
.btn-ghost:hover {
  color: var(--teal) !important;
  border-color: var(--teal) !important;
}
/* Core vs context-only column accents on b-table headers */
th.core-col {
  box-shadow: inset 0 -3px 0 var(--teal);
}
th.noncore-col,
td.noncore-cell {
  opacity: 0.75;
}
</style>
