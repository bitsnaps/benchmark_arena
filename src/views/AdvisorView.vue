<script setup>
// ── Use-case advisor (stats-33) ──────────────────────────────────────────
// Ibrahim's template, adapted: a 4-step wizard (use case → cost/quality/
// latency tradeoff → hard constraints → shortlist) that ranks models with
// generated reasons. Every number flows through the shared store accessors
// the leaderboard already uses — scoreForModel (limited-data fallback),
// filterPriceFor (3:1 blend, free listings = $0), metaFor (TTFT, context,
// modalities), tierOf (open-weights membership), isOlder (current-gen
// filter) — plus the pure scoring core in lib/advisor.js. Spec:
// docs/spec-usecase-advisor.md.
//
// State is URL-synced (#/advisor?use=coding&priority=balanced&…&s=3) so
// results are shareable, same discipline as ?tier=/?avg=/?models=.

import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  PROFILES, PRIORITIES, SPEEDS, CTX_LADDER, CAP_LADDER, OPEN_WEIGHTS_OPTIONS,
  SHORTLIST_SIZE, FORM_DEFAULTS, PRICE_RECIPE_NOTE,
} from '../config/advisorProfiles.js';
import {
  profileScoreFor, coverageTag, weightFor, normalizeParams, survivors,
  rankCandidates, buildReasons, buildFlags, emptyStateHint, fmtComposite,
} from '../lib/advisor.js';
import { fmtUsd, fmtCtx, fmtSec, providerColor, initials, slugify } from '../lib/format.js';
import { useData } from '../stores/data.js';

const route = useRoute();
const router = useRouter();
const {
  pivotAll, scoreForModel, filterPriceFor, hasFreeListingFor, metaFor,
  tierOf, isOlder, releaseDateOf,
} = useData();

// ── Wizard state ⇄ URL (shareable, loop-guarded by canonical forms) ─────
const step = ref(0);
const form = ref(readQuery(route.query));

function readQuery(q) {
  const f = { ...FORM_DEFAULTS };
  if (PROFILES[q.use]) f.use = q.use;
  if (PRIORITIES.some(p => p.id === q.priority)) f.priority = q.priority;
  if (SPEEDS.some(s => s.id === q.speed)) f.speed = q.speed;
  const ctx = Number(q.ctx);
  if (CTX_LADDER.includes(ctx)) f.ctx = ctx;
  if (q.vision === '1') f.vision = true;
  if (OPEN_WEIGHTS_OPTIONS.some(o => o.id === q.open)) f.open = q.open;
  const cap = Number(q.cap);
  if (CAP_LADDER.includes(cap)) f.cap = cap;
  if (q.strict === '1') f.strict = true;
  return f;
}

function writeQuery() {
  const f = form.value;
  const q = {};
  if (f.use) q.use = f.use;
  if (f.priority !== FORM_DEFAULTS.priority) q.priority = f.priority;
  if (f.speed !== FORM_DEFAULTS.speed) q.speed = f.speed;
  if (f.ctx) q.ctx = String(f.ctx);
  if (f.vision) q.vision = '1';
  if (f.open !== FORM_DEFAULTS.open) q.open = f.open;
  if (f.cap) q.cap = String(f.cap);
  if (f.strict) q.strict = '1';
  // step rides along whenever real wizard state exists — a deep link with
  // ?use=… and NO s param means "jump to results" (spec §3.3), so the URL
  // we write must always carry an explicit s once a use case is picked.
  // Fully-default state (start over) writes {} → clean #/advisor.
  if (f.use || step.value > 0) q.s = String(step.value);
  return q;
}

// Deep link: ?use=… lands straight on the results step (spec §3.3)
{
  const q = route.query;
  if (PROFILES[q.use]) {
    const s = Number(q.s);
    step.value = Number.isInteger(s) && s >= 0 && s <= 3 ? s : 3;
  }
}

watch([step, form], () => {
  const want = writeQuery();
  const cur = route.query;
  const same = Object.keys(want).length === Object.keys(cur).length
    && Object.keys(want).every(k => String(cur[k]) === want[k]);
  if (!same) router.replace({ query: want });
}, { deep: true });

watch(() => route.query, (q) => {
  const wantForm = readQuery(q);
  if (JSON.stringify(wantForm) !== JSON.stringify(form.value)) form.value = wantForm;
  const s = Number(q.s);
  const wantStep = PROFILES[q.use]
    ? (Number.isInteger(s) && s >= 0 && s <= 3 ? s : 3)
    : 0;
  if (wantStep !== step.value) step.value = wantStep;
});

// ── Step navigation ──────────────────────────────────────────────────────
function pickUse(id) {
  form.value.use = id;
  // Vision & media IS image understanding — pre-set the constraint (undoable)
  if (PROFILES[id]?.visionLock) form.value.vision = true;
}
const canContinue = computed(() => !(step.value === 0 && !form.value.use));
function next() { if (canContinue.value) step.value = Math.min(3, step.value + 1); }
function back() { step.value = Math.max(0, step.value - 1); }
function startOver() {
  form.value = { ...FORM_DEFAULTS };
  step.value = 0;
}

// ── Candidates (current-gen only) → constraints → ranked shortlist ──────
const profile = computed(() => PROFILES[form.value.use] || null);

const allCandidates = computed(() => {
  if (!profile.value) return [];
  const out = [];
  for (const row of pivotAll.value) {
    if (isOlder(row)) continue; // advising a superseded model is bad advice
    const { score, covered } = profileScoreFor(row, profile.value.benches);
    let quality, tag;
    if (covered > 0) {
      quality = score;
      tag = coverageTag(covered);
    } else {
      // limited data → the leaderboard's own Score (same formula, core set)
      quality = scoreForModel(row);
      if (quality === null || quality === undefined) continue; // no evidence at all
      tag = 'limited';
    }
    const meta = metaFor(row);
    const mods = meta?.input_modalities;
    out.push({
      name: row.name,
      row,
      quality,
      covered,
      tag,
      blend: filterPriceFor(row), // free listing → $0, else 3:1 blend, else null
      free: hasFreeListingFor(row),
      ttft: meta?.aa_ttft_seconds ?? null,
      ctx: meta?.context_length ?? null,
      vision: Array.isArray(mods) ? mods.includes('image') : null,
      open: tierOf(row) === 'open',
      created: releaseDateOf(row),
    });
  }
  return out;
});

const weights = computed(() => weightFor(form.value.priority, form.value.speed));

const effConstraints = computed(() => ({
  ctx: form.value.ctx,
  vision: form.value.vision || !!(profile.value && profile.value.visionLock),
  open: form.value.open,
  cap: form.value.cap,
  strict: form.value.strict,
}));

const result = computed(() => {
  if (!profile.value) return null;
  const cands = allCandidates.value;
  const { kept, flagsByCand } = survivors(cands, effConstraints.value);
  const norm = normalizeParams(kept);
  const top = rankCandidates(kept, weights.value, norm).slice(0, SHORTLIST_SIZE);
  const items = top.map((item, i) => ({
    ...item,
    rank: i + 1,
    reasons: buildReasons(top, item, profile.value.label),
    flags: buildFlags(item, flagsByCand.get(item.cand.name) || []),
  }));
  return {
    items,
    hint: items.length ? null : emptyStateHint(cands, effConstraints.value),
  };
});

const visionLocked = computed(() => !!(profile.value && profile.value.visionLock));
// the vision constraint as enforced: the user's toggle OR the profile lock
const effVision = computed(() => form.value.vision || visionLocked.value);

// ── Compare picks (deep-links into ?models=slug,slug) ────────────────────
const comparePicks = ref([]);
function toggleCompare(name) {
  const i = comparePicks.value.indexOf(name);
  if (i >= 0) comparePicks.value.splice(i, 1);
  else if (comparePicks.value.length < SHORTLIST_SIZE) comparePicks.value.push(name);
}
function goCompare() {
  const models = comparePicks.value.map(slugify).join(',');
  router.push({ name: 'compare', query: models ? { models } : {} });
}

const priceLabel = (c) => {
  if (c.free) return 'free listing available';
  if (typeof c.blend === 'number' && c.blend > 0) return `${fmtUsd(c.blend)}/1M blended`;
  return 'price unlisted';
};
</script>

<template>
  <div>
    <div class="page-head">
      <div class="kicker">Decision wizard</div>
      <h1 class="section-title">Use-case advisor</h1>
      <p class="section-sub">Four questions. A ranked shortlist with reasons, not a mystic vibe check.</p>
      <div class="wizard-bar" aria-hidden="true"><i :style="{ width: ((step + 1) / 4 * 100) + '%' }"></i></div>
    </div>

    <!-- ── Step 0 · use case ─────────────────────────────────────────── -->
    <div v-if="step === 0">
      <h3>What are you actually doing?</h3>
      <div class="grid-4 mt-sm">
        <div v-for="u in PROFILES" :key="u.id" class="step-card" :class="{ on: form.use === u.id }"
          role="button" tabindex="0" @click="pickUse(u.id)" @keydown.enter="pickUse(u.id)">
          <i class="fas" :class="u.icon" style="color: var(--teal)"></i>
          <h4 style="margin: .45rem 0 .2rem">{{ u.label }}</h4>
          <p class="adv-note">{{ u.blurb }}</p>
        </div>
      </div>
    </div>

    <!-- ── Step 1 · tradeoffs ────────────────────────────────────────── -->
    <div v-if="step === 1">
      <h3>How should we trade quality against cost and latency?</h3>
      <div class="grid-3 mt-sm">
        <div v-for="p in PRIORITIES" :key="p.id" class="step-card" :class="{ on: form.priority === p.id }"
          role="button" tabindex="0" @click="form.priority = p.id" @keydown.enter="form.priority = p.id">
          <h4>{{ p.label }}</h4>
          <p class="adv-note">{{ p.blurb }}</p>
        </div>
      </div>
      <div class="grid-3 mt">
        <div v-for="s in SPEEDS" :key="s.id" class="step-card" :class="{ on: form.speed === s.id }"
          role="button" tabindex="0" @click="form.speed = s.id" @keydown.enter="form.speed = s.id">
          <h4>{{ s.label }}</h4>
        </div>
      </div>
    </div>

    <!-- ── Step 2 · hard constraints ─────────────────────────────────── -->
    <div v-if="step === 2">
      <h3>Hard constraints</h3>
      <p class="adv-note mt-sm">Unlisted specs pass with a flag by default — strict mode drops them instead.</p>
      <div class="grid-2 mt-sm">
        <div class="panel-lab" style="padding: 1rem">
          <div class="field-lab"><label>Minimum context window</label>
            <select class="input-lab" v-model.number="form.ctx" aria-label="Minimum context window">
              <option v-for="v in CTX_LADDER" :key="v" :value="v">
                {{ v === 0 ? 'No preference' : fmtCtx(v) + '+' }}
              </option>
            </select>
          </div>
          <div class="field-lab mt-sm"><label>Must see images?</label>
            <div class="chips">
              <span class="chip" :class="{ on: !effVision }" @click="!visionLocked && (form.vision = false)">No</span>
              <span class="chip" :class="{ on: effVision }" @click="form.vision = true">Yes, vision required</span>
            </div>
            <p v-if="visionLocked" class="adv-note mt-sm">Required by the Vision &amp; media use case.</p>
          </div>
        </div>
        <div class="panel-lab" style="padding: 1rem">
          <div class="field-lab"><label>Weights / deployment</label>
            <div class="chips">
              <span v-for="o in OPEN_WEIGHTS_OPTIONS" :key="o.id" class="chip" :class="{ on: form.open === o.id }"
                @click="form.open = o.id">{{ o.label }}</span>
            </div>
          </div>
          <div class="field-lab mt-sm"><label>Max blended $ / 1M tokens</label>
            <select class="input-lab" v-model.number="form.cap" aria-label="Max blended price" :title="PRICE_RECIPE_NOTE">
              <option v-for="v in CAP_LADDER" :key="v" :value="v">
                {{ v === 0 ? 'No cap' : 'Under $' + v }}
              </option>
            </select>
            <p class="adv-note mt-sm">{{ PRICE_RECIPE_NOTE }} (AA list price first, OpenRouter snapshot second).</p>
          </div>
        </div>
      </div>
      <div class="field-lab mt">
        <label>Strict mode</label>
        <div class="chips">
          <span class="chip" :class="{ on: !form.strict }" @click="form.strict = false">Off — flag unlisted specs</span>
          <span class="chip" :class="{ on: form.strict }" @click="form.strict = true">On — drop unlisted specs</span>
        </div>
      </div>
    </div>

    <!-- ── Step 3 · shortlist ────────────────────────────────────────── -->
    <div v-if="step === 3 && profile">
      <h3>Your shortlist</h3>
      <template v-if="result && result.items.length">
        <div class="grid-3 mt-sm">
          <div v-for="r in result.items" :key="r.cand.name" class="model-tile">
            <div class="tile-top">
              <div class="rank" :class="r.rank === 1 ? 'g' : r.rank === 2 ? 's' : r.rank === 3 ? 'b' : ''">{{ r.rank }}</div>
              <span class="av" :style="{ background: providerColor(r.cand.name).color }">{{ initials(r.cand.name) }}</span>
            </div>
            <h3 style="margin: .6rem 0 .2rem">{{ r.cand.name }}</h3>
            <div class="score-xl num">{{ fmtComposite(r.score) }}</div>
            <div v-if="r.rank === 1" class="tag-lab teal">Recommended</div>
            <div class="adv-meta mt-sm">
              <span :title="PRICE_RECIPE_NOTE">{{ priceLabel(r.cand) }}</span>
              <span v-if="r.cand.ttft != null">TTFT {{ fmtSec(r.cand.ttft) }}</span>
              <span v-if="r.cand.ctx != null">{{ fmtCtx(r.cand.ctx) }} context</span>
            </div>
            <ul class="mt-sm" style="padding-left: 1.1rem; color: var(--muted); font-size: .86rem">
              <li v-for="why in r.reasons" :key="why">{{ why }}</li>
            </ul>
            <div v-if="r.flags.length" class="chips mt-sm">
              <span v-for="f in r.flags" :key="f" class="tag-lab muted">{{ f }}</span>
            </div>
            <div class="row mt-sm">
              <router-link class="btn tiny primary" :to="{ name: 'model', params: { slug: slugify(r.cand.name) } }">Details</router-link>
              <button class="btn tiny" @click="toggleCompare(r.cand.name)">
                {{ comparePicks.includes(r.cand.name) ? '✓ Picked' : 'Compare' }}
              </button>
            </div>
          </div>
        </div>
        <div class="row mt" v-if="comparePicks.length >= 2">
          <button class="btn primary" @click="goCompare">Compare {{ comparePicks.length }} picks</button>
        </div>
      </template>
      <template v-else-if="result">
        <p class="section-sub mt-sm">Nothing survives those constraints.</p>
        <p v-if="result.hint" class="adv-note">{{ result.hint }}</p>
        <p v-else class="adv-note">Loosen price, context or the open-weights filter.</p>
      </template>
    </div>

    <!-- ── Wizard navigation ─────────────────────────────────────────── -->
    <div class="row mt">
      <button class="btn" v-if="step > 0" @click="back">Back</button>
      <button class="btn primary" v-if="step < 3" :disabled="!canContinue" @click="next">Continue</button>
      <button class="btn" v-if="step === 3" @click="startOver">Start over</button>
    </div>

    <p class="adv-note mt">
      Recommendations come from the same snapshot as the leaderboard — profile scores are the
      coverage-weighted mean of the use-case benchmarks, re-weighted by your priority and speed
      choice. Latency = median time-to-first-token; throughput is not measured. Modality coverage
      (audio / video / image generation) is still thin — an honest flag beats a fabricated answer.
    </p>
  </div>
</template>
