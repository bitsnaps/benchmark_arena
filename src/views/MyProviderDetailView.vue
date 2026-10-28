<script setup>
// ── stats-66: per-provider full page (My providers) ───────────────────
// Route /providers/mine/:id — one provider, ONE sortable table with every
// listed model: arena-matched rows and reseller-only rows share the same
// columns, a Status column tells them apart, and every column sorts with
// the leaderboard's discipline (nulls/dashes always sink, both directions).
//
// Contract carried over from the cards (stats-36..65) — unchanged:
//   • scores / CL / arena reference prices are MIRRORED READ-ONLY from the
//     snapshot; a model not on the board shows an honest dash, never a
//     fabricated number;
//   • unranked rows stay out of the arena picks (stats-65);
//   • custom pricing keys (stats-51) are a render-time lens on the raw
//     listing — the "Provider $/1M" column re-resolves per render;
//   • non-chat endpoints (image / embedding / other) stay hidden behind a
//     toggle, default off, same as the cards;
//   • everything is localStorage-scoped: the :id only resolves in the
//     browser that created this provider. A shared link on another device
//     lands on the not-found state — by design, not a bug.
// Row building lives in lib/myProviderRows.js (shared with the cards,
// unit-tested); this view is presentation + the refresh affordance.

import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { parseModelListing, buildCatalogIndex, matchListing } from '../lib/myProviders.js';
import { buildMergedRows, numSort, textSort } from '../lib/myProviderRows.js';
import { fmtScore, fmtCtx, fmtUsd, scoreColor } from '../lib/format.js';
import { useData } from '../stores/data.js';
import { useMyProviders } from '../stores/myProviders.js';
import { usePageSize, PAGE_ALL } from '../lib/pager.js';

const route = useRoute();
const router = useRouter();
const {
  providers, ensureMyProvidersLoaded,
  setModels, removeProvider,
} = useMyProviders();
const { ensureLoaded, loading: snapshotLoading, pivotAll, modelsMeta, scoreForModel, clForModel, priceFor, isOlder, isUnranked } = useData();

onMounted(() => { ensureMyProvidersLoaded(); ensureLoaded(); });

const provider = computed(() =>
  (providers.value || []).find(p => p.id === route.params.id) || null);
const ready = computed(() => providers.value !== null && !snapshotLoading.value);

// Same matcher index the cards use — unranked rows stay out (stats-65).
const catalogIndex = computed(() =>
  (pivotAll.value ? buildCatalogIndex(pivotAll.value.filter(r => !r.unranked) || [], modelsMeta.value || {}) : null));

const rowByName = computed(() => {
  const m = new Map();
  for (const r of pivotAll.value || []) if (r?.name) m.set(r.name, r);
  return m;
});

// ── non-chat toggle (default off — same as the cards) ─────────────────
const showNonChat = ref(false);
function nonChatCount(p) { return (p.models || []).filter(m => !m.chat).length; }

// ── merged rows: arena + unlisted (+ non-chat when toggled) ───────────
const allRows = computed(() => {
  if (!provider.value || !catalogIndex.value) return [];
  return buildMergedRows(provider.value, {
    catalogIndex: catalogIndex.value,
    rowByName: rowByName.value,
    scoreForModel, clForModel, priceFor, isOlder, isUnranked,
  }, { includeNonChat: showNonChat.value });
});

// status filter chips — All / On the arena / Unlisted. Non-chat rows ride
// with Unlisted when shown (they are reseller-only by definition).
const statusFilter = ref('all');
const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'arena', label: 'On the arena' },
  { value: 'reseller', label: 'Unlisted' },
];
const rows = computed(() => {
  if (statusFilter.value === 'all') return allRows.value;
  if (statusFilter.value === 'arena') return allRows.value.filter(r => r.status === 'arena');
  return allRows.value.filter(r => r.status !== 'arena');
});
const countFor = (value) => {
  if (value === 'all') return allRows.value.length;
  if (value === 'arena') return allRows.value.filter(r => r.status === 'arena').length;
  return allRows.value.filter(r => r.status !== 'arena').length;
};

// matched banner stats (same numbers as the card — matchListing over the
// chat models; free twins of arena models count as matched too)
const stats = computed(() => {
  const p = provider.value;
  if (!p) return { total: 0, matched: 0 };
  const chat = (p.models || []).filter(m => m.chat);
  if (!catalogIndex.value) return { total: chat.length, matched: 0 };
  return { total: chat.length, matched: matchListing(chat, catalogIndex.value).stats.matched };
});

// ── sorting (lib comparators; the data order IS the intent default) ───
const byName = textSort(r => r.name || r.key);
const byScore = numSort(r => r.score);
const byCl = numSort(r => r.cl);
const byCtx = numSort(r => r.ctx ?? null);
const byArenaPrice = numSort(r => r.price?.blend ?? null);
const byOwnPrice = numSort(r => r.ownPrice?.blend ?? null);

// ── pagination: shared app-wide page size, this page owns the select ──
const pageSize = usePageSize();
const page = ref(1);
const perPage = computed(() => (pageSize.value === PAGE_ALL
  ? Math.max(rows.value.length, 1) : pageSize.value));
const paged = computed(() => rows.value); // b-table paginates internally via :per-page
function onSortStart() { /* b-table emits sort on header click — reset to top */ page.value = 1; }

// ── refresh (Ibrahim: prices move constantly) ─────────────────────────
// fetch mode → re-read GET /models from the provider's base URL;
// paste mode → reopen a paste dialog (the key never enters the app).
const busy = ref(false);
const refreshError = ref('');

function modelsUrl(base) {
  let b = String(base || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(b)) b = 'https://' + b;
  if (/\/models$/i.test(b)) return b;
  if (/\/v\d+$/i.test(b)) return b + '/models';
  return b + '/v1/models';
}

async function refreshClicked() {
  const p = provider.value;
  if (!p) return;
  if (p.mode === 'paste') { pasteOpen.value = true; return; }
  refreshError.value = '';
  busy.value = true;
  try {
    let res;
    try {
      res = await fetch(modelsUrl(p.baseUrl), {
        headers: p.key ? { Authorization: 'Bearer ' + p.key } : {},
      });
    } catch {
      throw new Error('The browser blocked the request before it reached the provider — most likely CORS. Use the Refresh button on the Providers page and paste a fresh listing instead.');
    }
    if (res.status === 401 || res.status === 403) throw new Error('Provider rejected the key (HTTP ' + res.status + ').');
    if (!res.ok) throw new Error('Provider returned HTTP ' + res.status + '.');
    const parsed = parseModelListing(await res.text());
    if (!parsed.models.length) throw new Error('Response parsed but contained no models.');
    setModels(p.id, parsed.models, { via: 'fetch' });
  } catch (e) {
    refreshError.value = e.message || String(e);
  } finally {
    busy.value = false;
  }
}

// paste-mode refresh: minimal dialog — parse + save, same parser as the tab
const pasteOpen = ref(false);
const pasteText = ref('');
const pasteError = ref('');
function pasteSave() {
  const parsed = parseModelListing(pasteText.value);
  if (!parsed.models.length) { pasteError.value = parsed.warnings[0] || 'No models found in the pasted text.'; return; }
  setModels(provider.value.id, parsed.models, { via: 'paste' });
  pasteOpen.value = false;
  pasteText.value = '';
  pasteError.value = '';
}

// ── delete (two-step armed, same discipline as the cards) ─────────────
let armTimer = null;
const armedDelete = ref(false);
function deleteClicked() {
  if (!armedDelete.value) {
    armedDelete.value = true;
    armTimer = setTimeout(() => { armedDelete.value = false; }, 4000);
    return;
  }
  clearTimeout(armTimer); armedDelete.value = false;
  removeProvider(provider.value.id);
  router.push({ name: 'providers', query: { view: 'mine' } });
}

// ── cell helpers (same conventions as the cards) ──────────────────────
function ownPriceOf(row) {
  const pr = row.ownPrice;
  if (!pr || (pr.in == null && pr.out == null)) return null;
  return pr;
}
const fmtEndpoints = (list) => (list && list.length ? list.join(', ') : '—');
const INTENT_LABELS = { scores: 'Benchmark scores', prices: 'Price comparison', track: 'Just track models' };
function fmtSync(ts) {
  if (!ts) return 'never synced';
  try { return 'synced ' + ts.slice(0, 16).replace('T', ' '); } catch { return 'synced'; }
}
const STATUS_META = {
  arena: { label: 'On the arena', cls: 'chip-match', title: 'Matched the arena catalog — scores mirrored read-only.' },
  unlisted: { label: 'Unlisted', cls: 'chip-quiet', title: 'Reseller-only model — metadata only, honest dashes.' },
  'non-chat': { label: 'non-chat', cls: 'chip-quiet', title: 'Non-chat endpoint (image / embedding / other).' },
};
</script>

<template>
  <section class="mpd-page">
    <b-loading :model-value="!ready" :is-full-page="false" />
    <div class="crumbs">
      <router-link class="crumb" :to="{ name: 'home' }"><i class="fas fa-arrow-left"></i> Leaderboard</router-link>
      <span class="crumb-sep">/</span>
      <router-link class="crumb" :to="{ name: 'providers', query: { view: 'mine' } }">My providers</router-link>
      <span class="crumb-sep">/</span>
      <span class="crumb current">{{ provider ? provider.label : 'Provider' }}</span>
    </div>

    <!-- ── not found: the id is browser-local by design ────────────────── -->
    <div v-if="ready && !provider" class="panel-lab mpd-missing">
      <h2>Provider not found</h2>
      <p>
        My Providers live only in this browser. This link points to a provider
        this browser has never seen — it may have been deleted, or the link
        was shared from another device.
      </p>
      <router-link class="button is-small" :to="{ name: 'providers', query: { view: 'mine' } }">
        Back to My providers
      </router-link>
    </div>

    <template v-else-if="provider">
      <header class="panel-lab mpd-head">
        <div class="mpd-id">
          <h1 class="mpd-name">{{ provider.label }}</h1>
          <div class="mp-meta">
            <span v-if="provider.baseUrl" class="mpd-url">{{ provider.baseUrl }}</span>
            <span class="chip chip-quiet">{{ (provider.models || []).length }} models</span>
            <span class="chip chip-quiet">{{ fmtSync(provider.lastSyncAt) }}</span>
            <span v-if="provider.intent" class="chip chip-quiet">focus: {{ INTENT_LABELS[provider.intent] || provider.intent }}</span>
            <span v-if="provider.mode === 'paste'" class="chip chip-quiet" title="Listing imported by paste — refresh reopens the paste dialog.">paste mode</span>
          </div>
        </div>
        <div class="mp-actions-row">
          <b-button size="is-small" type="is-primary" icon-left="rotate" :loading="busy"
            :aria-label="'Refresh listing for ' + provider.label" @click="refreshClicked">
            Refresh
          </b-button>
          <b-button size="is-small" type="is-danger" :outlined="!armedDelete"
            :aria-label="'Delete ' + provider.label" @click="deleteClicked">
            {{ armedDelete ? 'Really delete?' : 'Delete' }}
          </b-button>
        </div>
      </header>

      <p class="cell-sub mpd-hint">
        One table for every model this provider lists. "On the arena" rows
        mirror their scores read-only; "Unlisted" rows stay metadata-only with
        honest dashes. Rename, focus, custom pricing keys and the full paste
        dialog live on the
        <router-link :to="{ name: 'providers', query: { view: 'mine' } }">Providers page</router-link>.
      </p>

      <p v-if="refreshError" class="mp-err" role="alert">{{ refreshError }}</p>

      <div v-if="!(provider.models || []).length" class="panel-lab mpd-missing">
        <h2>No listing yet</h2>
        <p>
          {{ provider.mode === 'paste'
            ? 'Paste a /models response to fill this table — the Refresh button opens the dialog.'
            : 'Hit Refresh to read GET /models from the base URL now.' }}
        </p>
      </div>

      <template v-else-if="catalogIndex">
        <div class="mp-banner-row">
          <p class="mp-banner" role="status">
            <strong>{{ stats.matched }} of {{ stats.total }}</strong> chat models matched the arena catalog
            <template v-if="nonChatCount(provider)">
              · {{ nonChatCount(provider) }} non-chat (image / embedding) models {{ showNonChat ? 'shown —' : 'hidden —' }}
              <button class="linklike" type="button" aria-label="Toggle non-chat models" @click="showNonChat = !showNonChat">
                {{ showNonChat ? 'hide' : 'show' }}
              </button>
            </template>
          </p>
          <div class="mpd-filters" role="group" aria-label="Filter rows by status">
            <button v-for="f in FILTERS" :key="f.value" type="button" class="chip"
              :class="{ 'chip-quiet': statusFilter !== f.value }" :aria-pressed="statusFilter === f.value"
              @click="statusFilter = f.value">
              {{ f.label }} ({{ countFor(f.value) }})
            </button>
          </div>
        </div>

        <div class="panel-lab mpd-table-card">
          <div class="mpd-size">
            <span class="cell-sub">rows per page</span>
            <b-select v-model.number="pageSize" size="is-small" aria-label="rows per page">
              <option :value="20">20</option>
              <option :value="50">50</option>
              <option :value="100">100</option>
              <option :value="0">All</option>
            </b-select>
          </div>

          <b-table
            class="mpd-table"
            :data="paged"
            narrowed hoverable :mobile-cards="false"
            paginated :per-page="perPage" v-model:current-page="page"
            pagination-position="bottom"
            aria-next-label="Next page" aria-previous-label="Previous page"
            aria-page-label="Page" aria-current-label="Current page"
            @sort="onSortStart"
          >
            <b-table-column field="status" label="Status" width="120" centered>
              <template #default="props">
                <span class="chip" :class="STATUS_META[props.row.status].cls" :title="STATUS_META[props.row.status].title">
                  {{ STATUS_META[props.row.status].label }}
                </span>
              </template>
            </b-table-column>

            <b-table-column field="name" label="Model" width="270" sortable :custom-sort="byName">
              <template #default="props">
                <div v-if="props.row.name" class="model-cell">
                  <router-link class="model-link" :to="{ name: 'model', params: { slug: props.row.slug } }">{{ props.row.name }}</router-link>
                  <span v-if="props.row.older" class="chip chip-quiet" title="An older generation on the arena — hidden from the default leaderboard view.">older</span>
                </div>
                <code v-else class="mpd-sku">{{ props.row.key }}</code>
              </template>
            </b-table-column>

            <b-table-column field="key" label="Listed as" width="250">
              <template #default="props">
                <code v-if="props.row.name" class="mpd-sku">{{ props.row.key }}</code>
                <span class="mpd-dash" v-else>—</span>
                <span v-if="props.row.variant" class="chip chip-quiet" :title="'Reseller context/variant tag: [' + props.row.variant + ']'">[{{ props.row.variant }}]</span>
                <span v-if="props.row.free" class="chip chip-quiet" title="Free twin of the paid SKU at this provider.">:free</span>
                <span v-if="props.row.passLabel" class="chip chip-match" :title="'Matched by the ' + props.row.pass + ' pass of the conservative matcher.'">{{ props.row.passLabel }}</span>
              </template>
            </b-table-column>

            <b-table-column field="ctx" label="Context" width="100" centered numeric sortable :custom-sort="byCtx">
              <template #default="props">
                <span v-if="props.row.ctx">{{ fmtCtx(props.row.ctx) }}</span>
                <span v-else class="mpd-dash">—</span>
              </template>
            </b-table-column>

            <b-table-column field="score" label="Score" width="85" centered numeric sortable :custom-sort="byScore">
              <template #default="props">
                <span v-if="props.row.score !== null && props.row.score !== undefined" class="num"
                  :style="{ color: scoreColor(props.row.score), fontWeight: 600 }">{{ fmtScore(props.row.score) }}</span>
                <span v-else class="mpd-dash" title="Not on the arena — no fabricated scores, ever.">—</span>
              </template>
            </b-table-column>

            <b-table-column field="cl" label="CL" width="75" centered numeric sortable :custom-sort="byCl">
              <template #default="props">
                <span v-if="props.row.cl !== null && props.row.cl !== undefined">{{ Math.round(props.row.cl) + '%' }}</span>
                <span v-else class="mpd-dash">—</span>
              </template>
            </b-table-column>

            <b-table-column field="ownPrice" label="Provider $/1M" width="120" centered numeric sortable :custom-sort="byOwnPrice">
              <template #default="props">
                <span v-if="ownPriceOf(props.row)" class="num"
                  :title="'in $' + ownPriceOf(props.row).in + ' / out $' + (ownPriceOf(props.row).out ?? '?') + ' per 1M tokens · as published by your provider' + (ownPriceOf(props.row).viaKeys ? ' · resolved via your custom pricing keys' : '')">
                  {{ fmtUsd(ownPriceOf(props.row).blend) }}
                </span>
                <span v-else class="mpd-dash" title="No price published for this listing id under the standard keys or your custom pricing keys.">—</span>
              </template>
            </b-table-column>

            <b-table-column field="price" label="Arena ref $/1M" width="120" centered numeric sortable :custom-sort="byArenaPrice">
              <template #default="props">
                <span v-if="props.row.price" class="num"
                  :title="'in $' + props.row.price.input + ' / out $' + (props.row.price.output ?? '?') + ' per 1M tokens · arena reference price (AA / OpenRouter list) — your provider may charge differently'">
                  {{ fmtUsd(props.row.price.blend) }}
                </span>
                <span v-else class="mpd-dash">—</span>
              </template>
            </b-table-column>

            <b-table-column field="endpoints" label="Endpoints">
              <template #default="props">
                <span class="mpd-eps">{{ fmtEndpoints(props.row.endpoints) }}</span>
              </template>
            </b-table-column>

            <template #empty>
              <p class="mpd-dash" style="text-align:center;padding:12px 0">
                No rows match this filter — the other chips show the rest.
              </p>
            </template>
          </b-table>
        </div>
      </template>

      <b-modal v-model="pasteOpen" :width="560" aria-role="dialog" aria-label="Paste a fresh listing">
        <div class="panel-lab mpd-modal">
          <h3 class="mpd-modal-title">Paste a fresh listing</h3>
          <p class="cell-sub">Full JSON or just one model id per line. The key never enters the app.</p>
          <b-field>
            <b-input v-model="pasteText" type="textarea" rows="8" aria-label="Paste listing"
              placeholder='curl -H "Authorization: Bearer sk-…" https://…/v1/models  →  paste the output here' />
          </b-field>
          <p v-if="pasteError" class="mp-err" role="alert">{{ pasteError }}</p>
          <footer class="mpd-modal-foot">
            <b-button size="is-small" @click="pasteOpen = false">Cancel</b-button>
            <b-button size="is-small" type="is-primary" aria-label="Import pasted listing" @click="pasteSave">Import listing</b-button>
          </footer>
        </div>
      </b-modal>
    </template>
  </section>
</template>

<style scoped>
.mpd-page { display: flex; flex-direction: column; gap: 14px; }
.mpd-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 1.2rem; }
.mpd-name { margin: 0; font-size: 1.15em; }
.mpd-url { font-family: ui-monospace, monospace; font-size: 0.86em; color: var(--ink-2, #556); }
.mpd-hint { margin: 0; max-width: 88ch; }
.mpd-missing { padding: 1.4rem 1.2rem; display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
.mpd-missing h2 { margin: 0; font-size: 1.1em; }
.mpd-missing p { margin: 0; color: var(--ink-2, #556); max-width: 70ch; }
.mpd-table-card { padding: 1.2rem; display: flex; flex-direction: column; gap: 10px; }
.mpd-size { display: flex; align-items: center; gap: .45rem; align-self: flex-end; }
.mpd-table { width: 100%; }
.mpd-sku { font-family: ui-monospace, monospace; font-size: 0.86em; background: rgba(127, 127, 127, 0.12); border-radius: 5px; padding: 1px 5px; margin-right: 4px; }
.mpd-dash { opacity: 0.5; }
.mpd-eps { font-size: 0.86em; color: var(--ink-2, #556); }
.mpd-filters { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.mpd-modal { display: flex; flex-direction: column; gap: 12px; padding: 1.4rem 1.25rem; }
.mpd-modal-title { margin: 0; font-size: 1.05em; }
.mpd-modal-foot { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; }
/* shared vocabulary with the My Providers cards */
.mpd-table :deep(.table-wrapper) { box-shadow: none; }
.mpd-page .mp-banner-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin: 0; }
.mpd-page .mp-banner { margin: 0; color: var(--ink-2, #556); font-size: 0.94em; }
.mpd-page .mp-actions-row { display: flex; gap: 8px; flex-wrap: wrap; }
.mpd-page .mp-meta { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 4px; }
.mpd-page .mp-err { margin: 0; padding: 8px 10px; border-radius: 8px; background: rgba(176, 67, 60, 0.1); color: #b0433c; font-size: 0.92em; }
.mpd-page .model-cell { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mpd-page .model-link { font-weight: 600; }
.mpd-page .chip-match { border: 1px dashed currentColor; opacity: 0.85; }
.mpd-page .chip-quiet { opacity: 0.75; }
.mpd-page .linklike { background: none; border: none; padding: 0; color: var(--acc, #4b6bfb); cursor: pointer; text-decoration: underline; font: inherit; }
</style>
