<script setup>
// ── My Providers panel (stats-36 page → stats-37 tab) ─────────────────
// User-supplied AI providers, fully client-side: connect any
// OpenAI-compatible aggregator / private gateway, list its models via
// GET {base}/models (fetch mode) or a pasted response (paste mode —
// works around CORS and keeps the key out of the browser entirely).
//
// stats-37 re-home: this used to be the standalone /my-providers page;
// it now renders as the third tab of the Providers page. The shell
// changed, the contract did not:
//   • "On the arena" — models our staged conservative matcher links to
//     catalog rows. Scores / CL / reference prices are MIRRORED READ-ONLY
//     from the snapshot at render time (single source of truth — nothing
//     score-shaped is ever stored). Each row is labeled with HOW it
//     matched (exact / dated snapshot / thinking route) and its reseller
//     decorations ([1m] ctx tags, :free twins).
//   • "Unlisted" — reseller-only models, metadata + honest dashes.
//   • This tab is an ADDITIVE overlay: nothing here touches the catalog
//     arrays, so footer counts, the price-filter slider universe and the
//     Compare pivot stay catalog-only (tabs 1–2). It renders regardless
//     of the catalog fetch — its only catalog touchpoint is the read-only
//     mirror from benchmark_results.json via the data store.
//   • The page-level search box is shared across all three tabs; here it
//     scopes rows WITHIN each provider card (arena name or listing id),
//     with browse mode — a label / base-URL hit keeps every row of its
//     own. Pricing filters stay catalog-tabs-only: many user providers
//     publish no prices, so "free only" would blank this tab confusingly.
// Pure logic lives in lib/myProviders.js (unit-tested); persistence in
// stores/myProviders.js (versioned localStorage, export/import, clear-all
// — key ba.myproviders.v1 UNCHANGED by the move, zero data migration).

import { computed, onMounted, ref, watch } from 'vue';
import { parseModelListing, buildCatalogIndex, matchListing, extractPricingFor, normalizePriceKeys, previewPricingKeys } from '../lib/myProviders.js';
import { fmtScore, fmtCtx, fmtUsd, scoreColor, priceBlend, slugify } from '../lib/format.js';
import { useData } from '../stores/data.js';
import {
  useMyProviders,
} from '../stores/myProviders.js';

// Shared search from the Providers page toolbar (spans all three tabs).
const props = defineProps({
  search: { type: String, default: '' },
});

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
const form = ref({ label: '', baseUrl: '', key: '', paste: '', keyIn: '', keyOut: '', unit: 'token' });
const formError = ref('');
const busy = ref(false);

function keysFromProvider(p) {
  const pk = p && p.priceKeys;
  return { keyIn: pk?.input || '', keyOut: pk?.output || '', unit: pk?.unit === '1m' ? '1m' : 'token' };
}

function openAdd() {
  editingId.value = null;
  formMode.value = 'fetch';
  form.value = { label: '', baseUrl: '', key: '', paste: '', keyIn: '', keyOut: '', unit: 'token' };
  unitTouched.value = false;
  resetKeyTest();
  formError.value = '';
  modalOpen.value = true;
}
function openPasteImport(p) {
  editingId.value = p.id;
  formMode.value = 'paste';
  form.value = { label: p.label, baseUrl: p.baseUrl, key: p.key, paste: '', ...keysFromProvider(p) };
  unitTouched.value = false;
  resetKeyTest();
  formError.value = '';
  modalOpen.value = true;
}
function openEdit(p) {
  editingId.value = p.id;
  formMode.value = 'fetch';
  form.value = { label: p.label, baseUrl: p.baseUrl, key: p.key, paste: '', ...keysFromProvider(p) };
  unitTouched.value = false;
  resetKeyTest();
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
  // stats-51: custom pricing keys — validated BEFORE any fetch/commit so a
  // typo in a path can never half-save. Both empty -> null (feature off).
  const { priceKeys, error: keysError } = normalizePriceKeys({ input: f.keyIn, output: f.keyOut, unit: f.unit });
  if (keysError) { formError.value = keysError; return; }
  busy.value = true;
  try {
    if (editingId.value) {
      updateProvider(editingId.value, { label: f.label.trim(), baseUrl: f.baseUrl.trim(), key: f.key, priceKeys });
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
      const p = addProvider({ label: f.label.trim(), baseUrl: f.baseUrl.trim(), mode: 'paste', priceKeys });
      setModels(p.id, parsed.models);
      modalOpen.value = false;
    } else {
      if (!f.baseUrl.trim()) { formError.value = 'Enter the provider base URL (e.g. https://api.unorouter.com/v1).'; return; }
      const parsed = await fetchListing({ baseUrl: f.baseUrl.trim(), key: f.key });
      const p = addProvider({ label: f.label.trim(), baseUrl: f.baseUrl.trim(), key: f.key, mode: 'fetch', priceKeys });
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

// ── stats-51: custom pricing keys — live preview + dry-run check ─────
// The preview is the honesty anchor: it shows EXACTLY what the parser
// will extract, before any commit (Ibrahim: check before Fetch & Add).
// Sources by context: paste text (add/paste-import, live per keystroke),
// the stored listing (edit — keys are a render-time lens, no re-sync),
// or a dry-run fetch (add-fetch 'Test keys', nothing persisted).
const unitTouched = ref(false);
const keyTestModels = ref(null);
const keyTestBusy = ref(false);
const keyTestError = ref('');

function resetKeyTest() {
  keyTestModels.value = null;
  keyTestError.value = '';
  keyTestBusy.value = false;
}

// stale-guard: any input the dry-run depended on invalidates its result
watch(() => [form.value.baseUrl, form.value.key, form.value.paste], resetKeyTest);

async function testKeys() {
  resetKeyTest();
  keyTestBusy.value = true;
  try {
    const parsed = await fetchListing({ baseUrl: form.value.baseUrl.trim(), key: form.value.key });
    keyTestModels.value = parsed.models;
  } catch (e) {
    keyTestError.value = e.message || String(e);
  } finally {
    keyTestBusy.value = false;
  }
}

// Light unit auto-suggest: a key path that names its unit (_per_1M_tokens /
// per_token) pre-selects the radio — EXPLICITLY visible, one click to
// override, and the preview still shows the final numbers either way.
watch(() => [form.value.keyIn, form.value.keyOut], ([a, b]) => {
  if (unitTouched.value) return;
  const s = `${a} ${b}`;
  if (/per.?1.?m/i.test(s)) form.value.unit = '1m';
  else if (/per.?token/i.test(s)) form.value.unit = 'token';
});

const previewModels = computed(() => {
  if (formMode.value === 'paste') {
    return form.value.paste.trim() ? parseModelListing(form.value.paste).models : null;
  }
  if (editingId.value) {
    const p = (providers.value || []).find(x => x.id === editingId.value);
    return p ? (p.models || []) : null;
  }
  return keyTestModels.value;
});

const keysPreview = computed(() => {
  const { priceKeys } = normalizePriceKeys({ input: form.value.keyIn, output: form.value.keyOut, unit: form.value.unit });
  if (!previewModels.value || !previewModels.value.length) return null;
  return { keys: priceKeys, summary: previewPricingKeys(previewModels.value, priceKeys) };
});

// Preview samples show EXACT extracted values — fmtUsd rounds >=10 to
// integers, which is right for table cells but wrong for a verification
// tool where $10.55 vs $11 is exactly the difference being checked.
const fmtSample = (v) => (v == null ? '—' : '$' + (Math.round(v * 1e6) / 1e6));

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

// stats-39: preview/route/thinksearch added; combo passes ('route+dated')
// render as 'route tag + dated snapshot' via the segment join below.
const PASS_LABEL = {
  exact: 'exact id', dated: 'dated snapshot', thinking: 'thinking route',
  preview: 'preview build', route: 'route tag', thinksearch: 'think+search route',
};
const passLabelOf = (p) => String(p).split('+').map(s => PASS_LABEL[s] || s).join(' + ');

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
      passLabel: passLabelOf(en.pass),
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
  // stats-51: key-aware extraction — custom pricing keys resolve against
  // each entry's raw listing (falls back to prompt/completion per side).
  const priceOf = (m) => extractPricingFor(m, p.priceKeys);
  const rows = unlisted.map(m => ({
    key: m.id, ctx: m.context_length, endpoints: m.endpoints,
    free: m.free, variant: m.variant, kind: 'chat',
    price: priceOf(m),
  }));
  if (showNonChat.value.has(p.id)) {
    for (const m of (p.models || []).filter(x => !x.chat)) {
      rows.push({
        key: m.id, ctx: m.context_length, endpoints: m.endpoints,
        free: m.free, variant: m.variant, kind: 'non-chat',
        price: priceOf(m),
      });
    }
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

// stats-51 FIX: this used to call extractPricing(props.row) against the ROW
// wrapper (no prompt/completion on it) — the "Provider $/1M" column dashed
// EVEN when the provider published prices. Read the row's precomputed
// key-aware price instead and blend it (3:1, same convention everywhere).
function providerPrice(row) {
  const pr = row && row.price;
  if (!pr || (pr.in == null && pr.out == null)) return null;
  const blend = priceBlend({ input: pr.in ?? undefined, output: pr.out ?? undefined });
  return blend === null ? null : { blend, in: pr.in, out: pr.out, viaKeys: !!pr.viaKeys };
}

// ── Shared-search scoping (stats-37) ──────────────────────────────────
// One card per stored provider with its rows pre-filtered by the page's
// shared search term. Row-level match = arena model name or listing id;
// browse mode (label / base URL hit) keeps every row of that provider —
// the same semantics tab 1 applies to a provider-name hit. Cards with no
// surviving rows drop off the tab; with no term everything renders as-is.
const lo = (s) => String(s || '').toLowerCase();
const searchTerm = computed(() => lo(props.search).trim());
const cards = computed(() => {
  const term = searchTerm.value;
  return (providers.value || [])
    .map(p => {
      const matched = matchedRows(p);
      const unlisted = unlistedRows(p);
      if (!term) return { p, matched, unlisted, browse: false };
      const browse = lo(p.label).includes(term) || lo(p.baseUrl).includes(term);
      return {
        p,
        matched: browse ? matched : matched.filter(r => lo(r.name).includes(term) || lo(r.key).includes(term)),
        unlisted: browse ? unlisted : unlisted.filter(r => lo(r.key).includes(term)),
        browse,
      };
    })
    .filter(c => !term || c.browse || c.matched.length || c.unlisted.length);
});

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
// stats-38 style pass: Import is a real button over a hidden file input
// (was a disguised <label class="chip">) — and it must stay enabled with
// zero providers, since importing is how a fresh browser gets its data back.
const fileInput = ref(null);
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
    <p class="cell-sub mp-note">
      Your providers, stored only in this browser — keys are sent only to the
      base URL you set, arena scores are mirrored read-only, and
      <strong>Clear all</strong> wipes everything on demand.
    </p>

    <div class="mp-toolbar">
      <!-- stats-38 style pass: Buefy button vocabulary like every other page
           (primary CTA / default actions / outlined danger that fills when
           armed). Intent options below stay chips — they ARE selections. -->
      <b-button type="is-primary" size="is-small" icon-left="plus"
        aria-label="Add provider" @click="openAdd">Add provider</b-button>
      <span class="mp-spacer"></span>
      <b-button size="is-small" :disabled="!providers || !providers.length" @click="exportClicked">Export</b-button>
      <b-button size="is-small" @click="fileInput?.click()">Import</b-button>
      <input ref="fileInput" type="file" accept="application/json,.json"
        aria-label="Import providers JSON" style="display:none" @change="importClicked" />
      <b-button size="is-small" type="is-danger" :outlined="!armedClear"
        :disabled="!providers || !providers.length" @click="clearAllClicked">
        {{ armedClear ? 'Really clear everything?' : 'Clear all' }}
      </b-button>
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

    <p v-else-if="searchTerm && !cards.length" class="mp-msg" role="status">
      No provider rows match the search — clear the box above to see everything again.
    </p>

    <div v-for="c in cards" :key="c.p.id" class="panel-lab mp-card">
      <header class="mp-card-head">
        <div class="mp-id">
          <h2 class="mp-name">{{ c.p.label }}</h2>
          <div class="mp-meta">
            <span v-if="c.p.baseUrl" class="mp-url">{{ c.p.baseUrl }}</span>
            <span class="chip chip-quiet">{{ (c.p.models || []).length }} models</span>
            <span class="chip chip-quiet">{{ fmtSync(c.p.lastSyncAt) }}</span>
            <span v-if="c.p.intent" class="chip chip-quiet">focus: {{ INTENT_LABELS[c.p.intent] || c.p.intent }}</span>
          </div>
        </div>
        <div class="mp-actions-row">
          <b-button size="is-small" :aria-label="'Resync ' + c.p.label" :disabled="busy" @click="resync(c.p)">
            {{ c.p.mode === 'paste' ? 'Paste listing' : 'Resync' }}
          </b-button>
          <b-button size="is-small" :aria-label="'Edit ' + c.p.label" @click="openEdit(c.p)">Edit</b-button>
          <b-button size="is-small" type="is-danger" :outlined="armedDelete !== c.p.id"
            :aria-label="'Delete ' + c.p.label" @click="deleteClicked(c.p)">
            {{ armedDelete === c.p.id ? 'Really delete?' : 'Delete' }}
          </b-button>
        </div>
      </header>

      <p v-if="c.p.lastError" class="mp-err" role="alert">{{ c.p.lastError }}</p>

      <div v-if="c.p.lastSyncAt && !c.p.intent && !c.p.intentDismissed" class="mp-intent"
        role="group" aria-label="What do you want this provider for?">
        <span class="mp-intent-q">What do you want this provider for?</span>
        <button v-for="(lbl, key) in INTENT_LABELS" :key="key" class="chip" type="button"
          :aria-label="'Focus ' + lbl" @click="setIntent(c.p, key)">{{ lbl }}</button>
        <button class="chip chip-quiet" type="button" aria-label="Skip focus question" @click="skipIntent(c.p)">Skip</button>
      </div>

      <div v-if="!(c.p.models || []).length" class="mp-noModels">
        No listing yet — <button class="linklike" type="button" @click="resync(c.p)">sync now</button>
        ({{ c.p.mode === 'paste' ? 'paste a response' : 'fetch from the base URL' }}).
      </div>

      <template v-else-if="catalogIndex">
        <p class="mp-banner" role="status">
          <strong>{{ matchOf(c.p).stats.matched }} of {{ matchOf(c.p).stats.total }}</strong> chat models matched the arena catalog
          <template v-if="nonChatCount(c.p)">
            · {{ nonChatCount(c.p) }} non-chat (image / embedding) models {{ showNonChat.has(c.p.id) ? 'shown —' : 'hidden —' }}
            <button class="linklike" type="button" :aria-label="'Toggle non-chat models ' + c.p.label" @click="toggleNonChat(c.p.id)">
              {{ showNonChat.has(c.p.id) ? 'hide' : 'show' }}
            </button>
          </template>
        </p>

        <h3 class="mp-sec">On the arena <span class="chip chip-quiet">{{ c.matched.length }}</span></h3>
        <b-table class="mp-table mp-matched" :data="c.matched" :hoverable="true" :paginated="c.matched.length > 12" per-page="12">
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
        <p v-if="c.browse && !c.matched.length && !c.unlisted.length" class="mp-msg">
          This provider is named in the search — showing its full listing.
        </p>

        <b-collapse v-if="c.unlisted.length" class="mp-unlisted" :open="c.unlisted.length <= 8">
          <template #trigger="props">
            <button class="chip mp-unlisted-toggle" type="button" :aria-expanded="props ? props.open : null">
              {{ props.open ? '▾' : '▸' }} Unlisted on the arena ({{ c.unlisted.length }})
              <span class="mp-unlisted-hint">— reseller-only models, metadata only, honest dashes</span>
            </button>
          </template>
          <b-table class="mp-table mp-unlisted-table" :data="c.unlisted" :hoverable="true" :paginated="c.unlisted.length > 14" per-page="14">
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
                  :title="'in $' + props.row.price.in + ' / out $' + (props.row.price.out ?? '?') + ' per 1M tokens · as published by your provider' + (props.row.price.viaKeys ? ' · resolved via your custom pricing keys' : '')">
                  {{ fmtUsd(providerPrice(props.row).blend) }}
                </span>
                <span v-else class="mp-dash" title="No price published for this listing id under the standard keys or your custom pricing keys.">—</span>
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

    <b-modal v-model="modalOpen" :width="560" aria-role="dialog" aria-label="Provider form">
      <div class="panel-lab mp-modal">
        <h3 class="mp-modal-title">
          {{ editingId ? (formMode === 'paste' ? 'Paste a fresh listing' : 'Edit provider') : 'Add a provider' }}
        </h3>
        <div v-if="!editingId" class="mp-modes" role="radiogroup" aria-label="Connection mode">
          <b-radio v-model="formMode" name="mp-mode" native-value="fetch" size="is-small">Fetch from URL</b-radio>
          <b-radio v-model="formMode" name="mp-mode" native-value="paste" size="is-small">Paste listing</b-radio>
        </div>
        <b-field label="Name">
          <b-input v-model="form.label" aria-label="Provider label" placeholder="UnoRouter, my gateway…" maxlength="60" />
        </b-field>
        <b-field v-if="formMode === 'fetch'" label="Base URL">
          <b-input v-model="form.baseUrl" aria-label="Provider base URL" placeholder="https://api.unorouter.com/v1" />
        </b-field>
        <b-field label="API key (optional)"
          message="Stored only in this browser's localStorage; sent only to the base URL above. For private keys, prefer paste mode — the key never enters the app.">
          <b-input v-model="form.key" type="password" aria-label="API key optional" password-reveal
            placeholder="Bearer key — stored only in this browser" autocomplete="off" />
        </b-field>
        <b-field v-if="formMode === 'paste'" label="Paste the /models response"
          message="Full JSON or just one model id per line.">
          <b-input v-model="form.paste" type="textarea" rows="8" aria-label="Paste listing"
            placeholder='curl -H "Authorization: Bearer sk-…" https://api.unorouter.com/v1/models  →  paste the output here' />
        </b-field>

        <!-- stats-51: custom pricing keys — two dot-paths into each model's
             raw listing entry + an explicit unit. Resolved at RENDER time
             (keys are a lens; editing them never needs a re-sync) with a
             live preview so the extraction is verifiable BEFORE saving. -->
        <div class="mp-keys" role="group" aria-label="Pricing keys">
          <p class="mp-keys-title">Pricing keys (optional)</p>
          <p class="mp-keys-hint">
            Provider publishes prices under non-standard keys? Point us at them —
            a dot path into each model entry, e.g. <code>pricing.input_per_1M_tokens</code>;
            array indexes work too (<code>tiers.0.input</code>). Sides without a hit fall
            back to the standard prompt/completion pricing.
          </p>
          <div class="mp-keys-row">
            <b-field label="Input price key" class="mp-key-field" custom-class="mp-key-label">
              <b-input v-model="form.keyIn" size="is-small" aria-label="Input price key path"
                placeholder="pricing.input_per_1M_tokens" />
            </b-field>
            <b-field label="Output price key" class="mp-key-field" custom-class="mp-key-label">
              <b-input v-model="form.keyOut" size="is-small" aria-label="Output price key path"
                placeholder="pricing.output_per_1M_tokens" />
            </b-field>
            <b-field label="Unit" class="mp-unit-field" custom-class="mp-key-label" @click="unitTouched = true">
              <div class="mp-unit-radios">
                <b-radio v-model="form.unit" name="mp-unit" native-value="token" size="is-small">per-token</b-radio>
                <b-radio v-model="form.unit" name="mp-unit" native-value="1m" size="is-small">per-1M</b-radio>
              </div>
            </b-field>
          </div>
          <div v-if="keysPreview" class="mp-keys-preview" :class="{ 'is-warn': keysPreview.keys && keysPreview.summary.viaKeys === 0 }" aria-live="polite">
            <template v-if="keysPreview.keys">
              <strong>{{ keysPreview.summary.viaKeys }} of {{ keysPreview.summary.total }}</strong> listed models priced via your keys
              <span v-if="keysPreview.summary.samples.length">
                · sample <code>{{ keysPreview.summary.samples[0].id }}</code> → in {{ fmtSample(keysPreview.summary.samples[0].in) }} /
                out {{ fmtSample(keysPreview.summary.samples[0].out) }} per 1M</span>
              <span v-if="keysPreview.summary.missCount"> · {{ keysPreview.summary.missCount }} entr{{ keysPreview.summary.missCount === 1 ? 'y falls' : 'ies fall' }} back to standard prompt/completion pricing</span>
              <span v-if="keysPreview.summary.badCount"> · {{ keysPreview.summary.badCount }} key hit{{ keysPreview.summary.badCount === 1 ? '' : 's' }} with a non-numeric value — left empty, never guessed</span>
              <span v-if="keysPreview.summary.legacy"> · some stored entries predate raw capture — re-sync this provider to apply keys to them</span>
            </template>
            <template v-else>Custom pricing keys off — standard OpenRouter prompt/completion pricing only.</template>
          </div>
          <div v-if="!editingId && formMode === 'fetch'" class="mp-keys-test">
            <b-button size="is-small" :disabled="!form.baseUrl.trim() || keyTestBusy" :loading="keyTestBusy"
              aria-label="Test pricing keys" @click="testKeys">Test keys on the live listing</b-button>
            <span v-if="keyTestError" class="mp-keys-test-err" role="alert">{{ keyTestError }}</span>
          </div>
        </div>

        <p v-if="formError" class="mp-err" role="alert">{{ formError }}</p>
        <footer class="mp-modal-foot">
          <b-button size="is-small" @click="modalOpen = false">Cancel</b-button>
          <b-button size="is-small" type="is-primary" :loading="busy"
            aria-label="Save provider" @click="submitModal">
            {{ editingId ? 'Save' : (formMode === 'paste' ? 'Import listing' : 'Fetch & add') }}
          </b-button>
        </footer>
      </div>
    </b-modal>
  </section>
</template>

<style scoped>
.mp-page { display: flex; flex-direction: column; gap: 16px; }
.mp-note { margin: 0; max-width: 88ch; }
.mp-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mp-spacer { flex: 1; }
.mp-msg { margin: 0; color: var(--ink-2, #556); font-size: 0.92em; }
/* stats-38 style pass: every other page pads its panel-lab cards inline
   (padding: 1.2rem) — these surfaces were the only ones without, which is
   exactly the "missing paddings" Ibrahim flagged. */
.mp-empty { padding: 1.4rem 1.2rem; }
.mp-empty h2 { margin: 0 0 10px; font-size: 1.1em; }
.mp-empty ol { margin: 0; padding-left: 20px; display: grid; gap: 8px; color: var(--ink-2, #556); }
.mp-card { display: flex; flex-direction: column; gap: 12px; padding: 1.2rem; }
.mp-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.mp-name { margin: 0; font-size: 1.05em; }
.mp-meta { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 4px; }
.mp-url { font-family: ui-monospace, monospace; font-size: 0.86em; color: var(--ink-2, #556); }
.mp-actions-row { display: flex; gap: 8px; flex-wrap: wrap; }
.mp-err { margin: 0; padding: 8px 10px; border-radius: 8px; background: rgba(176, 67, 60, 0.1); color: #b0433c; font-size: 0.92em; }
.mp-intent { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 12px; border-radius: 8px; background: rgba(75, 107, 251, 0.08); font-size: 0.92em; }
.mp-intent-q { font-weight: 600; }
.mp-noModels { color: var(--ink-2, #556); font-size: 0.94em; }
.linklike { background: none; border: none; padding: 0; color: var(--acc, #4b6bfb); cursor: pointer; text-decoration: underline; font: inherit; }
.mp-banner { margin: 0 0 2px; color: var(--ink-2, #556); font-size: 0.94em; }
.mp-sec { margin: 6px 0 2px; font-size: 0.95em; display: flex; align-items: center; gap: 8px; }
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
.mp-modal { display: flex; flex-direction: column; gap: 14px; padding: 1.4rem 1.25rem; }
.mp-modal-title { margin: 0; font-size: 1.05em; }
.mp-modes { display: flex; gap: 16px; font-size: 0.94em; align-items: center; padding: 2px 0; }
.mp-modal-foot { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; }
/* stats-51: pricing-keys section */
.mp-keys { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px dashed rgba(127,127,127,.35); border-radius: 10px; }
.mp-keys-title { margin: 0; font-weight: 600; font-size: 0.94em; }
.mp-keys-hint { margin: 0; font-size: 0.86em; color: var(--ink-2, #556); }
.mp-keys-hint code { font-size: 0.95em; }
.mp-keys-row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
.mp-key-field { flex: 1 1 170px; margin: 0; }
.mp-unit-field { flex: 0 0 auto; margin: 0; }
.mp-key-label { font-size: 0.85em; }
.mp-unit-radios { display: flex; gap: 10px; align-items: center; }
.mp-keys-preview { font-size: 0.88em; color: var(--ink-2, #556); padding: 8px 10px; border-radius: 8px; background: rgba(75, 107, 251, 0.07); }
.mp-keys-preview.is-warn { background: rgba(176, 67, 60, 0.08); color: #b0433c; }
.mp-keys-preview code { font-family: ui-monospace, monospace; }
.mp-keys-test { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mp-keys-test-err { font-size: 0.86em; color: #b0433c; }
/* the b-table wrapper's own border sits INSIDE the padded card now — drop
   its shadow so the nesting doesn't read as a second floating card */
.mp-table :deep(.table-wrapper) { box-shadow: none; }
</style>
