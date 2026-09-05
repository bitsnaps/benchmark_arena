<script setup>
// Providers page — the pricing layer's comparison view ("who sells which
// model, at what price"). Renders the scraper-built providers.json catalog:
// first-party labs, cloud platforms, serverless hosts and aggregators, each
// with its model list priced per 1M tokens (input / output). The search box
// narrows across every provider at once; providers with no matching rows
// drop out entirely.
import { computed, onMounted, ref } from 'vue';
import { fmtUsd, fmtCtx } from '../lib/format.js';
import { useProviders } from '../stores/providers.js';

const { rawData, loading, error, ensureProvidersLoaded } = useProviders();
onMounted(ensureProvidersLoaded);

const asOf = computed(() => rawData.value?.as_of || null);
const sources = computed(() => rawData.value?.sources || {});
const kinds = computed(() => rawData.value?.kinds || []);

const q = ref('');
const norm = (s) => String(s).toLowerCase();

// Filter across all providers at once: a row survives when the model id (or
// display name) matches; a provider survives while ≥1 of its rows does.
// Matching the provider name keeps every row of that provider (browse mode).
const filtered = computed(() => {
  const all = rawData.value?.providers || [];
  const term = norm(q.value).trim();
  if (!term) return all.map(p => ({ ...p, shown: p.models }));
  return all
    .map(p => {
      if (norm(p.name).includes(term)) return { ...p, shown: p.models };
      const shown = p.models.filter(m =>
        norm(m.id).includes(term) || (m.name && norm(m.name).includes(term)));
      return shown.length ? { ...p, shown } : null;
    })
    .filter(Boolean);
});

const grouped = computed(() => kinds.value
  .map(kind => ({ kind, providers: filtered.value.filter(p => p.kind === kind) }))
  .filter(g => g.providers.length));

const totalShown = computed(() => filtered.value.reduce((a, p) => a + p.shown.length, 0));
const totalRows = computed(() => (rawData.value?.providers || []).reduce((a, p) => a + p.models.length, 0));

const KIND_LABEL = {
  'first-party': 'First-party labs',
  'cloud': 'Cloud platforms',
  'serverless': 'Serverless hosts',
  'aggregator': 'Aggregators & gateways',
};
const KIND_BLURB = {
  'first-party': 'The lab\u2019s own API — the reference price for each model.',
  'cloud': 'Enterprise platforms hosting many labs\u2019 models behind enterprise terms.',
  'serverless': 'Specialist GPU hosts competing on price and speed for open-weight models.',
  'aggregator': 'One API over many sellers — convenient, usually with a routing margin on top.',
};
</script>

<template>
  <section>
    <div class="crumbs">
      <router-link class="crumb" :to="{ name: 'home' }"><i class="fas fa-arrow-left"></i> Leaderboard</router-link>
      <span class="crumb-sep">/</span>
      <span class="crumb current">Providers</span>
    </div>

    <div class="row" style="justify-content:space-between;align-items:flex-end">
      <div>
        <h1 class="section-title" style="margin:0">AI Providers &amp; Pricing</h1>
        <p class="cell-sub mt-sm" style="max-width:64ch">
          Who sells which model, at what price — USD per 1M tokens, input / output.
          The leaderboard's Price column is the OpenRouter list price for each tracked
          row; this page is the full spread of first-party, cloud, serverless and
          aggregator listings so the cheapest seller is visible.
        </p>
      </div>
      <span v-if="asOf" class="tag-lab">prices as of {{ asOf }}</span>
    </div>

    <div class="row mt" style="gap:.6rem;align-items:center">
      <b-input v-model="q" placeholder="Filter models or providers — e.g. opus, qwen, fireworks"
        icon="magnifying-glass" size="is-small" style="max-width:380px" />
      <span class="cell-sub">{{ totalShown }} of {{ totalRows }} catalog rows</span>
    </div>

    <b-message v-if="error" type="is-danger" has-icon icon="triangle-exclamation" title="Error">
      {{ error }}
    </b-message>
    <b-loading :model-value="loading" :is-full-page="false" />

    <template v-if="!loading && !error">
      <div v-for="g in grouped" :key="g.kind" class="mt">
        <div class="row" style="gap:.6rem;align-items:baseline">
          <h2 class="prov-kind-title">{{ KIND_LABEL[g.kind] || g.kind }}</h2>
          <span class="cell-sub">{{ KIND_BLURB[g.kind] }} · {{ g.providers.length }} providers</span>
        </div>

        <div v-for="p in g.providers" :key="p.id" class="panel-lab prov-card">
          <div class="row" style="justify-content:space-between">
            <h3 class="prov-name">{{ p.name }}</h3>
            <span class="cell-sub">{{ p.shown.length }} model{{ p.shown.length === 1 ? '' : 's' }}</span>
          </div>
          <table class="prov-table">
            <thead>
              <tr>
                <th class="left">Model</th>
                <th>$/1M in</th>
                <th>$/1M out</th>
                <th>Context</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in p.shown" :key="p.id + m.id">
                <td class="left">
                  <span class="prov-model">{{ m.name || m.id }}</span>
                  <span v-if="m.name && m.id !== m.name" class="prov-id">{{ m.id }}</span>
                  <span v-if="m.in === 0 && (m.out ?? 0) === 0" class="free-chip">free</span>
                </td>
                <td class="num">{{ fmtUsd(m.in) }}</td>
                <td class="num">{{ fmtUsd(m.out) }}</td>
                <td class="num cell-sub">{{ fmtCtx(m.ctx) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <p class="cell-sub mt" style="text-align:center">
        Catalog: {{ sources.catalog }} · Aggregator section: {{ sources.aggregator }}.
        Prices move often — refresh the snapshot before budgeting anything serious.
      </p>
    </template>
  </section>
</template>
