<script setup>
// ── My Providers (stats-36) ───────────────────────────────────────────
// User-supplied AI providers, fully client-side: connect any
// OpenAI-compatible aggregator / private gateway, list its models via
// GET {base}/models (fetch mode) or a pasted response (paste mode —
// works around CORS and keeps the key out of the browser entirely).
//
// The page then splits the listing in two zones:
//   • "On the arena" — models our staged conservative matcher links to
//     catalog rows. Scores / CL / reference prices are MIRRORED READ-ONLY
//     from the snapshot at render time (single source of truth — nothing
//     score-shaped is ever stored). Each row is labeled with HOW it
//     matched (exact / dated snapshot / thinking route) and its reseller
//     decorations ([1m] ctx tags, :free twins).
//   • "Unlisted" — reseller-only models, metadata + honest dashes.
// Home and every other page stay untouched; this is a self-contained
// overlay. Pure logic lives in lib/myProviders.js (unit-tested);
// persistence in stores/myProviders.js (versioned localStorage,
// export/import, clear-all). See the design discussion in worklog
// providers-custom-1/2 for the locked contract with Ibrahim.

import { computed, onMounted, ref } from 'vue';
import { parseModelListing, buildCatalogIndex, matchListing, extractPricing } from '../lib/myProviders.js';
import { fmtScore, fmtCtx, fmtUsd, scoreColor, priceBlend, slugify } from '../lib/format.js';
import { useData } from '../stores/data.js';
import {
  useMyProviders,
} from '../stores/myProviders.js';

const {
  providers, ensureMyProvidersLoaded,
  addProvider, updateProvider, removeProvider, clearAll,
  setModels, setError, exportPayload, importPayload,
} = useMyProviders();
const { ensureLoaded, loading, rawData, pivotAll, modelsMeta, scoreForModel, clForModel, priceFor, isOlder } = useData();

onMounted(() => { ensureMyProvidersLoaded(); ensureLoaded(); });

// ── Catalog matching index (rebuilt when the snapshot loads) ──────────
const catalogIndex = computed(() =>
  (rawData.value ? buildCatalogIndex(pivotAll.value || [], modelsMeta.value || {}) : null));
const rowByName = computed(() => {
  const m = new Map();
  for (const r of pivotAll.value || []) if (r?.name) m.set(r.name, r);
  return m;
});

// ── Add / edit modal ──────────────────────────────────────────────────
const modalOpen = ref(false);
const editingId = ref(null);      // null = adding a new provider
const formMode = ref('fetch');    // 'fetch' | 'paste'
const form = ref({ label: '', baseUrl: '', key: '', paste: '' });
const formError = ref('');
const busy = ref(false);

function openAdd() {
  editingId.value = null;
  formMode.value = 'fetch';
  form.value = { label: '', baseUrl: '', key: '', paste: '' };
  formError.value = '';
  modalOpen.value = true;
}
function openPasteImport(p) {
  editingId.value = p.id;
  formMode.value = 'paste';
  form.value = { label: p.label, baseUrl: p.baseUrl, key: p.key, paste: '' };
  formError.value = '';
  modalOpen.value = true;
}
function openEdit(p) {
  editingId.value = p.id;
  formMode.value = 'fetch';
  form.value = { label: p.label, baseUrl: p.baseUrl, key: p.key, paste: '' };
  formError.value = '';
  modalOpen.value = true;
}

function modelsUrl(base) {
  let b = String(base || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(b)) b = 'https://' + b;
  if (/\/models$/i.test(b)) return b;
  if (/\/v\d+$/i.test(b)) return b + '/models';
  return b + '/v1/models';
}

async function fetchListing(p) {
  const url = modelsUrl(p.baseUrl);
  let res;
  try {
    res = await fetch(url, {
      headers: p.key ? { Authorization: 'Bearer ' + p.key } : {},
    });
  } catch {
    // TypeError from the browser = request never completed (CORS/network)
    throw new Error('The browser blocked the request before it reached the provider — most likely CORS (the provider does not allow browser calls). Use Paste mode instead: run the curl yourself and paste the response here. Your key never has to enter the app.');
  }
  if (res.status === 401 || res.status === 403) throw new Error('Provider rejected the key (HTTP ' + res.status + '). Check the API key — or leave it empty for public listings.');
  if (res.status === 404) throw new Error('HTTP 404 at ' + url + ' — check the base URL (e.g. https://api.unorouter.com/v1).');
  if (!res.ok) throw new Error('Provider returned HTTP ' + res.status + '.');
  const text = await res.text();
  const parsed = parseModelListing(text);
  if (!parsed.models.length) throw new Error('Response parsed but contained no models. If this is a login page or error HTML, check the URL — or use Paste mode.');
  return parsed;
}

async function submitModal() {
  formError.value = '';
  const f = form.value;
  if (!f.label.trim()) { formError.value = 'Give the provider a name.'; return; }
  busy.value = true;
  try {
    if (editingId.value) {
      updateProvider(editingId.value, { label: f.label.trim(), baseUrl: f.baseUrl.trim(), key: f.key });
      if (formMode.value === 'paste') {
        const parsed = parseModelListing(f.paste);
        if (!parsed.models.length) throw new Error(parsed.warnings[0] || 'No models found in the pasted text.');
        setModels(editingId.value, parsed.models, { via: 'paste' });
      } else if (f.baseUrl.trim()) {
        const parsed = await fetchListing({ baseUrl: f.baseUrl.trim(), key: f.key });
        setModels(editingId.value, parsed.models, { via: 'fetch' });
      }
      modalOpen.value = false;
      return;
    }
    // adding a new provider — create only on success
    if (formMode.value === 'paste') {
      const parsed = parseModelListing(f.paste);
      if (!parsed.models.length) throw new Error(parsed.warnings[0] || 'No models found in the pasted text.');
      const p = addProvider({ label: f.label.trim(), baseUrl: f.baseUrl.trim(), mode: 'paste' });
      setModels(p.id, parsed.models);
      modalOpen.value = false;
    } else {
      if (!f.baseUrl.trim()) { formError.value = 'Enter the provider base URL (e.g. https://api.unorouter.com/v1).'; return; }
      const parsed = await fetchListing({ baseUrl: f.baseUrl.trim(), key: f.key });
      const p = addProvider({ label: f.label.trim(), baseUrl: f.baseUrl.trim(), key: f.key, mode: 'fetch' });
      setModels(p.id, parsed.models);
      modalOpen.value = false;
    }
  } catch (e) {
    formError.value = e.message || String(e);
  } finally {
    busy.value = false;
  }
}

async function resync(p) {
  if (p.mode === 'paste') { openPasteImport(p); return; }
  setError(p.id, null);
  busy.value = true;
  try {
    const parsed = await fetchListing(p);
    setModels(p.id, parsed.models);
  } catch (e) {
    setError(p.id, e.message || String(e));
  } finally {
    busy.value = false;
  }
}

// ── Per-provider derived views ────────────────────────────────────────
const showNonChat = ref(new Set()); // provider ids with the non-chat toggle on
function toggleNonChat(id) {
  const s = new Set(showNonChat.value);
  s.has(id) ? s.delete(id) : s.add(id);
  showNonChat.value = s;
}

function matchOf(p) {
  if (!catalogIndex.value) return { matched: [], unlisted: [], stats: { total: 0, matched: 0 } };
  const chat = (p.models || []).filter(m => m.chat);
  return matchListing(chat, catalogIndex.value);
}
function nonChatCount(p) { return (p.models || []).filter(m => !m.chat).length; }

const PASS_LABEL = { exact: 'exact id', dated: 'dated snapshot', thinking: 'thinking route' };

function matchedRows(p) {
  const { matched } = matchOf(p);
  const rows = matched.map(en => {
    const row = rowByName.value.get(en.name);
    const pr = row ? priceFor(row) : null;
    return {
      key: en.model.id,
      name: en.name,
      slug: slugify(en.name),
      pass: en.pass,
      passLabel: PASS_LABEL[en.pass] || en.pass,
      variant: en.model.variant,
      free: en.model.free,
      score: row ? scoreForModel(row) : null,
      cl: row ? clForModel(row) : null,
      price: pr,                       // arena reference (AA list first, 3:1 blend)
      older: row ? isOlder(row) : false,
    };
  });
  const dir = (a, b, cmp) => cmp(a, b) || a.name.localeCompare(b.name);
  const num = (v) => (v === null || v === undefined ? -Infinity : v);
  if (p.intent === 'prices') rows.sort((a, b) => dir(a, b, (x, y) => num(x.price?.blend) - num(y.price?.blend)));
  else if (p.intent === 'track') rows.sort((a, b) => a.name.localeCompare(b.name));
  else rows.sort((a, b) => dir(a, b, (x, y) => num(y.score) - num(x.score))); // scores (default)
  return rows;
}

function unlistedRows(p) {
  const { unlisted } = matchOf(p);
  const rows = unlisted.map(m => ({
    key: m.id, ctx: m.context_length, endpoints: m.endpoints,
    free: m.free, variant: m.variant, kind: 'chat',
    price: extractPricing(m.pricing),
  }));
  if (showNonChat.value.has(p.id)) {
    for (const m of (p.models || []).filter(x => !x.chat)) {
      rows.push({
        key: m.id, ctx: m.context_length, endpoints: m.endpoints,
        free: m.free, variant: m.variant, kind: 'non-chat',
        price: extractPricing(m.pricing),
      });
    }
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

function providerPrice(p) {
  const pr = extractPricing(p);
  if (!pr) return null;
  const blend = priceBlend({ input: pr.in ?? undefined, output: pr.out ?? undefined });
  return blend === null ? null : { blend, in: pr.in, out: pr.out };
}

// ── Post-sync intent question (one optional nudge, never a gate) ─────
function setIntent(p, intent) { updateProvider(p.id, { intent }); }
function skipIntent(p) { updateProvider(p.id, { intentDismissed: true }); }
const INTENT_LABELS = { scores: 'Benchmark scores', prices: 'Price comparison', track: 'Just track models' };

// ── Danger zone / ownership ───────────────────────────────────────────
const msg = ref('');
let msgTimer = null;
function note(t) { msg.value = t; clearTimeout(msgTimer); msgTimer = setTimeout(() => { msg.value = ''; }, 5000); }

let armTimer = null;
const armedClear = ref(false);
const armedDelete = ref(null);
function disarm() { armedClear.value = false; armedDelete.value = null; }
function clearAllClicked() {
  if (!armedClear.value) {
    armedClear.value = true;
    armTimer = setTimeout(disarm, 4000);
    return;
  }
  clearTimeout(armTimer); disarm();
  clearAll();
  note('All My Providers data removed from this browser.');
}
function deleteClicked(p) {
  if (armedDelete.value !== p.id) {
    armedDelete.value = p.id;
    armTimer = setTimeout(disarm, 4000);
    return;
  }
  clearTimeout(armTimer); disarm();
  removeProvider(p.id);
  note('Provider removed.');
}

function exportClicked() {
  const blob = new Blob([exportPayload()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'benchmark-arena-my-providers.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  note('Exported your providers JSON.');
}
function importClicked(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const r = importPayload(String(reader.result || ''));
    note(r.ok ? 'Imported ' + r.count + ' provider(s).' : 'Import failed: ' + r.error);
  };
  reader.readAsText(file);
}

function fmtSync(ts) {
  if (!ts) return 'never synced';
  try { return 'synced ' + ts.slice(0, 16).replace('T', ' '); } catch { return 'synced'; }
}
const fmtEndpoints = (list) => (list && list.length ? list.join(', ') : '—');
</script>

<template>
  <section class="mp-page">
    <div class="page-head">
      <div class="kicker">Your providers · client-side only</div>
      <h1 class="section-title">My Providers</h1>
      <p class="section-sub">
        Connect any OpenAI-compatible provider — aggregators, private gateways,
        self-hosted stacks — and see how its models line up with the arena.
        Everything lives in this browser: keys are sent only to your provider,
        scores are mirrored read-only from the arena snapshot, and
        <strong>Clear all</strong> wipes everything on demand.
      </p>
    </div>

    <div class="panel-lab mp-toolbar">
      <button class="chip mp-primary" type="button" aria-label="Add provider" @click="openAdd">+ Add provider</button>
      <span class="mp-spacer"></span>
      <button class="chip" type="button" :disabled="!providers || !providers.length" @click="exportClicked">Export</button>
      <label class="chip mp-file">
        Import<input type="file" accept="application/json,.json" aria-label="Import providers JSON" @change="importClicked" />
      </label>
      <button class="chip mp-danger" :class="{ armed: armedClear }" type="button"
        :disabled="!providers || !providers.length" @click="clearAllClicked">
        {{ armedClear ? 'Really clear everything?' : 'Clear all' }}
      </button>
    </div>

    <p v-if="msg" class="mp-msg" role="status">{{ msg }}</p>

    <div v-if="!loading && providers && !providers.length" class="panel-lab mp-empty">
      <h2>Nothing here yet</h2>
      <ol>
        <li><strong>Add a provider</strong> — a name, a base URL (e.g. <code>https://api.unorouter.com/v1</code>) and an optional API key.</li>
        <li><strong>Fetch or paste</strong> — we call <code>GET /models</code> from your browser when the provider allows it. If it blocks browser calls (CORS), paste the response of the same curl instead — with paste mode the key never enters the app at all.</li>
        <li><strong>See the split</strong> — models we recognize mirror their arena scores; the rest stay listed honestly with metadata only.</li>
      </ol>
    </div>

    <div v-for="p in providers" :key="p.id" class="panel-lab mp-card">
      <header class="mp-card-head">
        <div class="mp-id">
          <h2 class="mp-name">{{ p.label }}</h2>
          <div class="mp-meta">
            <span v-if="p.baseUrl" class="mp-url">{{ p.baseUrl }}</span>
            <span class="chip chip-quiet">{{ (p.models || []).length }} models</span>
            <span class="chip chip-quiet">{{ fmtSync(p.lastSyncAt) }}</span>
            <span v-if="p.intent" class="chip chip-quiet">focus: {{ INTENT_LABELS[p.intent] || p.intent }}</span>
          </div>
        </div>
        <div class="mp-actions-row">
          <button class="chip" type="button" :aria-label="'Resync ' + p.label" :disabled="busy" @click="resync(p)">
            {{ p.mode === 'paste' ? 'Paste listing' : 'Resync' }}
          </button>
          <button class="chip" type="button" :aria-label="'Edit ' + p.label" @click="openEdit(p)">Edit</button>
          <button class="chip mp-danger" :class="{ armed: armedDelete === p.id }" type="button"
            :aria-label="'Delete ' + p.label" @click="deleteClicked(p)">
            {{ armedDelete === p.id ? 'Really delete?' : 'Delete' }}
          </button>
        </div>
      </header>

      <p v-if="p.lastError" class="mp-err" role="alert">{{ p.lastError }}</p>

      <div v-if="p.lastSyncAt && !p.intent && !p.intentDismissed" class="mp-intent"
        role="group" aria-label="What do you want this provider for?">
        <span class="mp-intent-q">What do you want this provider for?</span>
        <button v-for="(lbl, key) in INTENT_LABELS" :key="key" class="chip" type="button"
          :aria-label="'Focus ' + lbl" @click="setIntent(p, key)">{{ lbl }}</button>
        <button class="chip chip-quiet" type="button" aria-label="Skip focus question" @click="skipIntent(p)">Skip</button>
      </div>

      <div v-if="!(p.models || []).length" class="mp-noModels">
        No listing yet — <button class="linklike" type="button" @click="resync(p)">sync now</button>
        ({{ p.mode === 'paste' ? 'paste a response' : 'fetch from the base URL' }}).
      </div>

      <template v-else-if="catalogIndex">
        <p class="mp-banner" role="status">
          <strong>{{ matchOf(p).stats.matched }} of {{ matchOf(p).stats.total }}</strong> chat models matched the arena catalog
          <template v-if="nonChatCount(p)">
            · {{ nonChatCount(p) }} non-chat (image / embedding) models {{ showNonChat.has(p.id) ? 'shown —' : 'hidden —' }}
            <button class="linklike" type="button" :aria-label="'Toggle non-chat models ' + p.label" @click="toggleNonChat(p.id)">
              {{ showNonChat.has(p.id) ? 'hide' : 'show' }}
            </button>
          </template>
        </p>

        <h3 class="mp-sec">On the arena <span class="chip chip-quiet">{{ matchedRows(p).length }}</span></h3>
        <b-table class="mp-table mp-matched" :data="matchedRows(p)" :hoverable="true" :paginated="matchedRows(p).length > 12" per-page="12">
          <b-table-column field="name" label="Arena model" width="260">
            <template #default="props">
              <div class="model-cell">
                <router-link class="model-link" :to="{ name: 'model', params: { slug: props.row.slug } }">{{ props.row.name }}</router-link>
                <span v-if="props.row.older" class="chip chip-quiet" title="An older generation on the arena — hidden from the default leaderboard view.">older</span>
              </div>
            </template>
          </b-table-column>
          <b-table-column field="key" label="Your provider lists" width="290">
            <template #default="props">
              <code class="mp-sku">{{ props.row.key }}</code>
              <span v-if="props.row.variant" class="chip chip-quiet" :title="'Reseller context/variant tag: [' + props.row.variant + ']'">[{{ props.row.variant }}]</span>
              <span v-if="props.row.free" class="chip chip-quiet" title="Free twin of the paid SKU at this provider.">:free</span>
              <span class="chip chip-match" :title="'Matched by the ' + props.row.pass + ' pass of the conservative matcher.'">{{ props.row.passLabel }}</span>
            </template>
          </b-table-column>
          <b-table-column field="score" label="Score" width="90" centered numeric>
            <template #default="props">
              <span v-if="props.row.score !== null && props.row.score !== undefined" class="num"
                :style="{ color: scoreColor(props.row.score), fontWeight: 600 }">{{ fmtScore(props.row.score) }}</span>
              <span v-else class="mp-dash">—</span>
            </template>
          </b-table-column>
          <b-table-column field="cl" label="CL" width="80" centered numeric>
            <template #default="props">
              <span v-if="props.row.cl !== null && props.row.cl !== undefined">{{ Math.round(props.row.cl) + '%' }}</span>
              <span v-else class="mp-dash">—</span>
            </template>
          </b-table-column>
          <b-table-column field="price" label="Arena ref $/1M" width="130" centered numeric>
            <template #default="props">
              <span v-if="props.row.price" class="num"
                :title="'in $' + props.row.price.input + ' / out $' + (props.row.price.output ?? '?') + ' per 1M tokens · arena reference price (AA / OpenRouter list) — your provider may charge differently'">
                {{ fmtUsd(props.row.price.blend) }}
              </span>
              <span v-else class="mp-dash">—</span>
            </template>
          </b-table-column>
        </b-table>

        <b-collapse v-if="unlistedRows(p).length" class="mp-unlisted" :open="unlistedRows(p).length <= 8">
          <template #trigger="props">
            <button class="chip mp-unlisted-toggle" type="button" :aria-expanded="props ? props.open : null">
              {{ props.open ? '▾' : '▸' }} Unlisted on the arena ({{ unlistedRows(p).length }})
              <span class="mp-unlisted-hint">— reseller-only models, metadata only, honest dashes</span>
            </button>
          </template>
          <b-table class="mp-table mp-unlisted-table" :data="unlistedRows(p)" :hoverable="true" :paginated="unlistedRows(p).length > 14" per-page="14">
            <b-table-column field="key" label="Listing id" width="320">
              <template #default="props">
                <code class="mp-sku">{{ props.row.key }}</code>
                <span v-if="props.row.kind === 'non-chat'" class="chip chip-quiet" title="Non-chat endpoint (image / embedding / other).">non-chat</span>
                <span v-if="props.row.variant" class="chip chip-quiet">[{{ props.row.variant }}]</span>
                <span v-if="props.row.free" class="chip chip-quiet">:free</span>
              </template>
            </b-table-column>
            <b-table-column field="ctx" label="Context" width="110" centered numeric>
              <template #default="props">
                <span v-if="props.row.ctx">{{ fmtCtx(props.row.ctx) }}</span>
                <span v-else class="mp-dash">—</span>
              </template>
            </b-table-column>
            <b-table-column field="endpoints" label="Endpoints">
              <template #default="props">
                <span class="mp-eps">{{ fmtEndpoints(props.row.endpoints) }}</span>
              </template>
            </b-table-column>
            <b-table-column field="price" label="Provider $/1M" width="130" centered numeric>
              <template #default="props">
                <span v-if="providerPrice(props.row)" class="num"
                  :title="'in $' + props.row.price.in + ' / out $' + (props.row.price.out ?? '?') + ' per 1M tokens · as published by your provider'">
                  {{ fmtUsd(providerPrice(props.row).blend) }}
                </span>
                <span v-else class="mp-dash" title="This provider does not publish prices in its /models response.">—</span>
              </template>
            </b-table-column>
            <b-table-column field="score" label="Score" width="90" centered numeric>
              <template #default>
                <span class="mp-dash" title="Not on the arena — no fabricated scores, ever.">—</span>
              </template>
            </b-table-column>
          </b-table>
        </b-collapse>
      </template>
    </div>

    <b-modal v-model="modalOpen" :width="520" aria-role="dialog" aria-label="Provider form">
      <div class="panel-lab mp-modal">
        <h3 class="mp-modal-title">
          {{ editingId ? (formMode === 'paste' ? 'Paste a fresh listing' : 'Edit provider') : 'Add a provider' }}
        </h3>
        <div v-if="!editingId" class="mp-modes" role="radiogroup" aria-label="Connection mode">
          <label class="mp-mode"><input v-model="formMode" type="radio" name="mp-mode" value="fetch" /> Fetch from URL</label>
          <label class="mp-mode"><input v-model="formMode" type="radio" name="mp-mode" value="paste" /> Paste listing</label>
        </div>
        <label class="mp-field">
          <span>Name</span>
          <input v-model="form.label" class="input" type="text" aria-label="Provider label" placeholder="UnoRouter, my gateway…" />
        </label>
        <label v-if="formMode === 'fetch'" class="mp-field">
          <span>Base URL</span>
          <input v-model="form.baseUrl" class="input" type="text" aria-label="Provider base URL" placeholder="https://api.unorouter.com/v1" />
        </label>
        <label class="mp-field">
          <span>API key <em>optional</em></span>
          <input v-model="form.key" class="input" type="password" aria-label="API key optional"
            placeholder="Bearer key — stored only in this browser" autocomplete="off" />
          <small>Stored only in this browser's localStorage; sent only to the base URL above. For private keys, prefer paste mode — the key never enters the app.</small>
        </label>
        <label v-if="formMode === 'paste'" class="mp-field">
          <span>Paste the /models response <em>— full JSON or just one id per line</em></span>
          <textarea v-model="form.paste" class="textarea" rows="8" aria-label="Paste listing"
            placeholder='curl -H "Authorization: Bearer sk-…" https://api.unorouter.com/v1/models  →  paste the output here'></textarea>
        </label>
        <p v-if="formError" class="mp-err" role="alert">{{ formError }}</p>
        <footer class="mp-modal-foot">
          <button class="chip" type="button" @click="modalOpen = false">Cancel</button>
          <button class="chip mp-primary" type="button" aria-label="Save provider" :disabled="busy" @click="submitModal">
            {{ busy ? 'Working…' : (editingId ? 'Save' : (formMode === 'paste' ? 'Import listing' : 'Fetch & add')) }}
          </button>
        </footer>
      </div>
    </b-modal>
  </section>
</template>

<style scoped>
.mp-page { display: flex; flex-direction: column; gap: 16px; padding-bottom: 48px; }
.mp-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mp-spacer { flex: 1; }
.mp-file { cursor: pointer; }
.mp-file input[type="file"] { display: none; }
.mp-primary { background: var(--acc, #4b6bfb); color: #fff; border-color: transparent; }
.mp-primary:hover { filter: brightness(1.08); }
.mp-danger { color: #b0433c; }
.mp-danger.armed { background: #b0433c; color: #fff; border-color: transparent; }
.mp-msg { margin: 0; color: var(--ink-2, #556); font-size: 0.92em; }
.mp-empty h2 { margin: 0 0 10px; font-size: 1.1em; }
.mp-empty ol { margin: 0; padding-left: 20px; display: grid; gap: 8px; color: var(--ink-2, #556); }
.mp-card { display: flex; flex-direction: column; gap: 12px; }
.mp-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.mp-name { margin: 0; font-size: 1.05em; }
.mp-meta { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 4px; }
.mp-url { font-family: ui-monospace, monospace; font-size: 0.86em; color: var(--ink-2, #556); }
.mp-actions-row { display: flex; gap: 8px; flex-wrap: wrap; }
.mp-err { margin: 0; padding: 8px 10px; border-radius: 8px; background: rgba(176, 67, 60, 0.1); color: #b0433c; font-size: 0.92em; }
.mp-intent { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 10px; border-radius: 8px; background: rgba(75, 107, 251, 0.08); font-size: 0.92em; }
.mp-intent-q { font-weight: 600; }
.mp-noModels { color: var(--ink-2, #556); font-size: 0.94em; }
.linklike { background: none; border: none; padding: 0; color: var(--acc, #4b6bfb); cursor: pointer; text-decoration: underline; font: inherit; }
.mp-banner { margin: 0; color: var(--ink-2, #556); font-size: 0.94em; }
.mp-sec { margin: 6px 0 0; font-size: 0.95em; display: flex; align-items: center; gap: 8px; }
.mp-table { width: 100%; }
.model-cell { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.model-link { font-weight: 600; }
.mp-sku { font-family: ui-monospace, monospace; font-size: 0.86em; background: rgba(127, 127, 127, 0.12); border-radius: 5px; padding: 1px 5px; margin-right: 4px; }
.chip-match { border: 1px dashed currentColor; opacity: 0.85; }
.chip-quiet { opacity: 0.75; }
.mp-dash { opacity: 0.5; }
.mp-eps { font-size: 0.86em; color: var(--ink-2, #556); }
.mp-unlisted-toggle { background: none; }
.mp-unlisted-hint { opacity: 0.6; font-size: 0.9em; }
.mp-unlisted :deep(.collapse-content) { padding-top: 10px; }
.mp-modal { display: flex; flex-direction: column; gap: 12px; }
.mp-modal-title { margin: 0; font-size: 1.05em; }
.mp-modes { display: flex; gap: 16px; font-size: 0.94em; }
.mp-mode { display: inline-flex; align-items: center; gap: 6px; }
.mp-field { display: flex; flex-direction: column; gap: 4px; font-size: 0.94em; }
.mp-field span { font-weight: 600; }
.mp-field em { font-weight: 400; opacity: 0.65; }
.mp-field small { opacity: 0.7; line-height: 1.35; }
.mp-modal-foot { display: flex; justify-content: flex-end; gap: 10px; }
</style>

