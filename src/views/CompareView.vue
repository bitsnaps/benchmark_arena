<script setup>
// Side-by-side comparison — models as columns, specs + scores as rows.
// Selection is URL-synced via ?models=slug,slug (shareable links) and
// mirrored into the leaderboard store so the navbar pill, the home
// checkboxes and this page always agree. Specs come from the OpenRouter
// catalog snapshot (models_meta in benchmark_results.json).
import { computed, ref, watch, watchEffect } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { SHORT } from '../lib/constants.js';
import {
  fmtScore, scoreColor, barWidth, providerColor, initials,
  fmtCtx, fmtB, fmtUsd, modalityIcon,
} from '../lib/format.js';
import { vendorCompareGroups } from '../lib/vendorCompare.js';
import { useData } from '../stores/data.js';
import { useLeaderboard } from '../stores/leaderboard.js';

const route = useRoute();
const router = useRouter();

const {
  benchmarks, pivotAll, modelSlugIndex, scoreForModel, clForModel, coveredCountForModel, rankMaps, tierOf, isCore,
  stats, metaFor, metaCoverage, topClosed, topOpen, isOlder, archiveLinkFor,
  priceFor, valueFor, hasFreeListingFor,
  cardModels, isCardRow, isUnranked, vendorScoresFor,
  modelSlug,
} = useData();
const { compareRows, compareMode } = useLeaderboard();

const MAX = 5;

// stats-58: tooltip for the archived-source link rendered in an empty score
// cell — same wording as PivotTable / ModelDetailView (stats-49). Icon-only
// per Ibrahim: the words live in the tooltip + the link's aria-label.
const archTip = 'No current AA leaderboard entry — the model was archived by the source; its own page still carries score, pricing and latency';

// ── URL ⇄ selection sync ─────────────────────────────────────────────
const rowsForSlugs = (slugs) => {
  const seen = new Set();
  const rows = [];
  for (const s of slugs) {
    const row = modelSlugIndex.value.get(s);
    if (!row || seen.has(row.name)) continue;
    seen.add(row.name);
    rows.push(row);
    if (rows.length >= MAX) break;
  }
  return rows;
};

watch(
  () => [route.name, route.query.models],
  ([name, raw]) => {
    if (name !== 'compare') return;
    const q = typeof raw === 'string' ? raw : '';
    if (!q) {
      // Landed with no ?models=: seed the URL from the checkbox selection
      // (navbar pill entry point) instead of wiping it.
      if (compareRows.value.length) {
        router.replace({ query: { models: compareRows.value.map(r => modelSlug(r.name)).join(',') } });
      }
      return;
    }
    const rows = rowsForSlugs(q.split(','));
    if (rows.map(r => r.name).join('|') !== compareRows.value.map(r => r.name).join('|')) {
      compareRows.value = rows;
    }
    compareMode.value = rows.length > 0; // home table checkboxes stay in step
  },
  { immediate: true },
);

// Selection edits → URL (replace keeps the back button sane)
watch(compareRows, (rows) => {
  if (route.name !== 'compare') return;
  const want = rows.map(r => modelSlug(r.name)).join(',');
  const cur = typeof route.query.models === 'string' ? route.query.models : '';
  if (cur !== want) router.replace({ query: rows.length ? { models: want } : {} });
});

watchEffect(() => {
  const n = compareRows.value.length;
  const head = n
    ? compareRows.value.slice(0, 3).map(r => r.name).join(' vs ') + (n > 3 ? ` +${n - 3}` : '')
    : 'Side by side';
  document.title = `${head} · Benchmark Arena`;
});

// ── Selection helpers ────────────────────────────────────────────────
const removeModel = (name) => {
  compareRows.value = compareRows.value.filter(r => r.name !== name);
};
const clearAll = () => { compareRows.value = []; };

const addQ = ref('');
const addOptions = computed(() => {
  const q = addQ.value.trim().toLowerCase();
  const picked = new Set(compareRows.value.map(r => r.name));
  // stats-92: the OR-only census joins the picker — deep links always
  // resolved card slugs (modelSlugIndex registers them), but the models
  // themselves could not be searched. Census rows sort after the ranked
  // board (they claim no rating by contract).
  const known = new Set(pivotAll.value.map(r => r.name));
  const pool = [...pivotAll.value, ...cardModels.value.filter(r => !known.has(r.name))];
  const sc = (r) => (isCardRow(r) || isUnranked(r) ? null : scoreForModel(r));
  return pool
    .filter(r => !picked.has(r.name) && (!q || r.name.toLowerCase().includes(q)))
    .sort((a, b) => (sc(b) ?? -1) - (sc(a) ?? -1))
    .slice(0, 8);
});
// One-line status for a picker option: ranked rows show the Score, census
// rows say what they are instead of faking a number.
const optionSub = (r) => {
  if (isCardRow(r)) {
    const n = vendorScoresFor(r).length;
    const chip = r.hf_only ? 'HF-only' : 'OR-only';
    return n ? `${chip} · ${n} creator scores` : chip;
  }
  if (isUnranked(r)) return 'new & unranked';
  return `Score ${fmtScore(scoreForModel(r))}`;
};
function addModel(option) {
  if (!option) return;
  if (compareRows.value.length >= MAX || compareRows.value.some(r => r.name === option.name)) return;
  compareRows.value = [...compareRows.value, option];
  addQ.value = '';
}
const atCap = computed(() => compareRows.value.length >= MAX);

// One-click starting points for the empty state (current-generation models only)
const presets = computed(() => {
  const byScore = (a, b) => (scoreForModel(b) ?? -1) - (scoreForModel(a) ?? -1);
  const current = pivotAll.value.filter(r => !isOlder(r));
  const sorted = [...current].sort(byScore);
  const duel = [topClosed.value, topOpen.value].filter(Boolean);
  return [
    { label: 'Top 3 overall', icon: 'crown', rows: sorted.slice(0, 3) },
    { label: 'Closed #1 vs Open #1', icon: 'code-compare', rows: duel },
    { label: 'Top 3 open-weight', icon: 'lock-open', rows: sorted.filter(r => tierOf(r) === 'open').slice(0, 3) },
  ];
});
const loadPreset = (rows) => { if (rows.length) compareRows.value = rows.slice(0, MAX); };

const copied = ref(false);
async function copyLink() {
  try {
    await navigator.clipboard.writeText(location.href);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1600);
  } catch { /* clipboard unavailable — the URL bar still works */ }
}

// ── Column data (one entry per selected model) ───────────────────────
// stats-59: prices read through the store's priceFor() ladder (AA list →
// OpenRouter → cheapest seller → free $0) instead of the OpenRouter-only
// homegrown copy — the same numbers the leaderboard Price column shows, so
// the Compare page can never disagree with the table (and AA-priced,
// seller-priced and free-listing models stop rendering avoidable dashes).
const sel = computed(() => compareRows.value.map((row) => {
  const meta = metaFor(row);
  const price = priceFor(row);
  // stats-92: census rows (unranked single-source admissions + OR-only
  // cards) claim no rating — scoreForModel on a 1-cell unranked row
  // returns a mostly-prior blend that would ghost-rank this grid exactly
  // the way stats-90 banned in the home table. Honest dash here instead.
  const census = isCardRow(row) || isUnranked(row);
  const wscore = census ? null : scoreForModel(row);
  const tier = tierOf(row);
  return {
    row, meta, price, blended: price ? price.blend : null, avg: wscore, tier,
    census,
    free: hasFreeListingFor(row),
    // valueFor owns the ÷0 guard: free/$0 rows stay out of the value lens
    // (and census rows claim no rating, so no value number either)
    value: census ? null : valueFor(row),
    overallRank: rankMaps.value.all.get(row.name) ?? null,
    tierRank: rankMaps.value[tier]?.get(row.name) ?? null,
    supersededBy: meta?.superseded_by || null,
    stale: !!meta?.stale,
    released: meta?.created || null,
  };
}));

// Unique benchmark wins among the selection (ties don't count)
const winCounts = computed(() => {
  const counts = new Map(sel.value.map(s => [s.row.name, 0]));
  if (sel.value.length < 2) return counts;
  for (const b of benchmarks.value) {
    // stats-92: census rows can't win — a crown is a leaderboard claim and
    // the census (unranked + OR-only) carries no rating by contract
    const scored = sel.value.filter(s => !s.census && s.row[b] !== null && s.row[b] !== undefined);
    if (scored.length < 2) continue;
    const max = Math.max(...scored.map(s => s.row[b]));
    const winners = scored.filter(s => s.row[b] === max);
    if (winners.length === 1) counts.set(winners[0].row.name, counts.get(winners[0].row.name) + 1);
  }
  return counts;
});

const gridCols = computed(() =>
  `minmax(148px, 210px) repeat(${Math.max(sel.value.length, 1)}, minmax(180px, 1fr))`);

// ── Matrix rows ──────────────────────────────────────────────────────
// Every cell: { num, main, sub, color, bar, winner, tag, chips, href }
// `dir` marks comparable rows: 'high' = bigger wins, 'low' = smaller wins.
const cmpGroups = computed(() => {
  const S = sel.value;
  const mk = (dir, fn, rankedOnly = false) => {
    const cells = S.map(fn);
    let target = null;
    if (dir) {
      const nums = cells
        .filter((c, i) => !rankedOnly || !S[i].census)
        .map(c => c.num).filter(v => v !== null && v !== undefined);
      if (nums.length) target = dir === 'low' ? Math.min(...nums) : Math.max(...nums);
    }
    // stats-92: census cells display their number but never take the teal
    // win — "best of selection" stays a ranked-models claim
    cells.forEach((c, i) => { c.winner = !!dir && !S[i].census && target !== null && c.num !== null && c.num !== undefined && c.num === target; });
    return cells;
  };
  const dash = (fn) => S.map(fn); // non-comparable rows

  const head = (s) => {
    const src = s.meta?.params_source;
    return { src: src === 'openrouter' ? 'OpenRouter catalog' : src === 'huggingface' ? 'HF safetensors' : null };
  };
  const fmtValue = (v) => v === null || v === undefined ? '—' : v >= 100 ? Math.round(v).toString() : (Math.round(v * 10) / 10).toString();

  const groups = [];

  groups.push({
    label: 'Headline',
    rows: [
      { key: 'avg', label: 'Global Score', hint: `CL-weighted blend of the ${stats.value.coreBenchmarks} benchmarks in the current avg set`, cells: mk('high', (s) => ({ num: s.avg, main: fmtScore(s.avg), color: scoreColor(s.avg), bar: s.avg })) },
      { key: 'rank', label: 'Overall rank', hint: `of ${stats.value.closed + stats.value.open} tracked`, cells: mk('low', (s) => ({ num: s.overallRank, main: s.overallRank ? '#' + s.overallRank : '—', sub: s.tierRank ? `#${s.tierRank} among ${s.tier}` : null })) },
      { key: 'cl', label: 'Coverage', hint: 'share of the current avg set reported', cells: mk('high', (s) => ({ num: clForModel(s.row), main: Math.round(clForModel(s.row)) + '%', bar: clForModel(s.row), sub: `${coveredCountForModel(s.row)} of ${stats.value.coreBenchmarks} selected` })) },
      { key: 'status', label: 'Status', hint: 'current vs older release', cells: dash((s) => (s.supersededBy
        ? { main: 'Superseded', sub: 'by ' + s.supersededBy, tag: 'warning' }
        : s.stale
          ? { main: 'Older release', sub: 'stale generation', tag: 'warning' }
          : { main: 'Current', tag: 'teal' })) },
      { key: 'license', label: 'License', cells: dash((s) => ({ main: s.tier === 'closed' ? 'Closed-source' : 'Open-weight', tag: s.tier === 'closed' ? 'rose' : 'teal' })) },
    ],
  });

  groups.push({
    label: 'Specs · OpenRouter catalog',
    rows: [
      { key: 'params', label: 'Total params', cells: mk('high', (s) => ({ num: s.meta?.total_params_b ?? null, main: fmtB(s.meta?.total_params_b), sub: head(s).src })) },
      { key: 'active', label: 'Active params', hint: 'MoE per-token budget', cells: dash((s) => ({ num: s.meta?.active_params_b ?? null, main: fmtB(s.meta?.active_params_b), sub: s.meta?.active_params_b ? 'MoE' : null })) },
      { key: 'ctx', label: 'Context window', cells: mk('high', (s) => ({ num: s.meta?.context_length ?? null, main: fmtCtx(s.meta?.context_length), sub: 'tokens' })) },
      { key: 'maxout', label: 'Max output', cells: mk('high', (s) => ({ num: s.meta?.max_output_tokens ?? null, main: fmtCtx(s.meta?.max_output_tokens), sub: 'tokens' })) },
      { key: 'modal', label: 'Modalities', hint: 'input → output', cells: dash((s) => (s.meta ? {
          chips: [
            ...(s.meta.input_modalities || []).map(m => ({ icon: modalityIcon(m), label: m })),
            { arrow: true },
            ...(s.meta.output_modalities || []).map(m => ({ icon: modalityIcon(m), label: m })),
          ],
        } : { main: '—', sub: 'not in catalog snapshot' })) },
      { key: 'reason', label: 'Reasoning', cells: dash((s) => {
          const r = s.meta?.reasoning;
          if (!r) return { main: '—' };
          if (r.mandatory) return { main: 'Always on', tag: 'gold', sub: r.default_effort ? `default: ${r.default_effort}` : null };
          const eff = r.supported_efforts || [];
          return { main: eff.length ? `${eff.length} effort levels` : 'Selectable', sub: eff.length ? eff.join(', ') : null };
        }) },
      { key: 'tokenizer', label: 'Tokenizer', cells: dash((s) => ({ main: s.meta?.tokenizer || '—' })) },
      { key: 'cutoff', label: 'Knowledge cutoff', cells: dash((s) => ({ main: s.meta?.knowledge_cutoff || '—' })) },
      { key: 'released', label: 'Released', cells: dash((s) => ({ main: s.meta?.created || '—' })) },
      { key: 'orid', label: 'OpenRouter ID', cells: dash((s) => (s.meta ? { main: s.meta.or_id, href: orUrl(s.meta.or_id) } : { main: '—' })) },
    ],
  });

  // stats-59: price provenance rides on each cell as a sub label — the
  // number is never misattributed (same ethos as the model page's card).
  const priceSub = (s) => {
    const p = s.price;
    if (!p) return null;
    if (p.source === 'free') return 'free listing — rate limits apply';
    if (p.source === 'seller') return `via ${p.seller || 'seller'} (no AA/OR list price)`;
    if (p.source === 'aa') return 'AA list price';
    return 'OpenRouter snapshot';
  };

  groups.push({
    label: 'Pricing · USD per 1M tokens',
    rows: [
      { key: 'pin', label: 'Input', cells: mk('low', (s) => ({ num: s.price?.input ?? null, main: fmtUsd(s.price?.input), sub: priceSub(s) })) },
      { key: 'pout', label: 'Output', cells: mk('low', (s) => ({ num: s.price?.output ?? null, main: fmtUsd(s.price?.output) })) },
      { key: 'pblend', label: 'Blended', hint: '3:1 input:output', cells: mk('low', (s) => ({ num: s.blended ?? null, main: fmtUsd(s.blended) })) },
      { key: 'value', label: 'Score per $1M', hint: 'Global Score ÷ blended price', cells: mk('high', (s) => ({ num: s.value, main: fmtValue(s.value), sub: s.value ? 'score pts' : (s.free ? 'free — excluded from value' : null) })) },
    ],
  });

  groups.push({
    label: `Scores · ${benchmarks.value.length} leaderboards`,
    rows: benchmarks.value.map(b => ({
      key: 'b:' + b,
      label: SHORT[b] || b,
      hint: isCore(b) ? 'core' : 'context only',
      core: isCore(b),
      // stats-58: an empty cell of a source-archived model carries the
      // verified archived-page link (same archiveLinkFor rule as PivotTable:
      // AA cells only, URL HTTP-verified at scrape time). Any other gap
      // keeps the plain dash.
      cells: mk('high', (s) => {
        const v = s.row[b] ?? null;
        return {
          num: v, main: fmtScore(v), color: scoreColor(v), bar: v,
          arch: v === null ? archiveLinkFor(s.row, b) : null,
        };
      }, true),
    })),
  });

  // stats-92: creator-reported benchmarks — the vendor lane joins Side by
  // side in its OWN group below the measured scores (never mixed with the
  // measured columns). Rows exist only for benchmarks the selected models
  // actually report; cells carry the qualifier (in-house = the creator's
  // own harness, cited = quoted from a third-party report). No teal, no
  // blending: self-reported numbers are claims, not measured results.
  const vendorGroups = vendorCompareGroups(S.map(s => s.row), vendorScoresFor);
  if (vendorGroups.length) {
    groups.push({
      label: 'Creator-reported benchmarks',
      hint: 'self-reported by the creators — not measured by us',
      rows: vendorGroups.map(g => ({
        key: 'v:' + g.benchmark,
        label: g.benchmark,
        hint: g.models > 1 ? `reported by ${g.models} of the selected models` : 'reported by 1 selected model',
        cells: dash((s) => {
          const e = g.entries.find(x => x.model === s.row.name);
          if (!e) return { main: '—' };
          return { num: e.score, main: fmtScore(e.score), color: scoreColor(e.score), bar: e.score, sub: e.qualifier };
        }),
      })),
    });
  }

  return groups;
});

const hasVendorRows = computed(() =>
  vendorCompareGroups(compareRows.value, vendorScoresFor).length > 0);

const orUrl = (orId) => 'https://openrouter.ai/' + orId;
</script>

<template>
  <section>
    <div class="page-head">
      <div class="kicker">Benchmark cockpit · snapshot {{ stats.lastUpdated }}</div>
      <h1 class="section-title">Side by side</h1>
      <p class="section-sub">
        Head-to-head spec sheet and score matrix for up to {{ MAX }} models.
        Metadata is from the OpenRouter catalog; benchmark rows highlight the best score.
      </p>
    </div>

    <!-- ── Empty state ──────────────────────────────────────────────── -->
    <div v-if="!sel.length" class="panel-lab" style="padding:1.6rem">
      <h3 style="margin:0 0 .3rem">Pick models to compare</h3>
      <p style="color:var(--muted);font-size:.92rem">
        Search below, tick checkboxes on the leaderboard, or start from a preset.
      </p>
      <div class="row mt">
        <b-field style="min-width:280px;flex:1;max-width:420px">
          <b-autocomplete
            v-model="addQ"
            :data="addOptions"
            field="name"
            icon="plus"
            clearable
            open-on-focus
            placeholder="Search a model — e.g. Kimi, GPT, GLM…"
            @select="addModel"
          >
            <template #default="{ option }">
              <div class="model-cell" style="padding:.2rem 0">
                <span class="av" :style="{ background: providerColor(option.name).color }">{{ initials(option.name) }}</span>
                <div>
                  <div class="has-text-weight-semibold" style="font-size:.9rem">{{ option.name }}</div>
                  <div class="cell-sub">{{ providerColor(option.name).name }} · {{ optionSub(option) }}</div>
                </div>
              </div>
            </template>
            <template #empty>No model matches that search.</template>
          </b-autocomplete>
        </b-field>
      </div>
      <div class="row mt">
        <button v-for="p in presets" :key="p.label" class="chip" @click="loadPreset(p.rows)">
          <i class="fas" :class="'fa-' + p.icon"></i>&nbsp;{{ p.label }}
        </button>
      </div>
    </div>

    <!-- ── Toolbar ──────────────────────────────────────────────────── -->
    <div v-else class="panel-lab cmp-toolbar" style="padding:.9rem 1rem">
      <b-field class="mb-0" style="min-width:240px;flex:1;max-width:380px">
        <b-autocomplete
          v-model="addQ"
          :data="addOptions"
          field="name"
          icon="plus"
          clearable
          :placeholder="atCap ? `Cap reached — remove one first` : 'Add another model…'"
          :disabled="atCap"
          @select="addModel"
        >
          <template #default="{ option }">
            <div class="model-cell" style="padding:.2rem 0">
              <span class="av" :style="{ background: providerColor(option.name).color }">{{ initials(option.name) }}</span>
              <div>
                <div class="has-text-weight-semibold" style="font-size:.9rem">{{ option.name }}</div>
                <div class="cell-sub">{{ providerColor(option.name).name }} · {{ optionSub(option) }}</div>
              </div>
            </div>
          </template>
        </b-autocomplete>
      </b-field>
      <div class="row" style="gap:.5rem">
        <b-tag type="is-warning" rounded>{{ sel.length }}/{{ MAX }}</b-tag>
        <b-button size="is-small" icon-left="link" @click="copyLink">{{ copied ? 'Copied!' : 'Copy link' }}</b-button>
        <b-button size="is-small" icon-left="xmark" @click="clearAll">Clear all</b-button>
      </div>
    </div>

    <!-- ── Comparison grid ──────────────────────────────────────────── -->
    <div v-if="sel.length" class="panel-lab mt" style="padding:0;overflow:hidden">
      <div class="cmp-scroll">
        <div class="cmp-grid" :style="{ gridTemplateColumns: gridCols }">
          <!-- Column heads -->
          <div class="cmp-corner">
            <span class="lbl">Model</span>
            <span class="cmp-hint">{{ metaCoverage.withMeta }}/{{ metaCoverage.total }} have catalog metadata</span>
          </div>
          <div v-for="s in sel" :key="s.row.name" class="cmp-cell cmp-headcell">
            <div class="row" style="justify-content:space-between;align-items:flex-start;flex-wrap:nowrap">
              <span class="av" :style="{ background: providerColor(s.row.name).color }">{{ initials(s.row.name) }}</span>
              <!-- stats-26: Buefy tooltip (append-to-body — the grid scrolls) -->
              <b-tooltip label="Remove from comparison" type="is-dark" :delay="100" append-to-body>
                <button class="cmp-x" @click="removeModel(s.row.name)">
                  <i class="fas fa-xmark"></i>
                </button>
              </b-tooltip>
            </div>
            <router-link class="model-link has-text-weight-semibold" :to="{ name: 'model', params: { slug: modelSlug(s.row.name) } }">
              {{ s.row.name }}
            </router-link>
            <div class="cell-sub">{{ providerColor(s.row.name).name }}</div>
            <div class="row mt-sm" style="gap:.35rem">
              <span class="tag-lab" :class="s.tier === 'closed' ? 'rose' : 'teal'">{{ s.tier }}</span>
              <!-- stats-92: census columns say what they are, so the dash
                   Global Score below reads as honesty, not breakage -->
              <span v-if="s.census" class="tag-lab muted">{{ s.row.hf_only ? 'HF-only' : s.row.card ? 'OR-only' : 'unranked' }}</span>
              <span v-if="s.overallRank" class="tag-lab">#{{ s.overallRank }}</span>
              <span v-if="winCounts.get(s.row.name)" class="tag-lab gold">
                <i class="fas fa-crown"></i>&nbsp;{{ winCounts.get(s.row.name) }} wins
              </span>
            </div>
            <div class="num" :style="{ color: scoreColor(s.avg), fontWeight: 700 }">{{ fmtScore(s.avg) }}</div>
            <div class="bar"><i :style="{ width: barWidth(s.avg) }"></i></div>
          </div>

          <!-- Spec + score rows -->
          <template v-for="g in cmpGroups" :key="g.label">
            <div class="cmp-group">{{ g.label }}<span v-if="g.hint" class="cmp-hint" style="margin-left:.5rem">{{ g.hint }}</span></div>
            <template v-for="r in g.rows" :key="r.key">
              <div class="cmp-label">
                <span>{{ r.label }}</span>
                <span v-if="r.hint" class="cmp-hint">{{ r.hint }}</span>
              </div>
              <div v-for="(c, i) in r.cells" :key="r.key + i" class="cmp-cell" :class="{ 'winner-cell': c.winner }">
                <span v-if="c.tag" class="tag-lab" :class="c.tag">{{ c.main }}</span>
                <div v-else-if="c.chips && c.chips.length" class="chips">
                  <template v-for="(ch, j) in c.chips" :key="j">
                    <i v-if="ch.arrow" class="fas fa-arrow-right cmp-arrow"></i>
                    <span v-else class="tag-lab"><i class="fas" :class="'fa-' + ch.icon"></i>&nbsp;{{ ch.label }}</span>
                  </template>
                </div>
                <a v-else-if="c.href" class="cmp-link mono" :href="c.href" target="_blank" rel="noopener">{{ c.main }} <i class="fas fa-arrow-up-right-from-square"></i></a>
                <template v-else>
                  <span class="cmp-main" :class="{ num: c.bar !== null && c.bar !== undefined }" :style="c.color ? { color: c.color } : null">{{ c.main }}<b-tooltip v-if="c.arch" :label="archTip" type="is-dark" multilined :delay="100" append-to-body><a class="arch-link" :href="c.arch" target="_blank" rel="noopener noreferrer" :aria-label="archTip" style="margin-left:.3rem" @click.stop><i class="fas fa-arrow-up-right-from-square"></i></a></b-tooltip></span>
                  <div v-if="c.bar !== null && c.bar !== undefined" class="bar cmp-bar"><i :style="{ width: barWidth(c.bar) }"></i></div>
                </template>
                <span v-if="c.sub" class="cmp-sub">{{ c.sub }}</span>
              </div>
            </template>
          </template>
        </div>
      </div>
    </div>

    <!-- Footnotes -->
    <div v-if="sel.length" class="row mt-sm" style="gap:.4rem;flex-direction:column;align-items:flex-start">
      <p v-if="hasVendorRows" class="cell-sub">
        <b>Creator-reported benchmarks</b> are claims from the model creators — self-reported, <b>not measured by us</b>. Qualifier per cell: <i>in-house</i> = the creator's own harness, <i>cited</i> = quoted from a third-party report. They never feed the Score or ranks.
      </p>
      <p class="cell-sub">
        Teal = best of the selection for that row (prices: cheapest wins; census rows carry no rating, so they never take a win).
        <router-link class="meth-link" :to="{ name: 'methodology', query: { s: 'money' } }">How prices are blended<i class="fas fa-arrow-up-right-from-square"></i></router-link>
      </p>
    </div>
  </section>
</template>
