<script setup>
// Model detail — full score card for one model: ranks, Avg, coverage,
// per-benchmark bars with rank-in-benchmark, and a compare shortcut.
import { computed, watchEffect } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { SHORT, BASE_TITLE } from '../lib/constants.js';
import { fmtScore, fmtUsd, fmtValue, fmtCtx, fmtSec, scoreColor, barWidth, rankClass, providerColor, initials, slugify, modalityIcon } from '../lib/format.js';
import { latencyClass } from '../lib/pivot.js';
import { isNewModel, newBadgeTitle } from '../lib/newFlag.js';
import { GRADE_UNRATED, gradeTitle } from '../lib/tiers.js';
import { elsewhereFor } from '../lib/measuredElsewhere.js';
import { useData } from '../stores/data.js';
import { useLeaderboard } from '../stores/leaderboard.js';

const route = useRoute();
const router = useRouter();

const { benchmarks, benchRankIndex, modelSlugIndex, modelSlug, avgForModel, scoreForModel, clForModel, rankMaps, rankOf, tierOf, isCore, stats, supersededBy, releaseDateOf, metaFor, priceFor, valueFor, hfIdFor, hfUrlFor, availableAtFor, archiveLinkFor, tiersMode, gradeFor, gradeBoundsOverall, vendorScoresFor } = useData();
const { compareMode, compareRows } = useLeaderboard();

// stats-49: the archived-page icon is wordless — this tooltip + the link's
// aria-label are where the explanation lives (same wording as PivotTable)
const archTip = 'No current AA leaderboard entry — the model was archived by the source; its own page still carries score, pricing and latency';

const model = computed(() => modelSlugIndex.value.get(route.params.slug) || null);

watchEffect(() => {
  document.title = model.value ? `${model.value.name} · Benchmark Arena` : BASE_TITLE;
});

const provider = computed(() => model.value ? providerColor(model.value.name) : null);
const tier = computed(() => model.value ? tierOf(model.value) : null);
const avg = computed(() => model.value ? avgForModel(model.value) : null);
// CL-weighted global score — same metric the leaderboard ranks by
const wscore = computed(() => model.value ? scoreForModel(model.value) : null);
// Coverage against the current avg-set selection (not the baked 8-core CL)
const cl = computed(() => model.value ? clForModel(model.value) : 0);

// stats-60: the model card carries the same grade as the leaderboard chips
// (one shared mode + map). In per-axis mode the card badge is labeled Q —
// the card's other axes (Value/Speed) already have their own dedicated
// stat tiles, so a duplicate chip would be noise.
const gradeLetter = computed(() => (model.value ? gradeFor(model.value) : null));
const isAxisMode = computed(() => tiersMode.value === 'axis');
const gradeTip = computed(() =>
  gradeTitle(gradeLetter.value ?? GRADE_UNRATED, gradeBoundsOverall.value));

// Scored / missing benchmarks
const scored = computed(() => !model.value ? [] : benchmarks.value
  .map(b => {
    const info = benchRankIndex.value[b] || { ranks: new Map(), count: 0, best: null };
    return { bench: b, score: model.value[b] ?? null, rank: info.ranks.get(model.value.name), count: info.count, best: info.best };
  })
  .filter(s => s.score !== null && s.score !== undefined));
const missing = computed(() => !model.value ? [] : benchmarks.value
  .filter(b => model.value[b] === null || model.value[b] === undefined));

const covered = computed(() => scored.value.length);
const wins = computed(() => scored.value.filter(s => s.rank === 1).length);
const best = computed(() => scored.value.slice().sort((a, b) => b.score - a.score)[0] || null);

const overallRank = computed(() => (model.value ? rankMaps.value.all.get(model.value.name) : null));
const tierRank = computed(() => (model.value && tier.value ? rankMaps.value[tier.value].get(model.value.name) : null));

// Freshness: superseded models carry a banner pointing at their successor;
// release date comes from the OpenRouter catalog snapshot (models_meta.created)
const successor = computed(() => (model.value ? supersededBy(model.value) : null));
// stale generations (no successor, 9+ months old) need the banner too —
// stats-61: BenchLM re-admitted several such rows and the leak-guard e2e
// deep-link check requires every older model page to be marked.
const staleFlag = computed(() => (model.value ? !!metaFor(model.value)?.stale : false));

// stats-82: ECI info for the dedicated panel — raw index + 90% CI + vintage
// (models_meta.eci_ci / eci_vintage, attached by the scraper post-build)
const eciInfo = computed(() => {
  if (!model.value) return null;
  const v = model.value['Epoch ECI'];
  if (v === null || v === undefined) return null;
  const m = metaFor(model.value) || {};
  const ci = Array.isArray(m.eci_ci) ? m.eci_ci : null;
  return {
    eci: v,
    ci,
    vintage: m.eci_vintage || null,
    tip: `90% credible interval ${ci ? ci[0] + '–' + ci[1] : 'n/a'}${m.eci_vintage ? ' · Epoch fit ' + m.eci_vintage : ''}`,
  };
});
const released = computed(() => (model.value ? releaseDateOf(model.value) : null));
// ★ footnote: a source site lists this model under a different name (alias_note)
const aliasNote = computed(() => (model.value ? metaFor(model.value)?.alias_note || null : null));
// stats-27: NEW badge — released within the user-adjustable window (shared
// lib/newFlag.js singleton); the Released tag beside it keeps the exact date.
const isNew = computed(() => (model.value ? isNewModel(released.value) : false));

// API pricing (price layer) — the stats-19 ladder, extended stats-59:
// AA list price → OpenRouter snapshot → cheapest seller listing → free
// listing as $0. Source surfaces in the panel label so the number is never
// misattributed.
const pricing = computed(() => (model.value ? priceFor(model.value) : null));
const PRICE_SOURCE_LABEL = {
  aa: 'Artificial Analysis list price · no routing margin',
  openrouter: 'OpenRouter list price',
  seller: 'Cheapest seller list price',
  free: 'Free listing · rate limits apply',
};
const PRICE_SOURCE_NOTE = {
  aa: 'Artificial Analysis list price — the lab\u2019s own, without a router\u2019s margin.',
  openrouter: 'Router list price for this exact row.',
  seller: 'Cheapest seller listing — shown because no AA/OpenRouter list price is on record for this row.',
  free: 'This model has a free listing — shown as $0. Free tiers are rate-limited, not unlimited.',
};
const modelCtx = computed(() => (model.value ? metaFor(model.value)?.context_length || null : null));
// stats-19: the raw API id (org/model) — the card is where the short format
// lives now; listings present only the full name.
const orId = computed(() => (model.value ? metaFor(model.value)?.or_id || null : null));
// Value lens — Score per 1M blended tokens (same number the Value column sorts by)
const value = computed(() => (model.value ? valueFor(model.value) : null));
// stats-24: AA median time-to-first-token (seconds, models_meta.aa_ttft_seconds)
// — the same source that tints Compare pivot cells; null when unmeasured.
const ttft = computed(() => (model.value ? metaFor(model.value)?.aa_ttft_seconds ?? null : null));
// Hugging Face repo — open-weight models only (null for closed / unverified)
const hfId = computed(() => (model.value ? hfIdFor(model.value) : null));
const hfUrl = computed(() => (model.value ? hfUrlFor(model.value) : null));

// ── stats-34: modality chips (input always when known; output only when
// it goes beyond plain text — a text-only output row would be pure noise).
// Provenance is surfaced on the row label: every number traceable to its
// source, same ethos as the pricing layers.
const inputMods = computed(() => (model.value ? metaFor(model.value)?.input_modalities || [] : []));
const outputMods = computed(() => (model.value ? metaFor(model.value)?.output_modalities || [] : []));
const outputExtra = computed(() => outputMods.value.filter(m => m !== 'text'));
const MOD_SOURCE_LABEL = {
  openrouter: 'OpenRouter catalog (router-reported architecture)',
  huggingface: 'Hugging Face model tags',
  artificialanalysis: 'Artificial Analysis model page (vendor spec)',
  curated: 'curated from vendor documentation',
};
const modSourceLabel = computed(() => {
  const src = model.value ? metaFor(model.value)?.modalities_source : null;
  return 'Modality data: ' + (MOD_SOURCE_LABEL[src] || 'unknown source');
});

// ── Available at (stats-18 cross-seller view) ────────────────────────────
// Every seller whose catalog lists this model, with its own list price and
// free-listing flags, exactly as baked in models_meta.available_at. OpenRouter
// first (the reference router), then alphabetical — the scraper ordered them.
const availability = computed(() => (model.value ? availableAtFor(model.value) : []));
const freeSellers = computed(() => availability.value.filter(a => a.free));
const FREE_CAVEAT = 'Free tier — rate limits apply, not unlimited';
const availPrice = (a) => {
  if (typeof a.in !== 'number') return null;
  return `${fmtUsd(a.in)} / ${typeof a.out === 'number' ? fmtUsd(a.out) : '—'}`;
};

// Compare shortcut
const inCompare = computed(() => !!model.value && compareRows.value.some(r => r.name === model.value.name));
const compareFull = computed(() => compareRows.value.length >= 5 && !inCompare.value);

// ── stats-91: creator-reported benchmarks (the vendor lane) ─────────────
// Scores the model's creator published on the HF card / structured eval
// files — display-only, never blended into the Score. qualifier:
//   in-house  = measured by the creator's own harness
//   cited     = the creator's card cites a third-party report (footnote *)
//   reported  = HF's structured eval system (.eval_results / model-index)
const vendorScores = computed(() => (model.value ? vendorScoresFor(model.value) : []));
const vendorUrl = computed(() => model.value?.vendor_source_url || hfUrl.value || null);
const VENDOR_NOTE = {
  'in-house': 'measured by the creator\u2019s own harness',
  cited: 'cited by the creator from a third-party report',
  reported: 'filed in the HF structured eval system',
};

// stats-93: boards that list this model elsewhere (GDPx / RLI) — links only,
// never scores; see src/lib/measuredElsewhere.js for the contract
const elsewhere = computed(() => (model.value ? elsewhereFor(model.value.name) : []));

function addToCompare() {
  if (!model.value || inCompare.value || compareFull.value) return;
  compareRows.value.push(model.value);
  compareMode.value = true;
  router.push({ name: 'compare' });
}
</script>

<template>
  <section v-if="model">
    <div class="crumbs">
      <router-link class="crumb" :to="{ name: 'home' }"><i class="fas fa-arrow-left"></i> Leaderboard</router-link>
      <span class="crumb-sep">/</span>
      <span class="crumb current">{{ model.name }}</span>
    </div>

    <!-- Header card -->
    <div class="panel-lab model-head">
      <span class="av lg" :style="{ background: provider.color }">{{ initials(model.name) }}</span>
      <div class="grow">
        <h1 class="section-title" style="margin:0">{{ model.name }}</h1>
        <!-- stats-26: Buefy tooltip on the raw API id -->
        <b-tooltip v-if="orId" label="Raw API id — the short format behind the full name shown in listings"
          type="is-dark" :delay="100">
          <div class="cell-sub prov-id" style="margin-top:.15rem">API id: {{ orId }}</div>
        </b-tooltip>
        <div class="row mt-sm" style="gap:.4rem">
          <span class="tag-lab">{{ provider.name }}</span>
          <span class="tag-lab" :class="tier === 'closed' ? 'rose' : 'teal'">{{ tier === 'closed' ? 'Closed-source' : 'Open-weight' }}</span>
          <!-- stats-27: NEW badge (window-flagged); the exact date stays on the Released tag -->
          <b-tooltip v-if="isNew" :label="newBadgeTitle(released)" type="is-dark" :delay="100">
            <span class="tag-lab new-tag">NEW</span>
          </b-tooltip>
          <span v-if="released" class="tag-lab">Released {{ released }}</span>
          <span v-if="overallRank" class="tag-lab gold">#{{ overallRank }} overall</span>
          <span v-if="tierRank" class="tag-lab">#{{ tierRank }} in {{ tier === 'closed' ? 'closed' : 'open' }}</span>
          <b-tooltip v-if="aliasNote" :label="aliasNote" type="is-dark" multilined :delay="100">
            <span class="tag-lab gold" style="cursor:help">★ aliased on source</span>
          </b-tooltip>
          <b-tooltip v-if="hfUrl" :label="'Open ' + hfId + ' on Hugging Face'" type="is-dark" :delay="100">
            <a class="tag-lab hf-link" :href="hfUrl" target="_blank" rel="noopener noreferrer">
              <i class="fas fa-cube" aria-hidden="true"></i>&nbsp;{{ hfId }}
            </a>
          </b-tooltip>
        </div>
        <!-- stats-34: modality chips with source provenance -->
        <div v-if="inputMods.length" class="row mt-sm" style="gap:.4rem;align-items:center;flex-wrap:wrap">
          <b-tooltip :label="modSourceLabel" type="is-dark" multilined :delay="100">
            <span class="cell-sub" style="cursor:help;white-space:nowrap"><i class="fas fa-circle-info"></i>&nbsp;Input</span>
          </b-tooltip>
          <span v-for="m in inputMods" :key="m" class="tag-lab"><i class="fas" :class="modalityIcon(m)" aria-hidden="true"></i>&nbsp;{{ m }}</span>
          <template v-if="outputExtra.length">
            <b-tooltip :label="modSourceLabel" type="is-dark" multilined :delay="100">
              <span class="cell-sub" style="cursor:help;white-space:nowrap"><i class="fas fa-circle-info"></i>&nbsp;Output</span>
            </b-tooltip>
            <span v-for="m in outputExtra" :key="'o-' + m" class="tag-lab teal"><i class="fas" :class="modalityIcon(m)" aria-hidden="true"></i>&nbsp;{{ m }}</span>
          </template>
        </div>
        <div v-else-if="model" class="row mt-sm">
          <span class="cell-sub">Input modalities unverified for this row yet</span>
        </div>
      </div>
      <div class="row" style="gap:.6rem">
        <b-button type="is-primary" size="is-small" icon-left="code-compare"
          :disabled="compareFull" @click="addToCompare">
          {{ inCompare ? 'In compare (' + compareRows.length + '/5)' : 'Add to compare' }}
        </b-button>
      </div>
    </div>

    <!-- Freshness banner: superseded models point at their successor;
         stale generations (no successor, 9+ months old) get their own mark
         so an explicit deep link is always honest about freshness. -->
    <div v-if="successor || staleFlag" class="notice mt" style="border-color:var(--gold)">
      <i class="fas fa-clock-rotate-left"></i>
      <span v-if="successor">
        This model has been superseded by
        <router-link :to="{ name: 'model', params: { slug: modelSlug(successor) } }">{{ successor }}</router-link>
        — a newer release of the same product line. It is excluded from the default
        leaderboard ranking and shown only in the “Older versions” section.
      </span>
      <span v-else>
        This model is a stale generation — no successor was ever shipped, and it
        predates the newest releases in the snapshot. It is excluded from the default
        leaderboard ranking and shown only in the “Older versions” section.
      </span>
    </div>

    <!-- Stat tiles -->
    <div class="grid-4 mt">
      <div class="stat">
        <div class="lbl">Global Score
          <!-- stats-60: grade badge — same shared mode + letter as the
               leaderboard chips; Unrated when below the coverage gate -->
          <b-tooltip v-if="tiersMode !== 'off' && !gradeLetter" :label="gradeTip" type="is-dark" multilined :delay="100" append-to-body><span class="grade-chip grade-unrated" style="margin-left:.35rem">Unrated</span></b-tooltip>
          <b-tooltip v-else-if="tiersMode !== 'off' && isAxisMode" :label="gradeTip" type="is-dark" multilined :delay="100" append-to-body><span :class="['grade-chip', 'grade-' + gradeLetter.toLowerCase()]" style="margin-left:.35rem"><span class="grade-axis">Q</span>{{ gradeLetter }}</span></b-tooltip>
          <b-tooltip v-else-if="tiersMode !== 'off'" :label="gradeTip" type="is-dark" multilined :delay="100" append-to-body><span :class="['grade-chip', 'grade-' + gradeLetter.toLowerCase()]" style="margin-left:.35rem">{{ gradeLetter }}</span></b-tooltip>
        </div>
        <div class="val num" :style="{ color: scoreColor(wscore) }">{{ fmtScore(wscore) }}</div>
        <div class="sub">CL-weighted · raw avg {{ avg !== null && avg !== undefined ? fmtScore(avg) : '—' }}</div>
        <div class="bar mt-sm"><i :style="{ width: barWidth(wscore) }"></i></div>
      </div>
      <div class="stat">
        <div class="lbl">Coverage Level</div>
        <div class="val num">{{ Math.round(cl) + '%' }}</div>
        <div class="sub">of the {{ stats.coreBenchmarks }} benchmarks in the current avg set</div>
      </div>
      <div class="stat">
        <div class="lbl">Benchmarks scored</div>
        <div class="val num">{{ covered }}<span class="sub" style="font-size:1rem"> / {{ benchmarks.length }}</span></div>
        <div class="sub">missing evals count as neutral 50 in the Score — covered cells are re-scaled to the catalog first (stats-35)</div>
      </div>
      <div class="stat">
        <div class="lbl">Benchmark wins</div>
        <div class="val num" :style="{ color: wins ? 'var(--gold)' : 'var(--faint)' }">{{ wins }}</div>
        <div class="sub">{{ best ? 'best: ' + fmtScore(best.score) + ' on ' + (SHORT[best.bench] || best.bench) : '—' }}</div>
      </div>
    </div>

    <!-- stats-82: ECI — external composite (Epoch AI, CC-BY 4.0). Not a
         benchmark score: no bar, no rank — index value + 90% CI + vintage. -->
    <div v-if="eciInfo" class="panel-lab mt" style="padding:1.2rem">
      <div class="row" style="justify-content:space-between;margin-bottom:.6rem">
        <h3 style="margin:0;font-size:1.05rem">Epoch Capabilities Index</h3>
        <span class="cell-sub">Epoch AI · CC-BY 4.0</span>
      </div>
      <b-tooltip :label="eciInfo.tip" type="is-dark" multilined :delay="100" class="tt-block" style="width:100%">
        <div class="hbar" style="cursor:default">
          <div class="name"><i class="fas fa-gauge-high" style="margin-right:.5rem"></i>ECI <span class="cell-sub">(general capability index)</span></div>
          <div class="num" :style="{ fontWeight: 700 }">{{ Math.round(eciInfo.eci) }} <span v-if="eciInfo.ci" class="cell-sub" style="fontWeight:400">[{{ eciInfo.ci[0] }}–{{ eciInfo.ci[1] }}]</span></div>
        </div>
      </b-tooltip>
      <p class="cell-sub mt-sm">Latent capability index fitted across 50+ benchmarks by Epoch AI — an abstract scale, comparable between models only, never a 0-100 score. {{ eciInfo.vintage ? 'Fit vintage ' + eciInfo.vintage + '. ' : '' }}Excluded from our Score blend by design; the AA composite calibrates beside it.</p>
    </div>

    <!-- Per-benchmark bars -->
    <div class="panel-lab mt" style="padding:1.2rem">
      <div class="row" style="justify-content:space-between;margin-bottom:.6rem">
        <h3 style="margin:0;font-size:1.05rem">Scores across leaderboards</h3>
        <span class="cell-sub">rank badge = position among all {{ stats.closed + stats.open }} tracked models</span>
      </div>

      <!-- stats-26: row hover opens a Buefy tooltip; tt-block keeps the
           flex row full-width inside the inline-flex tooltip wrapper -->
      <b-tooltip
        v-for="s in scored"
        :key="s.bench"
        :label="'Open the ' + s.bench + ' explorer'"
        type="is-dark" :delay="100" class="tt-block"
      >
        <router-link
          class="hbar row-click"
          :to="{ name: 'benchmarks', params: { slug: slugify(s.bench) } }"
        >
        <div class="name">
          <span class="rank" :class="rankClass(s.rank)" v-if="s.rank" style="display:inline-grid;margin-right:.45rem">{{ s.rank }}</span>
          <span v-else class="rank" style="display:inline-grid;margin-right:.45rem">—</span>
          {{ SHORT[s.bench] || s.bench }}
          <span v-if="s.rank === 1" class="crown"><i class="fas fa-crown"></i> leads</span>
        </div>
        <div class="track"><i :style="{ width: barWidth(s.score), background: 'linear-gradient(90deg,#4f6dff,#2ee6c7)' }"></i></div>
        <div class="num" :style="{ color: scoreColor(s.score), fontWeight: s.rank === 1 ? 700 : 500 }">{{ fmtScore(s.score) }}</div>
        </router-link>
      </b-tooltip>

      <div v-for="b in missing" :key="b" class="hbar missing">
        <div class="name">
          <span class="rank" style="display:inline-grid;margin-right:.45rem">—</span>
          {{ SHORT[b] || b }}
          <!-- stats-49: verified archived-page link where the source still
               publishes the model on its own page — icon-only per Ibrahim,
               the tooltip + aria-label carry the words -->
          <b-tooltip v-if="archiveLinkFor(model, b)" :label="archTip" type="is-dark" multilined :delay="100" append-to-body>
            <a class="arch-link" :href="archiveLinkFor(model, b)" target="_blank" rel="noopener noreferrer" :aria-label="archTip"><i class="fas fa-arrow-up-right-from-square"></i></a>
          </b-tooltip>
        </div>
        <div class="track"></div>
        <div class="num cell-sub">—</div>
      </div>

      <p class="cell-sub mt-sm" v-if="missing.length">
        Not reported on: {{ missing.map(b => SHORT[b] || b).join(', ') }}.
      </p>
    </div>

    <!-- stats-91: creator-reported benchmarks — the vendor lane. Scores the
         model's creator published (card tables / HF structured evals);
         display-only, provenance per row, never blended into the Score. -->
    <div v-if="vendorScores.length" class="panel-lab mt" style="padding:1.2rem">
      <div class="row" style="justify-content:space-between;margin-bottom:.6rem">
        <h3 style="margin:0;font-size:1.05rem">Creator-reported benchmarks <span class="cell-sub">({{ vendorScores.length }})</span></h3>
        <a v-if="vendorUrl" class="cell-sub" :href="vendorUrl" target="_blank" rel="noopener noreferrer">view the model card <i class="fas fa-arrow-up-right-from-square"></i></a>
      </div>
      <div class="notice" style="margin:0 0 .7rem;border-color:var(--teal)">
        <i class="fas fa-circle-info"></i>
        <span>Self-reported by the model's creator — <b>not measured by us</b>. These numbers never feed the leaderboard Score or ranks; harnesses and splits differ between labs, so treat them as claims, not comparable results.</span>
      </div>
      <div v-for="s in vendorScores" :key="s.benchmark" class="vendor-row">
        <div class="name" style="min-width:0">
          <span style="font-weight:500">{{ s.benchmark }}</span>
          <b-tooltip :label="VENDOR_NOTE[s.qualifier] || 'creator-reported'" type="is-dark" :delay="100">
            <span class="tag-lab" :class="s.qualifier === 'cited' ? 'rose' : 'teal'" style="font-size:.72rem">{{ s.qualifier }}</span>
          </b-tooltip>
          <a v-if="s.reported_url" class="arch-link" :href="s.reported_url" target="_blank" rel="noopener noreferrer" style="margin-left:.4rem" aria-label="source report"><i class="fas fa-arrow-up-right-from-square"></i></a>
        </div>
        <div class="vendor-side">
          <span v-if="s.reported_date" class="cell-sub" style="margin-right:.6rem">{{ s.reported_date }}</span>
          <span class="num" style="font-weight:600">{{ s.score }}</span>
        </div>
      </div>
      <p class="cell-sub mt-sm">Extracted {{ model.vendor_extracted_at || 'at bake time' }} from {{ vendorUrl || 'the model card' }} — the card's own wording is kept verbatim so every number stays traceable.</p>
    </div>

    <!-- stats-93: measured elsewhere — boards that list this model but that
         we deliberately don't scrape (HTML-only source, or a metric that
         belongs to an agent+harness pair). Links only, never numbers. -->
    <div v-if="elsewhere.length" class="panel-lab mt" style="padding:1.2rem">
      <h3 style="margin:0 0 .6rem;font-size:1.05rem">Measured elsewhere</h3>
      <div class="notice" style="margin:0 0 .7rem">
        <i class="fas fa-circle-info"></i>
        <span>Third-party boards that evaluate this model — linked for reference, <b>not scraped or compared by us</b>. Their methodology and scales differ; open the board to see the numbers in their own context.</span>
      </div>
      <div v-for="b in elsewhere" :key="b.key" class="vendor-row">
        <div class="name" style="min-width:0">
          <span style="font-weight:500">{{ b.label }}</span>
        </div>
        <a class="arch-link cell-sub" :href="b.url" target="_blank" rel="noopener noreferrer"
           :aria-label="b.label + ' board'" style="white-space:nowrap">
          open board <i class="fas fa-arrow-up-right-from-square"></i>
        </a>
      </div>
      <p class="cell-sub mt-sm">{{ elsewhere[0].note }}</p>
    </div>

    <!-- API pricing (price layer) -->
    <div v-if="pricing" class="panel-lab mt" style="padding:1.2rem">
      <div class="row" style="justify-content:space-between;margin-bottom:.6rem">
        <h3 style="margin:0;font-size:1.05rem">API pricing</h3>
        <span class="cell-sub">{{ PRICE_SOURCE_LABEL[pricing.source] || 'List price' }} · snapshot {{ stats.lastUpdated }}</span>
      </div>
      <div class="grid-4">
        <div class="stat">
          <div class="lbl">Input</div>
          <div class="val num">{{ fmtUsd(pricing.input) }}<span class="sub" style="font-size:.9rem"> /1M tok</span></div>
          <div class="sub">standard requests</div>
        </div>
        <div class="stat">
          <div class="lbl">Output</div>
          <div class="val num">{{ fmtUsd(pricing.output) }}<span class="sub" style="font-size:.9rem"> /1M tok</span></div>
          <div class="sub">generated tokens</div>
        </div>
        <div class="stat">
          <div class="lbl">Cache read</div>
          <div class="val num">{{ pricing.cache_read != null ? fmtUsd(pricing.cache_read) : '—' }}<span class="sub" style="font-size:.9rem"> /1M tok</span></div>
          <div class="sub">cached input tokens</div>
        </div>
        <div class="stat">
          <div class="lbl">Context window</div>
          <div class="val num">{{ fmtCtx(modelCtx) }}</div>
          <div class="sub">max tokens per request</div>
        </div>
      </div>
      <p class="cell-sub mt-sm" v-if="value !== null">
        <i class="fas fa-scale-balanced"></i>&nbsp;Value lens: <b style="color:var(--teal)">{{ fmtValue(value) }}</b> score points per 1M blended tokens —
        <router-link class="meth-link" :to="{ name: 'methodology', query: { s: 'money' } }">how it's computed<i class="fas fa-arrow-up-right-from-square"></i></router-link>
      </p>
      <p class="cell-sub mt-sm" v-if="ttft != null">
        <i class="fas fa-bolt"></i>&nbsp;Median TTFT: <span :class="['legend-chip', latencyClass(ttft)]" style="font-size:1.02rem">{{ fmtSec(ttft) }}</span>
        — median time to first token, measured by Artificial Analysis.
        <router-link class="meth-link" :to="{ name: 'methodology', query: { s: 'money' } }">latency tiers<i class="fas fa-arrow-up-right-from-square"></i></router-link>
      </p>
      <p class="cell-sub mt-sm">
        {{ PRICE_SOURCE_NOTE[pricing.source] || 'List price for this row.' }}
        The same model is often cheaper first-party or via other hosts —
        <router-link :to="{ name: 'providers' }">compare sellers</router-link>, or see the
        <router-link class="meth-link" :to="{ name: 'methodology', query: { s: 'money' } }">price source ladder<i class="fas fa-arrow-up-right-from-square"></i></router-link>.
      </p>
    </div>

    <!-- Available at (cross-seller view): every catalog that lists this
         model, with its own list price and free-listing flags. Sellers
         without published prices (keyless /v1/models APIs) show a dash. -->
    <div v-if="availability.length" class="panel-lab mt" style="padding:1.2rem">
      <div class="row" style="justify-content:space-between;margin-bottom:.6rem">
        <h3 style="margin:0;font-size:1.05rem">Available at <span class="cell-sub">({{ availability.length }} {{ availability.length === 1 ? 'seller' : 'sellers' }})</span></h3>
        <span class="cell-sub">each seller's list catalog · snapshot {{ stats.lastUpdated }}</span>
      </div>

      <div v-for="a in availability" :key="a.p" class="avail-row">
        <div class="name" style="min-width:0">
          <span class="avail-seller">{{ a.n }}</span>
          <span class="cell-sub" style="margin-left:.5rem">{{ a.p }}</span>
        </div>
        <div class="avail-side">
          <!-- stats-26: Buefy tooltips on the free chip / list price / dash -->
          <b-tooltip v-if="a.free" :label="FREE_CAVEAT" type="is-dark" :delay="100"><span class="free-chip">free</span></b-tooltip>
          <b-tooltip v-if="availPrice(a)" :label="a.n + ' list price, USD per 1M tokens (in / out)'" type="is-dark" :delay="100"><span class="num avail-price">{{ availPrice(a) }}</span></b-tooltip>
          <b-tooltip v-else-if="!a.free" label="This seller's catalog does not publish prices" type="is-dark" :delay="100"><span class="cell-sub">—</span></b-tooltip>
        </div>
      </div>

      <p class="cell-sub mt-sm">
        <template v-if="freeSellers.length">
          <i class="fas fa-circle-info"></i>&nbsp;Free listing at {{ freeSellers.map(a => a.n).join(' · ') }} —
          free tiers are rate-limited, not unlimited; where a seller shows both a price and a free chip,
          the price is its paid tier and the chip marks a separate free listing.
        </template>
        <template v-else>
          <i class="fas fa-circle-info"></i>&nbsp;Prices are each seller's own list snapshot —
          the leaderboard Price column keeps using the OpenRouter row.
        </template>
        Full catalogs on the <router-link :to="{ name: 'providers' }">Providers page</router-link>.
      </p>
    </div>
  </section>

  <!-- Unknown slug -->
  <b-message v-else type="is-warning" has-icon icon="circle-question" title="Model not found">
    No model matches this link.
    <router-link :to="{ name: 'home' }">Back to the leaderboard</router-link>.
  </b-message>
</template>
