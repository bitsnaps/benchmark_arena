<script setup>
// ── Value map (stats-31) ─────────────────────────────────────────────────
// Ibrahim: "what Chart can we implement to help users find the best LLM
// for budget, maybe something like 'Quality per dollar' in an interactive
// scatter plot … blended price on Y axis and Our score on X axis … let
// the user change the variables … I'd prefer svg … minimal dependency …
// use our previous calculated data".
//
// Delivered: a dedicated /#/value route with a hand-rolled SVG scatter
// (zero chart libraries, one small pure core in lib/scatter.js). The plot
// reads EVERY number through the shared store accessors the leaderboard
// already uses — scoreForModel (Our Score), priceFor (3:1 blend, AA list
// first), valueFor, metaFor (TTFT / context) — so the chart can never
// drift from the table math and nothing is recalculated here.
//
// Interaction: hover = detail tooltip; click = model card; X/Y axis
// selects + per-axis log/linear toggles; Pareto "frontier" switch (the
// best-quality-per-dollar answer); tier tabs; older-versions toggle.
// Every control mirrors into the URL (?x/?y/?sx/?sy/?tier/?older/?frontier)
// so views are shareable, same discipline as ?tier=/?avg= on the leaderboard.

import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { TIERS } from '../lib/constants.js';
import { slugify, fmtScore, fmtUsd, fmtSec, fmtCtx, fmtValue, providerColor } from '../lib/format.js';
import { isNewModel } from '../lib/newFlag.js';
import {
  AXES, X_AXIS_IDS, Y_AXIS_IDS, axisOptions,
  buildScatterPoints, makeScale, valueFrontier, frontierPath,
} from '../lib/scatter.js';
import { useData } from '../stores/data.js';

const route = useRoute();
const router = useRouter();
const { pivotFor, scoreForModel, clForModel, priceFor, valueFor, metaFor, isOlder, releaseDateOf, sellerCountFor } = useData();

const xOptions = axisOptions(X_AXIS_IDS);
const yOptions = axisOptions(Y_AXIS_IDS);

// ── Controls ⇄ URL (shareable views) ─────────────────────────────────────
const xId = ref(X_AXIS_IDS.includes(route.query.x) ? route.query.x : 'score');
const yId = ref(Y_AXIS_IDS.includes(route.query.y) ? route.query.y : 'blend');
// scale overrides — null means "follow the metric's default scale"
const xScaleOv = ref(['log', 'lin'].includes(route.query.sx) ? route.query.sx : null);
const yScaleOv = ref(['log', 'lin'].includes(route.query.sy) ? route.query.sy : null);
const showOlder = ref(route.query.older === '1');
const frontierOn = ref(route.query.frontier !== '0'); // on by default

watch(xId, (v) => { xScaleOv.value = null; router.replace({ query: { ...route.query, x: v === 'score' ? undefined : v, sx: undefined } }); });
watch(yId, (v) => { yScaleOv.value = null; router.replace({ query: { ...route.query, y: v === 'blend' ? undefined : v, sy: undefined } }); });
watch(xScaleOv, (s) => { if (s !== null) router.replace({ query: { ...route.query, sx: s } }); });
watch(yScaleOv, (s) => { if (s !== null) router.replace({ query: { ...route.query, sy: s } }); });
watch(showOlder, (on) => router.replace({ query: { ...route.query, older: on ? '1' : undefined } }));
watch(frontierOn, (on) => router.replace({ query: { ...route.query, frontier: on ? undefined : '0' } }));

// Back/forward + pasted links win over local state (guarded — no loops)
watch(() => route.query, (q) => {
  const nx = X_AXIS_IDS.includes(q.x) ? q.x : 'score';
  const ny = Y_AXIS_IDS.includes(q.y) ? q.y : 'blend';
  const nsx = ['log', 'lin'].includes(q.sx) ? q.sx : null;
  const nsy = ['log', 'lin'].includes(q.sy) ? q.sy : null;
  const nolder = q.older === '1';
  const nfrontier = q.frontier !== '0';
  if (nx !== xId.value) xId.value = nx;
  if (ny !== yId.value) yId.value = ny;
  if (nsx !== xScaleOv.value) xScaleOv.value = nsx;
  if (nsy !== yScaleOv.value) yScaleOv.value = nsy;
  if (nolder !== showOlder.value) showOlder.value = nolder;
  if (nfrontier !== frontierOn.value) frontierOn.value = nfrontier;
}, { immediate: true });

// Scale toggles: flip between the two options; null (default) counts as the metric's own
const effXScale = computed(() => xScaleOv.value ?? AXES[xId.value].scale);
const effYScale = computed(() => yScaleOv.value ?? AXES[yId.value].scale);
const toggleXScale = () => { xScaleOv.value = effXScale.value === 'log' ? 'lin' : 'log'; };
const toggleYScale = () => { yScaleOv.value = effYScale.value === 'log' ? 'lin' : 'log'; };

// ── Data → points (through the shared store accessors) ──────────────────
const api = {
  scoreFor: scoreForModel, clFor: clForModel, priceFor, valueFor, metaFor,
  isOlder, releaseOf: releaseDateOf,
  isNew: (created) => isNewModel(created),
  providerOf: (row) => providerColor(row.name),
};

const tier = computed(() => (TIERS.some(t => t.value === route.query.tier) ? route.query.tier : 'all'));
const tierTab = computed({
  get: () => tier.value,
  set: (v) => { if (v && v !== tier.value) router.replace({ query: { ...route.query, tier: v === 'all' ? undefined : v } }); },
});

const built = computed(() =>
  buildScatterPoints(pivotFor(tier.value), xId.value, yId.value, api, {
    includeOlder: showOlder.value, xScale: effXScale.value, yScale: effYScale.value,
  }));

const mx = computed(() => AXES[xId.value]);
const my = computed(() => AXES[yId.value]);

// ── Scales / geometry ────────────────────────────────────────────────────
const X = computed(() => {
  const vs = built.value.points.map(p => p.x);
  return vs.length ? makeScale(mx.value, Math.min(...vs), Math.max(...vs), effXScale.value) : null;
});
const Y = computed(() => {
  const vs = built.value.points.map(p => p.y);
  return vs.length ? makeScale(my.value, Math.min(...vs), Math.max(...vs), effYScale.value) : null;
});

const W = 960, H = 560;
const M = { t: 26, r: 30, b: 58, l: 78 };
const plotW = W - M.l - M.r;
const plotH = H - M.t - M.b;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const px = (v) => M.l + clamp01(X.value.frac(v)) * plotW;
const py = (v) => M.t + (1 - clamp01(Y.value.frac(v))) * plotH;

// ── Pareto frontier ──────────────────────────────────────────────────────
const frontierPts = computed(() =>
  frontierOn.value && built.value.points.length >= 2
    ? valueFrontier(built.value.points, mx.value.better, my.value.better)
    : []);
const frontierD = computed(() => {
  const fp = frontierPts.value;
  if (fp.length < 2) return '';
  return frontierPath(fp)
    .map((p, i) => (i ? 'L' : 'M') + px(p.x).toFixed(1) + ' ' + py(p.y).toFixed(1))
    .join(' ');
});

// ── Hover tooltip ────────────────────────────────────────────────────────
const hover = ref(null);
const tipStyle = computed(() => {
  if (!hover.value || !X.value || !Y.value) return {};
  const fx = (px(hover.value.x) / W) * 100;
  const fy = (py(hover.value.y) / H) * 100;
  const left = Math.min(86, Math.max(14, fx));
  const below = fy < 28; // near the top edge → flip under the point
  return {
    left: left + '%',
    top: (below ? Math.min(97, fy + 3) : fy) + '%',
    transform: below ? 'translate(-50%, 14px)' : 'translate(-50%, calc(-100% - 14px))',
  };
});
const tipRows = computed(() => {
  const p = hover.value;
  if (!p) return [];
  const out = [];
  const sc = scoreForModel(p.row);
  if (sc != null) out.push(['Score', fmtScore(sc) + ' · CL ' + Math.round(clForModel(p.row)) + '%']);
  const pr = priceFor(p.row);
  if (pr) {
    out.push(['Blended 3:1', fmtUsd(pr.blend) + '/1M · ' + (pr.source === 'aa' ? 'AA list' : 'OpenRouter')]);
    if (pr.input != null || pr.output != null) out.push(['In / Out', fmtUsd(pr.input) + ' / ' + fmtUsd(pr.output)]);
  }
  const v = valueFor(p.row);
  if (v != null) out.push(['Value', fmtValue(v) + ' pts / $1M']);
  const tt = metaFor(p.row)?.aa_ttft_seconds;
  if (tt != null) out.push(['AA TTFT', fmtSec(tt)]);
  const ctx = metaFor(p.row)?.context_length;
  if (ctx != null) out.push(['Context', fmtCtx(ctx) + ' tok']);
  const sellers = sellerCountFor(p.row);
  if (sellers) out.push(['Listed at', sellers + (sellers === 1 ? ' seller' : ' sellers')]);
  return out;
});

const go = (p) => router.push({ name: 'model', params: { slug: slugify(p.name) } });

// ── Legend + honesty notes ───────────────────────────────────────────────
const legend = computed(() => {
  const c = new Map();
  for (const p of built.value.points) {
    const k = p.provider?.name || 'Independent';
    const e = c.get(k) || { name: k, color: p.provider?.color || '#8b9bb8', n: 0 };
    e.n += 1;
    c.set(k, e);
  }
  return [...c.values()].sort((a, b) => b.n - a.n).slice(0, 12);
});
const currentCount = computed(() => pivotFor(tier.value).filter(r => !isOlder(r)).length);
const olderCount = computed(() => pivotFor(tier.value).filter(r => isOlder(r)).length);
const emptyState = computed(() => !built.value.points.length);
const frontierLabel = computed(() =>
  mx.value.better === 'high' && my.value.better === 'low' ? 'higher Score, lower price'
    : mx.value.better === 'low' && my.value.better === 'high' ? 'better on both axes'
      : 'better on both axes');
const aria = computed(() =>
  `Scatter plot of ${my.value.title} versus ${mx.value.title} for ${built.value.points.length} models`);
</script>

<template>
  <section>
    <div class="page-head">
      <div class="kicker">Quality per dollar · interactive</div>
      <h1 class="section-title">Value map</h1>
      <p class="section-sub">
        Plot what you get against what you pay. Hover a dot for the full picture, swap the axes for a
        different angle, and follow the teal frontier — the models nothing else beats on both axes at once.
        Click any dot for its score card.
      </p>
    </div>

    <!-- Controls -->
    <div class="panel-lab vm-controls">
      <div class="vm-row">
        <div class="vm-pick">
          <span class="vm-lab">X axis</span>
          <b-select v-model="xId" size="is-small" aria-label="X axis metric">
            <option v-for="o in xOptions" :key="o.id" :value="o.id">{{ o.label }}</option>
          </b-select>
          <button class="chip" type="button" :aria-label="'Toggle X axis scale (currently ' + (effXScale === 'log' ? 'logarithmic' : 'linear') + ')'" @click="toggleXScale">
            {{ effXScale === 'log' ? 'log' : 'linear' }}
          </button>
        </div>
        <div class="vm-pick">
          <span class="vm-lab">Y axis</span>
          <b-select v-model="yId" size="is-small" aria-label="Y axis metric">
            <option v-for="o in yOptions" :key="o.id" :value="o.id">{{ o.label }}</option>
          </b-select>
          <button class="chip" type="button" :aria-label="'Toggle Y axis scale (currently ' + (effYScale === 'log' ? 'logarithmic' : 'linear') + ')'" @click="toggleYScale">
            {{ effYScale === 'log' ? 'log' : 'linear' }}
          </button>
        </div>

        <!-- stats-26 pattern: control hints as Buefy tooltips -->
        <b-tooltip label="Highlight the Pareto frontier — models no other model beats on both axes at once. The best quality-per-dollar pick lives on this line." type="is-dark" multilined :delay="100">
          <b-switch v-model="frontierOn" size="is-small" type="is-success" left-label>
            Frontier
            <b-tag v-if="frontierPts.length" size="is-small" type="is-success is-light" rounded>{{ frontierPts.length }}</b-tag>
          </b-switch>
        </b-tooltip>
        <b-tooltip label="Superseded versions and stale generations hide by default — exactly like the leaderboard." type="is-dark" multilined :delay="100">
          <b-switch v-model="showOlder" size="is-small" type="is-warning" left-label>
            Older
            <b-tag size="is-small" type="is-warning is-light" rounded>{{ olderCount }}</b-tag>
          </b-switch>
        </b-tooltip>
      </div>
      <b-tabs v-model="tierTab" type="is-toggle" size="is-small" multiline class="tier-tabs">
        <b-tab-item v-for="t in TIERS" :key="t.value" :value="t.value" :label="t.label" :icon="t.icon" />
      </b-tabs>
    </div>

    <!-- Chart -->
    <div class="panel-lab vm-wrap">
      <div v-if="emptyState" class="vm-empty">
        No model has both a usable <b>{{ mx.label.toLowerCase() }}</b> and <b>{{ my.label.toLowerCase() }}</b> on record for this
        tier — nothing to plot. Swap an axis, switch the tier tab, or include older versions.
      </div>
      <svg v-else class="value-map" viewBox="0 0 960 560" role="img" :aria-label="aria" @mouseleave="hover = null">
        <!-- grid -->
        <line v-for="t in X.ticks" :key="'gx' + t.v" class="vgrid" :x1="px(t.v)" :x2="px(t.v)" :y1="M.t" :y2="M.t + plotH" />
        <line v-for="t in Y.ticks" :key="'gy' + t.v" class="vgrid" :x1="M.l" :x2="M.l + plotW" :y1="py(t.v)" :y2="py(t.v)" />
        <!-- axis lines -->
        <line class="vaxl" :x1="M.l" :x2="M.l + plotW" :y1="M.t + plotH" :y2="M.t + plotH" />
        <line class="vaxl" :x1="M.l" :x2="M.l" :y1="M.t" :y2="M.t + plotH" />
        <!-- tick labels -->
        <text v-for="t in X.ticks" :key="'tx' + t.v" class="vtick" :x="px(t.v)" :y="M.t + plotH + 19" text-anchor="middle">{{ t.label }}</text>
        <text v-for="t in Y.ticks" :key="'ty' + t.v" class="vtick" :x="M.l - 8" :y="py(t.v) + 3.5" text-anchor="end">{{ t.label }}</text>
        <!-- axis titles -->
        <text class="vaxtitle" :x="M.l + plotW / 2" :y="H - 10" text-anchor="middle">{{ mx.title }}</text>
        <text class="vaxtitle" :transform="'rotate(-90 16 ' + (M.t + plotH / 2) + ')'" :x="16" :y="M.t + plotH / 2" text-anchor="middle">{{ my.title }}</text>

        <!-- Pareto frontier: dashed guide + teal halo on its members -->
        <path v-if="frontierD" class="vfrontier" :d="frontierD" />
        <circle v-for="p in frontierPts" :key="'h' + p.name" class="vhalo" :cx="px(p.x)" :cy="py(p.y)" r="9" />

        <!-- points: color = vendor; gold ring = NEW; hollow = older -->
        <circle
          v-for="p in built.points"
          :key="p.name"
          class="vpt"
          :class="{ old: p.older, newm: p.isNew }"
          :data-name="p.name"
          :cx="px(p.x)"
          :cy="py(p.y)"
          :r="hover && hover.name === p.name ? 7.5 : 5"
          :fill="p.provider?.color || '#8b9bb8'"
          :stroke="p.isNew ? 'var(--gold)' : (p.older ? (p.provider?.color || '#8b9bb8') : 'none')"
          @mouseenter="hover = p"
          @click="go(p)"
        />
      </svg>

      <!-- Hover tooltip (percentage-positioned — no measuring, scales with the SVG) -->
      <div v-if="hover" class="vtip" :style="tipStyle">
        <div class="vt-head">
          <span class="vt-name">{{ hover.name }}</span>
          <span v-if="hover.isNew" class="vnew-chip">NEW</span>
          <span v-if="hover.older" class="vold-chip">older</span>
        </div>
        <div class="vt-sub">
          {{ hover.provider?.name || 'Independent' }}<template v-if="hover.created"> · released {{ hover.created }}</template>
        </div>
        <div v-for="r in tipRows" :key="r[0]" class="vt-row"><span>{{ r[0] }}</span><b>{{ r[1] }}</b></div>
        <div class="vt-hint">click the dot for the full score card</div>
      </div>
    </div>

    <!-- Frontier picks (mobile-friendly fallback for the hover tooltip) -->
    <div v-if="frontierPts.length" class="vm-frontier">
      <span class="vm-lab">Frontier picks</span>
      <button v-for="p in frontierPath(frontierPts)" :key="p.name" class="chip" type="button" @click="go(p)">
        {{ p.name }}
      </button>
    </div>

    <!-- Legend + honesty note -->
    <div class="vm-legend">
      <span v-for="l in legend" :key="l.name" class="vm-lg"><i :style="{ background: l.color }"></i>{{ l.name }}</span>
    </div>
    <p class="cell-sub" style="text-align:center">
      Plotted {{ built.points.length }} of {{ currentCount }} current-generation models ({{ tier }} tier):
      {{ built.hidden.x }} lack a usable {{ mx.label.toLowerCase() }} and {{ built.hidden.y }} more lack a usable
      {{ my.label.toLowerCase() }} — excluded rather than fabricated; {{ olderCount }} older versions hide behind the
      Older toggle. Dot color = vendor · gold ring = NEW (the shared New-badge window) · hollow = older version ·
      teal halo = frontier. Price axes default to log scale because $0.10 → $300 spans three decades.
      Numbers come from the same store the leaderboard uses — nothing is recalculated here.
    </p>

    <!-- Methodology -->
    <div class="grid-2 mt">
      <div class="panel-lab" style="padding:1.2rem">
        <h3 style="margin:0 0 .4rem">Reading the map</h3>
        <p style="color:var(--muted);font-size:.92rem">
          The default view is the budget question itself: Our Score on X (CL-weighted quality) versus the blended
          API price on Y (3:1 input:output, USD per 1M tokens). Dots toward the top-left deliver the most quality
          per dollar — the dashed teal frontier connects the models no other model beats on both axes at once, so
          the best pick for any budget is always ON that line, never below it. A dot above the line means
          someone cheaper scores equal or better; a dot right of it means someone equal or better costs less.
          Flip the frontier pair for other questions — Score vs AA TTFT finds the fastest thinking per second
          of latency, Score vs Age shows this month's fresh blood, Value vs Context stretches a context budget.
        </p>
      </div>
      <div class="panel-lab" style="padding:1.2rem">
        <h3 style="margin:0 0 .4rem">Where the numbers come from</h3>
        <p style="color:var(--muted);font-size:.92rem">
          Nothing on this page is recomputed: Score follows the leaderboard's CL-weighted formula (and the
          Avg-set dropdown on the Leaderboard page — swap the eval mix there and this map re-renders), prices
          reuse the Price column's source ladder (the lab's own AA list price first, the OpenRouter snapshot as
          fallback) and Value reuses Score ÷ blended $. Honest gaps stay honest: a model missing either axis
          value is excluded and counted below the chart, never fabricated; a rate-limited free listing is not
          "$0 to run", so free tiers don't pretend to be free on price axes; older generations hide by default.
          Every control mirrors into the URL — copy the address bar to share the exact view.
        </p>
      </div>
    </div>
  </section>
</template>
