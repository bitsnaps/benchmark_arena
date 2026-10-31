<script setup>
// ── Playground: chat with any model the catalog or your own gateways serve ──
// Browser → provider, directly (static site, no proxy): the request goes
// to the selected provider's base URL with that provider's key. Models
// come from EVERYWHERE the arena knows: the full public provider catalog
// (labs, cloud, serverless, aggregators) browsable without setup, plus
// the user's own My Providers listings. Picking a catalog model opens a
// setup modal that collects whatever is missing (base URL, API key) and
// links a real My Providers entry. Arena joins (score / price / context)
// are read-only. Conversation + settings persist in this browser only;
// keys are never copied into the Playground store.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useData } from '../stores/data.js';
import { useMyProviders, addProvider, setModels } from '../stores/myProviders.js';
import { useProviders } from '../stores/providers.js';
import { usePlayground } from '../stores/playground.js';
import { buildCatalogIndex } from '../lib/myProviders.js';
import {
  buildPlaygroundGroups, buildCatalogGroups, catalogProviderEntry, stripCatalogPrefix,
  capGroupItems, providerOptions, filterByProvider, filterGroups, findOption,
  KNOWN_ENDPOINTS,
} from '../lib/playgroundModels.js';
import { buildPayload, sendChat, testConnection, estimateTokens, estimateCost, fmtCost, fmtMs } from '../lib/chat.js';
import { renderMarkdown } from '../lib/miniMarkdown.js';
import { fmtScore, scoreColor, fmtUsd, fmtCtx } from '../lib/format.js';

const route = useRoute();
const router = useRouter();
const { ensureLoaded, rawData, pivotAll, modelsMeta, scoreForModel, priceFor, isOlder, isUnranked, modelSlug } = useData();
const { providers, ensureMyProvidersLoaded } = useMyProviders();
const { rawData: providerCatalogRaw, ensureProvidersLoaded } = useProviders();
const {
  conversations, activeId, ui, persistent, ready, settings, messages,
  ensurePlaygroundLoaded, setSettings, setUi, addMessage, updateMessage, truncateFrom,
  newConversation, switchTo, renameConversation, deleteConversation, deleteAllHistory, flushPersist,
} = usePlayground();

ensurePlaygroundLoaded();
onMounted(() => { ensureMyProvidersLoaded(); ensureProvidersLoaded(); ensureLoaded(); });

// ── Model options ─────────────────────────────────────────────────────
const catalogIndex = computed(() =>
  (rawData.value ? buildCatalogIndex(pivotAll.value.filter(r => !r.unranked) || [], modelsMeta.value || {}) : null));
const rowByName = computed(() => {
  const m = new Map();
  for (const r of pivotAll.value || []) if (r?.name) m.set(r.name, r);
  return m;
});
const groups = computed(() => {
  const ctx = {
    catalogIndex: catalogIndex.value, rowByName: rowByName.value,
    scoreForModel, priceFor, isOlder, isUnranked, slugOf: modelSlug,
  };
  const linkedCatalogIds = (providers.value || []).map(p => p.catalogId).filter(Boolean);
  return [
    ...buildPlaygroundGroups((providers.value || []).map(p => ({ ...p, custom: true })), ctx), // user's own — chat-ready
    ...buildCatalogGroups(providerCatalogRaw.value?.providers || [], linkedCatalogIds, ctx), // browsable, setup on chat
  ];
});
const totalModels = computed(() => groups.value.reduce((n, g) => n + g.items.length, 0));
const providersReady = computed(() => providers.value !== null);
const catalogProviders = computed(() => providerCatalogRaw.value?.providers || []);

// Free-text models (Ibrahim): an id no listing carries still resolves — a
// synthetic option binds it to the selected provider so it is sent exactly
// as typed. Arena joins are honestly empty for it (no score, no price,
// plain id on the card).
const selected = computed(() => {
  const hit = findOption(groups.value, settings.value.providerId, settings.value.modelId);
  if (hit) return hit;
  const g = groups.value.find(g => g.providerId === settings.value.providerId);
  if (!g || !settings.value.modelId) return null;
  return {
    key: g.providerId + '\u0001' + settings.value.modelId,
    providerId: g.providerId, providerLabel: g.label,
    catalogId: g.catalogId || null, kind: g.kind || null, custom: !!g.custom,
    modelId: settings.value.modelId, arenaName: null, slug: null,
    score: null, older: false, ctx: null, free: false, price: null,
  };
});
const selectedProvider = computed(() => (providers.value || []).find(p => p.id === settings.value.providerId) || null);
// Catalog picks bind to a 'cat:…' group id until the setup modal links a
// real My Providers entry — no entry means the request has no destination.
const needsSetup = computed(() => !!selected.value && !selectedProvider.value);

// ── Provider filter — type-to-filter autocomplete, flat list ──────
// Replaces the native select (its optgroups had no way to filter by typing).
// The stored filter commits on select / clear only, so typing never flips
// the model list underneath; blur restores the committed label.
const providerFilter = computed({
  get: () => ui.value.providerFilter,
  set: (v) => setUi({ providerFilter: String(v || '') }),
});
const providerOptionsList = computed(() => {
  const all = providerOptions(groups.value);
  const q = String(provFilterText.value || '').toLowerCase().trim();
  if (!q) return all;
  return all.filter(o => o.label.toLowerCase().includes(q)); // type-to-filter
});
const totalProviders = computed(() => groups.value.length);
const allProvidersPlaceholder = computed(() => `All providers (${totalProviders.value})`);
const committedFilterLabel = computed(() => {
  const id = providerFilter.value;
  if (!id) return '';
  return groups.value.find(g => g.providerId === id)?.label || '';
});
const provFilterText = ref('');
watch(committedFilterLabel, (v) => { provFilterText.value = v; }, { immediate: true });
function onProvType(v) {
  provFilterText.value = v;
  if (!String(v || '').trim()) setUi({ providerFilter: '' }); // cleared → All providers
}
function onProvPick(opt) {
  if (!opt) return;
  setUi({ providerFilter: opt.id });
  provFilterText.value = opt.label;
}
function onProvBlur() { provFilterText.value = committedFilterLabel.value; }
const visibleGroups = computed(() => filterByProvider(groups.value, providerFilter.value));
const modelCount = computed(() => visibleGroups.value.reduce((n, g) => n + g.items.length, 0));
const pickedOutsideFilter = computed(() => !!selected.value && !!providerFilter.value && selected.value.providerId !== providerFilter.value);

const query = ref('');
const filtered = computed(() => filterGroups(visibleGroups.value, query.value));
const optionLabel = (o) => (o ? o.modelId + ' · ' + o.providerLabel : '');

function pick(o) {
  if (!o) return;
  setSettings({ providerId: o.providerId, modelId: o.modelId });
  query.value = optionLabel(o);
  pickerOpen.value = false;
  // Catalog models are browsable without setup; chatting from one needs a
  // base URL + key, so the setup modal opens right away (send is guarded)
  // — once per provider per session, "Not now" is respected afterwards.
  if (!o.custom && !selectedProvider.value && !setupDismissed.has(o.catalogId)) openSetup(o);
  else nextTick(() => composerEl.value?.focus());
  // The active conversation now carries the model binding; keep the URL
  // clean so a reload restores THIS chat instead of opening a fresh one.
  if (route.query.p || route.query.m) router.replace({ query: {} });
}

// Free-text pick: the typed text becomes the model id on the CURRENT
// provider — new or unlisted models need no catalog update and no modal.
function pickCustom(text) {
  const t = String(text || '').trim();
  if (!t) return;
  setSettings({ modelId: t });
  pickerOpen.value = false;
  nextTick(() => {
    if (selected.value) query.value = optionLabel(selected.value);
    composerEl.value?.focus();
  });
  if (route.query.p || route.query.m) router.replace({ query: {} });
}
const currentProviderLabel = computed(() =>
  groups.value.find(g => g.providerId === settings.value.providerId)?.label || 'the current provider');

// ── Model picker (hand-rolled, deterministic) ─────────────────────────
// Replaces b-autocomplete: option buttons use mousedown.prevent, so the
// input never loses focus and a click ALWAYS selects (the old picker
// could silently drop the first click — Ibrahim had to select twice).
// The list is capped at PICK_CAP rows; the footer counts the rest.
const PICK_CAP = 120;
const pickerOpen = ref(false);
const activeIdx = ref(0);
const pickerFocused = ref(false);
const pickerRows = computed(() => {
  const { groups: capped, hidden } = capGroupItems(filtered.value, PICK_CAP);
  const rows = [];
  let idx = 0;
  // The free-text row: typed text no listing matches becomes a pickable
  // first row. Only when a provider is bound — otherwise there is nowhere
  // to send it.
  const q = query.value.trim();
  if (q && settings.value.providerId
    && !filtered.value.some(g => g.items.some(i => i.modelId.toLowerCase() === q.toLowerCase()))) {
    rows.push({ type: 'custom', key: 'custom:' + q, text: q, idx: idx++ });
  }
  for (const g of capped) {
    rows.push({ type: 'group', key: 'g:' + g.providerId, label: g.label });
    for (const it of g.items) rows.push({ type: 'item', key: it.key, opt: it, idx: idx++ });
  }
  return { rows, shown: idx, hidden };
});

function pickerFocus() { query.value = ''; pickerOpen.value = true; activeIdx.value = 0; }
// A click on the already-focused input fires no focus event — without this,
// reopening the list after a pick would need a click elsewhere first.
function pickerMousedown() {
  if (!pickerOpen.value && pickerFocused.value) {
    pickerOpen.value = true;
    query.value = '';
    activeIdx.value = 0;
  }
}
function onPickerFocusin() { pickerFocused.value = true; }
function onPickerFocusout() {
  pickerFocused.value = false;
  // Focus may hop to the scrollbar or a button briefly; only close when it
  // really left, and restore the selected model's label when it does.
  setTimeout(() => {
    if (pickerFocused.value) return;
    pickerOpen.value = false;
    if (selected.value) query.value = optionLabel(selected.value);
  }, 120);
}
function pickerKey(e) {
  if (e.key === 'Escape') {
    if (pickerOpen.value) {
      e.preventDefault();
      pickerOpen.value = false;
      if (selected.value) query.value = optionLabel(selected.value);
    }
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!pickerOpen.value) { pickerOpen.value = true; return; }
    const last = Math.max(0, pickerRows.value.shown - 1);
    activeIdx.value = e.key === 'ArrowDown' ? Math.min(activeIdx.value + 1, last) : Math.max(activeIdx.value - 1, 0);
    nextTick(() => document.querySelector('.pg-pick-item.is-active')?.scrollIntoView({ block: 'nearest' }));
    return;
  }
  if (e.key === 'Enter' && pickerOpen.value) {
    const row = pickerRows.value.rows.find(r => r.type === 'item' && r.idx === activeIdx.value);
    if (row) { e.preventDefault(); pick(row.opt); }
  }
}

// ── Setup modal (catalog models: collect what a request needs) ────────
const setup = ref(null);
// "Not now" is remembered for the browser session: dismissing the modal
// must not make browsing the catalog feel like whack-a-mole. The card
// hint, the Set up button and the send guard always still offer it.
const setupDismissed = new Set();
const testState = ref(null); // null | { busy, ok, msg }
const setupOpen = computed({
  get: () => setup.value !== null,
  set: (v) => {
    if (!v) {
      if (setup.value) setupDismissed.add(setup.value.catalogId);
      setup.value = null;
    }
  },
});
function openSetup(opt) {
  if (!opt?.catalogId) return;
  setup.value = {
    catalogId: opt.catalogId,
    label: opt.providerLabel,
    baseUrl: KNOWN_ENDPOINTS[opt.catalogId] || '',
    key: '',
    modelId: opt.modelId,
    // Labs prefix their catalog ids ('gemini/…') while their API wants the
    // bare id; aggregators keep the prefix (it IS the API id there). The
    // Test button verifies the guess against the provider's own list.
    strip: opt.kind === 'first-party' && opt.modelId.includes('/'),
  };
  testState.value = null;
}

// What Save will actually send and persist: the checkbox rewrites the whole
// seeded listing, so the picked id gets the same treatment.
const setupWillSend = computed(() => {
  const s = setup.value;
  if (!s) return '';
  return s.strip && s.modelId.includes('/') ? s.modelId.slice(s.modelId.indexOf('/') + 1) : s.modelId;
});

// "Test connection": GET the provider's model list with the entered key
// BEFORE anything is saved, then reconcile the id forms — when the
// provider's own list says the other form is the right one, the checkbox
// flips automatically.
async function runTest() {
  const s = setup.value;
  if (!s || !s.baseUrl.trim() || testState.value?.busy) return;
  testState.value = { busy: true, ok: false, msg: '' };
  const r = await testConnection({ baseUrl: s.baseUrl, key: s.key });
  if (setup.value !== s) return; // modal closed while testing
  if (r.ok && Array.isArray(r.models)) {
    const send = setupWillSend.value;
    const listed = r.models.some(m => m === send);
    const altListed = send !== s.modelId && r.models.some(m => m === s.modelId);
    if (altListed) {
      s.strip = !s.strip;
      testState.value = { busy: false, ok: true, msg: `${r.message} The provider lists ${s.modelId} — switched the prefix option for you.` };
    } else if (!listed) {
      testState.value = { busy: false, ok: true, msg: `${r.message} ${send} is not in the list — new or unlisted IDs are sent exactly as typed.` };
    } else {
      testState.value = { busy: false, ok: true, msg: `${r.message} ${send} is listed.` };
    }
  } else {
    testState.value = { busy: false, ok: r.ok === true, msg: r.message };
  }
}

function saveSetup() {
  const s = setup.value;
  if (!s || !s.baseUrl.trim()) return;
  const modelId = setupWillSend.value;
  // A real My Providers entry backs the chat: base URL + key live there
  // (never in the Playground store), seeded with the provider's catalog
  // models so the whole group stays chat-ready after one setup. The strip
  // option rewrites EVERY seeded id (Ibrahim: "for all models") — what the
  // picker shows is exactly what the request sends.
  const entry = addProvider({ label: s.label, baseUrl: s.baseUrl.trim(), key: s.key.trim(), mode: 'catalog', catalogId: s.catalogId });
  const prov = catalogProviders.value.find(p => p.id === s.catalogId);
  let listing = catalogProviderEntry(prov || { id: s.catalogId, name: s.label, models: [] }).models;
  if (s.strip) listing = stripCatalogPrefix(listing);
  setModels(entry.id, listing);
  setSettings({ providerId: entry.id, modelId });
  setup.value = null;
  nextTick(() => composerEl.value?.focus());
}

// ── Settings ──────────────────────────────────────────────────────────
const customTemp = computed({
  get: () => settings.value.temperature !== null,
  set: (on) => setSettings({ temperature: on ? 0.7 : null }),
});
const tempValue = computed({
  get: () => settings.value.temperature ?? 0.7,
  set: (v) => setSettings({ temperature: Math.round(Number(v) * 100) / 100 }),
});
const maxTokensText = computed({
  get: () => (settings.value.maxTokens == null ? '' : String(settings.value.maxTokens)),
  set: (v) => {
    const n = parseInt(String(v).replace(/\D/g, ''), 10);
    setSettings({ maxTokens: Number.isFinite(n) && n > 0 ? n : null });
  },
});
const systemText = computed({
  get: () => settings.value.system,
  set: (v) => setSettings({ system: v }),
});
const streamOn = computed({
  get: () => settings.value.stream,
  set: (v) => setSettings({ stream: !!v }),
});
const insecure = computed(() => {
  const b = selectedProvider.value?.baseUrl || '';
  return /^http:\/\//i.test(b) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(b);
});

// ── Conversation ──────────────────────────────────────────────────────
const draft = ref('');
const composerEl = ref(null);
const scroller = ref(null);
const busy = ref(false);
let controller = null;

// Deep link (?p=&m=): always open a FRESH conversation pre-bound to that
// model, then strip the query so reloading the same URL is an explicit new
// chat rather than a silent duplicate. Blocked while a reply streams —
// switching chats mid-stream would scatter the reply (decided: lock).
let deepHandled = '';
// `ready` is a source on purpose: the default bind and deep links must wait
// for the IDB boot — setSettings before that no-ops and `groups` alone may
// never change again (the boot-vs-listings race). `busy` too: a deep link
// that arrives while a reply streams must bind WHEN the stream ends, not
// never (single-fire watch — the stream's end is its only retry).
watch([groups, ready, busy, () => route.query.p, () => route.query.m], () => {
  if (!ready.value) return;
  const { p, m } = route.query;
  if (!p || !m) { deepHandled = ''; }
  else if (deepHandled !== String(p) + '\u0001' + String(m)) {
    const hit = findOption(groups.value, String(p), String(m));
    if (hit && !busy.value) {
      deepHandled = String(p) + '\u0001' + String(m);
      newConversation({ providerId: hit.providerId, modelId: hit.modelId });
      router.replace({ query: {} });
    }
  }
  // Otherwise default to the best-rated model once listings are in.
  if (!route.query.p && !selected.value && groups.value.length) {
    const best = groups.value.flatMap(g => g.items).sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0];
    if (best) setSettings({ providerId: best.providerId, modelId: best.modelId });
  }
  if (selected.value && !query.value) query.value = optionLabel(selected.value);
}, { immediate: true });

const railOpen = computed({
  get: () => ui.value.railOpen !== false, // default open
  set: (v) => setUi({ railOpen: !!v }),
});

// ── History (all chats live in IndexedDB, this browser only) ──────────
const sortedConvs = computed(() =>
  conversations.value.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))));

function relTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 7 * 86400) return Math.floor(s / 86400) + 'd';
  return new Date(iso).toLocaleDateString();
}

function openConv(id) { if (!busy.value || id === activeId.value) switchTo(id); }

const renamingId = ref('');
const renameText = ref('');
function startRename(c) { renamingId.value = c.id; renameText.value = c.title; }
function commitRename(c) {
  if (renamingId.value !== c.id) return;
  renameConversation(c.id, renameText.value);
  renamingId.value = '';
}

function removeConv(c) {
  if (busy.value) return;
  if (!window.confirm(`Delete “${c.title}”? This cannot be undone.`)) return;
  deleteConversation(c.id);
}

function newChat() {
  if (busy.value) stop();
  newConversation({ ...settings.value }); // fresh thread, same model + settings
  nextTick(() => {
    if (selected.value) query.value = optionLabel(selected.value);
    composerEl.value?.focus();
  });
}

function clearAllHistory() {
  if (busy.value) return;
  if (!window.confirm('Delete ALL saved chats? This cannot be undone.')) return;
  deleteAllHistory();
  const best = groups.value.flatMap(g => g.items).sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0];
  if (best) setSettings({ providerId: best.providerId, modelId: best.modelId });
  nextTick(() => composerEl.value?.focus());
}

// ── Message edit / delete ────────────────────────────────────────────
// User messages: “Edit” reloads the composer and truncates the turn, so
// sending re-runs it (existing behavior). Assistant messages: edit in
// place. Delete always removes the message AND everything after it —
// a user turn without its reply would be an orphan.
const editingId = ref('');
const editingText = ref('');
function startEditAssistant(m) { editingId.value = m.id; editingText.value = m.content; }
function cancelEdit() { editingId.value = ''; editingText.value = ''; }
function saveEditAssistant() {
  const id = editingId.value;
  if (!id || !messages.value.some(m => m.id === id)) return cancelEdit();
  updateMessage(id, { content: editingText.value, error: null, stopped: false });
  cancelEdit();
}
function delMsg(m) {
  if (busy.value) return;
  truncateFrom(m.id);
  if (editingId.value) cancelEdit();
}

const STARTERS = [
  'Explain the difference between a process and a thread, with an example.',
  'Write a Python function that merges overlapping intervals, with tests.',
  'Summarise the trade-offs of SQL vs. NoSQL for a small SaaS in 5 bullets.',
  'A bat and a ball cost $1.10 in total. The bat costs $1 more than the ball. How much is the ball?',
];

const canSend = computed(() => !!selected.value && !needsSetup.value && !busy.value && draft.value.trim().length > 0);
const draftTokens = computed(() => estimateTokens(draft.value));
const lastAssistantId = computed(() => {
  for (let i = messages.value.length - 1; i >= 0; i--) if (messages.value[i].role === 'assistant') return messages.value[i].id;
  return null;
});

function historyForRequest() {
  return messages.value.filter(m => !m.pending && !m.error && m.content);
}

async function runAssistant() {
  const opt = selected.value;
  const prov = selectedProvider.value;
  if (opt && !prov) return openSetup(opt); // catalog pick without setup — ask, don't fail
  if (!opt || !prov) return;
  const history = historyForRequest();
  const payload = buildPayload({
    model: opt.modelId,
    messages: history,
    system: settings.value.system,
    temperature: settings.value.temperature,
    maxTokens: settings.value.maxTokens,
    stream: settings.value.stream,
  });
  const aid = addMessage({
    role: 'assistant', content: '', reasoning: '', pending: true,
    model: opt.modelId, provider: opt.providerLabel, arenaName: opt.arenaName, slug: opt.slug,
  });
  busy.value = true;
  controller = new AbortController();
  const t0 = performance.now();
  let ttft = null, content = '', reasoning = '';
  const metaNow = (usage) => {
    const total = performance.now() - t0;
    const est = !usage || usage.input == null || usage.output == null;
    const u = est
      ? { input: estimateTokens(settings.value.system + history.map(m => m.content).join('\n')), output: estimateTokens(content + reasoning) }
      : usage;
    const genMs = ttft == null ? null : total - ttft;
    return {
      ttft, total, usage: u, estimated: est,
      tps: genMs && genMs > 50 && u.output ? u.output / (genMs / 1000) : null,
      cost: estimateCost(u, opt.price), priceSource: opt.price?.source || null,
    };
  };
  try {
    const { usage, finish } = await sendChat({
      baseUrl: prov.baseUrl, key: prov.key, payload, signal: controller.signal,
      onDelta(c) {
        if (ttft === null) ttft = performance.now() - t0;
        content += c.content || '';
        reasoning += c.reasoning || '';
        updateMessage(aid, { content, reasoning }, { persist: false });
        stickToBottom();
      },
    });
    if (!content && !reasoning) throw new Error('The provider finished without returning any text' + (finish ? ` (finish reason: ${finish})` : '') + '.');
    updateMessage(aid, { pending: false, content, reasoning, finish, meta: metaNow(usage) });
  } catch (e) {
    if (e?.name === 'AbortError') updateMessage(aid, { pending: false, content, reasoning, stopped: true, meta: metaNow(null) });
    else updateMessage(aid, { pending: false, content, reasoning, error: e?.message || String(e) });
  } finally {
    // Durably write the settled reply before the spinner clears — a tab
    // closed right after the reply loses nothing.
    await flushPersist();
    busy.value = false;
    controller = null;
    stickToBottom(true);
  }
}

async function send(text = draft.value) {
  const t = String(text || '').trim();
  if (!t || busy.value || !selected.value) return;
  if (needsSetup.value) return openSetup(selected.value);
  addMessage({ role: 'user', content: t });
  draft.value = '';
  stickToBottom(true);
  await runAssistant();
}

function stop() { controller?.abort(); }

function regenerate(id) {
  if (busy.value) return;
  truncateFrom(id);
  runAssistant();
}

function editUser(m) {
  if (busy.value) return;
  draft.value = m.content;
  truncateFrom(m.id);
  nextTick(() => { composerEl.value?.focus(); autosize(); });
}

const copiedId = ref(null);
async function copy(m) {
  try {
    await navigator.clipboard.writeText(m.content);
    copiedId.value = m.id;
    setTimeout(() => { if (copiedId.value === m.id) copiedId.value = null; }, 1500);
  } catch { /* clipboard blocked — nothing to do */ }
}

function onKey(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (canSend.value) send();
  }
}

function autosize() {
  const el = composerEl.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 240) + 'px';
}
watch(draft, () => nextTick(autosize));

// Follow the stream only while the reader is already at the bottom.
function stickToBottom(force = false) {
  nextTick(() => {
    const el = scroller.value;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (force || near) el.scrollTop = el.scrollHeight;
  });
}
onMounted(() => stickToBottom(true));
onBeforeUnmount(() => controller?.abort());

const md = (s) => renderMarkdown(s);
const tokLabel = (m) => {
  const u = m.meta?.usage;
  if (!u) return '';
  const pre = m.meta.estimated ? '≈' : '';
  return `${pre}${u.input ?? '?'} in · ${pre}${u.output ?? '?'} out`;
};
const costTitle = (m) => (m.meta?.priceSource === 'provider'
  ? 'Estimated from the price your provider publishes in its listing'
  : 'Estimated from the arena reference price (AA / OpenRouter list) — your provider may charge differently')
  + (m.meta?.estimated ? '. Token counts are estimated (the provider sent no usage block).' : '.');
</script>

<template>
  <section class="pg-page">
    <div class="page-head">
      <div class="kicker">Chat · straight from your browser to your provider</div>
      <h1 class="section-title">Playground</h1>
      <p class="section-sub">
        Talk to any chat model — every lab, provider and gateway in the arena catalog plus your own My Providers
        entries, side by side with what the arena knows about each one: score, price and context. Requests go directly
        to the provider you pick, with your key; nothing passes through us.
      </p>
    </div>

    <!-- No providers yet: explain where models come from -->
    <div v-if="providersReady && !totalModels" class="panel-lab pg-empty" data-test="pg-empty">
      <i class="fas fa-plug pg-empty-icon" aria-hidden="true"></i>
      <h2 class="pg-empty-title">Connect a provider to start chatting</h2>
      <p class="muted">
        The Playground chats with models from the arena's provider catalog and your <strong>My Providers</strong>
        entries — any OpenAI-compatible endpoint (OpenRouter, OpenAI, Groq, a self-hosted gateway…). Add one with its
        base URL and key, sync its model list, and every chat model it serves shows up here.
      </p>
      <router-link class="button is-primary is-small" :to="{ name: 'providers', query: { view: 'mine' } }">
        <i class="fas fa-plus" aria-hidden="true"></i>&nbsp; Add a provider
      </router-link>
      <p class="pg-fine">Keys stay in this browser and are sent only to the base URL you set.</p>
    </div>

    <div v-else-if="!ready" class="panel-lab pg-empty" data-test="pg-loading">
      <p class="muted">Loading your chats…</p>
    </div>

    <div v-else-if="providersReady" class="pg-grid" :class="{ 'rail-closed': !railOpen }">
      <!-- ── Settings rail ── -->
      <aside class="panel-lab pg-rail" aria-label="Playground settings">
        <p v-if="!persistent" class="pg-warn" data-test="pg-volatile">
          <i class="fas fa-triangle-exclamation" aria-hidden="true"></i>
          Private browsing — history won't be saved in this session.
        </p>

        <!-- History: every chat lives in IndexedDB, this browser only -->
        <div class="pg-hist-head">
          <div class="lbl">History</div>
          <button type="button" class="pg-act" data-test="pg-new-chat" :disabled="busy" title="Start a new chat (keeps the current model)" @click="newChat">
            <i class="fas fa-plus" aria-hidden="true"></i><span class="sr-only">New chat</span>
          </button>
        </div>
        <div class="pg-hist" role="list">
          <div v-for="c in sortedConvs" :key="c.id" class="pg-hist-item" :class="{ active: c.id === activeId }" role="listitem"
            :data-test="c.id === activeId ? 'pg-hist-active' : 'pg-hist-item'">
            <input v-if="renamingId === c.id" v-model="renameText" class="input is-small pg-rename" aria-label="Chat title"
              @keydown.enter.prevent="commitRename(c)" @keydown.esc="renamingId = ''" @blur="commitRename(c)" />
            <template v-else>
              <button type="button" class="pg-hist-open" :disabled="busy && c.id !== activeId"
                :title="busy && c.id !== activeId ? 'Wait for the reply to finish' : c.title" @click="openConv(c.id)">
                <span class="pg-hist-title">{{ c.title }}</span>
                <span class="pg-hist-time">{{ relTime(c.updatedAt) }}</span>
              </button>
              <span class="pg-actions">
                <button type="button" class="pg-act" title="Rename chat" @click="startRename(c)"><i class="fas fa-pen" aria-hidden="true"></i><span class="sr-only">Rename</span></button>
                <button type="button" class="pg-act" title="Delete chat" @click="removeConv(c)"><i class="fas fa-trash-can" aria-hidden="true"></i><span class="sr-only">Delete chat</span></button>
              </span>
            </template>
          </div>
        </div>
        <button v-if="sortedConvs.length > 1" type="button" class="pg-hist-clear" data-test="pg-clear-all" :disabled="busy" @click="clearAllHistory">
          <i class="fas fa-trash-can" aria-hidden="true"></i> Delete all history
        </button>

        <div class="pg-sep"></div>

        <div class="lbl">Provider</div>
        <b-autocomplete v-model="provFilterText" :data="providerOptionsList" field="label" size="is-small"
          icon="filter" clearable keep-first open-on-focus :placeholder="allProvidersPlaceholder"
          data-test="pg-prov-filter" aria-label="Filter models by provider"
          @update:model-value="onProvType" @select="onProvPick" @blur="onProvBlur">
          <template #default="{ option }">
            <span class="pg-prov-opt" data-test="pg-prov-option">
              <span class="pg-prov-label">{{ option.label }}</span>
              <span class="pg-prov-n">{{ option.n }}</span>
            </span>
          </template>
        </b-autocomplete>
        <div class="lbl">Model</div>
        <!-- Hand-rolled picker: option buttons mousedown.prevent, so a click
             always selects — no blur/close race, no second click needed. -->
        <div class="pg-picker" @focusin="onPickerFocusin" @focusout="onPickerFocusout" @keydown="pickerKey">
          <input v-model="query" class="input is-small" type="text" role="combobox" autocomplete="off"
            :aria-expanded="pickerOpen ? 'true' : 'false'" aria-controls="pg-picklist" aria-autocomplete="list"
            placeholder="Search models or providers" data-test="pg-model-input"
            @focus="pickerFocus" @mousedown="pickerMousedown" />
          <div v-if="pickerOpen" id="pg-picklist" class="pg-picklist" role="listbox" aria-label="Models" data-test="pg-picklist">
            <template v-for="row in pickerRows.rows" :key="row.key">
              <div v-if="row.type === 'group'" class="pg-pick-group">{{ row.label }}</div>
              <button v-else-if="row.type === 'custom'" type="button" class="pg-pick-item pg-pick-custom"
                role="option" :class="{ 'is-active': row.idx === activeIdx }" :data-idx="row.idx"
                :aria-selected="false" data-test="pg-pick-custom"
                @mousedown.prevent @click="pickCustom(row.text)">
                <span class="pg-opt">
                  <span class="pg-opt-id">Use “{{ row.text }}” as the model ID</span>
                  <span class="pg-opt-setup" title="Free text — sent exactly as typed"><i class="fas fa-keyboard" aria-hidden="true"></i></span>
                </span>
                <span class="pg-opt-sub">Not in any listing — sent exactly as typed to {{ currentProviderLabel }}</span>
              </button>
              <button v-else type="button" class="pg-pick-item" :class="{ 'is-active': row.idx === activeIdx }"
                role="option" :data-idx="row.idx"
                :aria-selected="row.opt.providerId === settings.providerId && row.opt.modelId === settings.modelId"
                @mousedown.prevent @click="pick(row.opt)">
                <span class="pg-opt">
                  <span class="pg-opt-id">{{ row.opt.modelId }}</span>
                  <span v-if="row.opt.score != null" class="pg-opt-score" :style="{ color: scoreColor(row.opt.score) }">{{ fmtScore(row.opt.score) }}</span>
                  <span v-else-if="row.opt.arenaName" class="pg-opt-dim">unranked</span>
                  <span v-if="!row.opt.custom" class="pg-opt-setup" title="Needs a base URL and key before it can chat"><i class="fas fa-plug" aria-hidden="true"></i></span>
                </span>
                <span v-if="row.opt.arenaName && row.opt.arenaName.toLowerCase() !== row.opt.modelId.toLowerCase()" class="pg-opt-sub">{{ row.opt.arenaName }}</span>
              </button>
            </template>
            <div v-if="!pickerRows.shown" class="pg-pick-none">No model matches “{{ query }}”.</div>
            <div v-else-if="pickerRows.hidden" class="pg-pick-more">{{ pickerRows.hidden }} more — type to narrow the list.</div>
          </div>
        </div>
        <div class="pg-count" data-test="pg-count">
          {{ modelCount }} chat model{{ modelCount === 1 ? '' : 's' }} across {{ visibleGroups.length }} provider{{ visibleGroups.length === 1 ? '' : 's' }}
          <span v-if="pickedOutsideFilter" class="pg-off" data-test="pg-off-filter">· current model sits outside this filter</span>
        </div>

        <!-- Arena card for the selected model -->
        <div v-if="selected" class="pg-card" data-test="pg-model-card">
          <div class="pg-card-top">
            <div class="grow">
              <router-link v-if="selected.slug" class="pg-card-name" :to="{ name: 'model', params: { slug: selected.slug } }">{{ selected.arenaName }}</router-link>
              <span v-else class="pg-card-name plain">{{ selected.modelId }}</span>
              <div class="pg-card-sub">via {{ selected.providerLabel }}</div>
            </div>
            <b-tooltip :label="selected.score != null ? 'Arena Score (0–100, cross-benchmark)' : (selected.arenaName ? 'On the arena, but not enough benchmark coverage to rank' : 'Not on the arena — no benchmark data for this listing')" type="is-dark" multilined :delay="100" position="is-left">
              <span class="pg-card-score" :style="{ color: scoreColor(selected.score) }">{{ fmtScore(selected.score) }}</span>
            </b-tooltip>
          </div>
          <div class="pg-card-facts">
            <b-tooltip :label="selected.price ? (selected.price.source === 'provider' ? 'Price published by your provider (per 1M tokens, in / out)' : 'Arena reference price (per 1M tokens, in / out) — your provider may charge differently') : 'No price on record'" type="is-dark" multilined :delay="100">
              <span class="tag-lab"><i class="fas fa-coins" aria-hidden="true"></i>&nbsp;{{ selected.price ? fmtUsd(selected.price.in) + ' / ' + fmtUsd(selected.price.out) : '—' }}</span>
            </b-tooltip>
            <span class="tag-lab" title="Context window"><i class="fas fa-ruler-horizontal" aria-hidden="true"></i>&nbsp;{{ fmtCtx(selected.ctx) }}</span>
            <span v-if="selected.free" class="tag-lab teal">free</span>
            <span v-if="selected.older" class="tag-lab" title="An older generation on the arena — hidden from the default leaderboard view.">older</span>
          </div>
          <div v-if="needsSetup" class="pg-setup-row" data-test="pg-setup-hint">
            <span class="pg-fine">Not connected yet — needs a base URL and your API key.</span>
            <button type="button" class="button is-primary is-small" data-test="pg-setup-open" @click="openSetup(selected)">Set up</button>
          </div>
        </div>

        <div class="pg-sep"></div>

        <label class="lbl" for="pg-system">System prompt</label>
        <textarea id="pg-system" v-model.lazy="systemText" class="textarea is-small pg-system" rows="3"
          placeholder="Optional — e.g. “You are a concise senior engineer.”"></textarea>

        <div class="pg-row">
          <b-switch v-model="customTemp" size="is-small" type="is-success">Temperature</b-switch>
          <span class="pg-val">{{ customTemp ? tempValue.toFixed(2) : 'default' }}</span>
        </div>
        <b-slider v-if="customTemp" v-model="tempValue" :min="0" :max="2" :step="0.05" size="is-small" type="is-success" :tooltip="false" aria-label="Temperature" />

        <div class="pg-row">
          <label class="pg-inline-lbl" for="pg-max">Max output tokens</label>
          <input id="pg-max" v-model.lazy="maxTokensText" class="input is-small pg-max" inputmode="numeric" placeholder="default" />
        </div>

        <div class="pg-row">
          <b-tooltip label="Show the reply as it is generated. Turn off for providers that don't support streaming." type="is-dark" multilined :delay="100">
            <b-switch v-model="streamOn" size="is-small" type="is-success">Stream replies</b-switch>
          </b-tooltip>
        </div>

        <div class="pg-sep"></div>
        <p v-if="insecure" class="pg-warn"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i> This provider uses plain <code>http://</code> — your key and messages travel unencrypted.</p>
        <p class="pg-fine">
          <i class="fas fa-lock" aria-hidden="true"></i>
          Sent from your browser straight to <strong>{{ selectedProvider?.baseUrl || 'your provider' }}</strong>.
          The chat is saved in this browser only.
          <router-link :to="{ name: 'providers', query: { view: 'mine' } }">Manage providers</router-link>
        </p>
      </aside>

      <!-- ── Chat ── -->
      <div class="panel-lab pg-chat">
        <div class="pg-chat-head">
          <div class="pg-chat-title">
            <button type="button" class="pg-act pg-rail-toggle" data-test="pg-rail-toggle"
              :title="railOpen ? 'Hide the settings panel' : 'Show the settings panel'"
              :aria-label="railOpen ? 'Hide the settings panel' : 'Show the settings panel'"
              @click="railOpen = !railOpen">
              <i class="fas" :class="railOpen ? 'fa-angles-left' : 'fa-angles-right'" aria-hidden="true"></i>
            </button>
            <span class="pg-dot" :class="{ live: busy }"></span>
            {{ selected ? selected.modelId : 'No model selected' }}
          </div>
          <b-button size="is-small" type="is-ghost" icon-left="plus" :disabled="busy" data-test="pg-new-chat" title="Start a new chat (keeps the current model)" @click="newChat">New chat</b-button>
        </div>

        <div ref="scroller" class="pg-log" aria-live="polite">
          <div v-if="!messages.length" class="pg-start">
            <p class="muted">Ask anything, or start from one of these:</p>
            <div class="pg-starters">
              <button v-for="s in STARTERS" :key="s" type="button" class="chip pg-starter" :disabled="!selected" @click="send(s)">{{ s }}</button>
            </div>
          </div>

          <div v-for="m in messages" :key="m.id" class="pg-msg" :class="m.role" :data-role="m.role">
            <template v-if="m.role === 'user'">
              <div class="pg-bubble user">{{ m.content }}</div>
              <div class="pg-actions">
                <button type="button" class="pg-act" title="Edit and resend" :disabled="busy" @click="editUser(m)"><i class="fas fa-pen" aria-hidden="true"></i><span class="sr-only">Edit</span></button>
                <button type="button" class="pg-act" title="Delete this message and everything after it" :disabled="busy" @click="delMsg(m)"><i class="fas fa-trash-can" aria-hidden="true"></i><span class="sr-only">Delete</span></button>
              </div>
            </template>
            <template v-else>
              <div class="pg-who">
                <router-link v-if="m.slug" :to="{ name: 'model', params: { slug: m.slug } }">{{ m.arenaName }}</router-link>
                <span v-else>{{ m.model }}</span>
                <span class="pg-who-sub">· {{ m.provider }}</span>
              </div>
              <details v-if="m.reasoning" class="pg-think" :open="m.pending && !m.content">
                <summary>Thinking{{ m.pending && !m.content ? '…' : '' }}</summary>
                <div class="pg-think-body">{{ m.reasoning }}</div>
              </details>
              <template v-if="editingId === m.id">
                <div class="pg-edit" data-test="pg-edit-box">
                  <textarea v-model="editingText" class="textarea is-small" rows="4" aria-label="Edit reply"></textarea>
                  <div class="pg-edit-actions">
                    <b-button size="is-small" type="is-primary" data-test="pg-edit-save" @click="saveEditAssistant">Save</b-button>
                    <b-button size="is-small" type="is-ghost" @click="cancelEdit">Cancel</b-button>
                  </div>
                </div>
              </template>
              <div v-else-if="m.content" class="pg-bubble bot md" v-html="md(m.content)"></div>
              <div v-else-if="m.pending" class="pg-bubble bot pg-typing" aria-label="Waiting for the reply"><span></span><span></span><span></span></div>
              <div v-if="m.error" class="pg-error" role="alert" data-test="pg-error">
                <i class="fas fa-circle-exclamation" aria-hidden="true"></i> {{ m.error }}
              </div>
              <div v-if="!m.pending" class="pg-meta">
                <template v-if="m.meta">
                  <span v-if="m.stopped" class="pg-stopped">stopped</span>
                  <span title="Time to first token">TTFT {{ fmtMs(m.meta.ttft) }}</span>
                  <span title="Total time">{{ fmtMs(m.meta.total) }}</span>
                  <span v-if="m.meta.tps" title="Output tokens per second, after the first token">{{ Math.round(m.meta.tps) }} tok/s</span>
                  <span :title="m.meta.estimated ? 'Estimated — the provider sent no usage block' : 'Reported by the provider'">{{ tokLabel(m) }}</span>
                  <span v-if="m.meta.cost != null" :title="costTitle(m)">≈ {{ fmtCost(m.meta.cost) }}</span>
                </template>
                <span class="pg-actions inline">
                  <button v-if="m.content" type="button" class="pg-act" :title="copiedId === m.id ? 'Copied' : 'Copy'" @click="copy(m)"><i class="fas" :class="copiedId === m.id ? 'fa-check' : 'fa-copy'" aria-hidden="true"></i><span class="sr-only">Copy</span></button>
                  <button v-if="m.content" type="button" class="pg-act" title="Edit reply" :disabled="busy" @click="startEditAssistant(m)"><i class="fas fa-pen" aria-hidden="true"></i><span class="sr-only">Edit reply</span></button>
                  <button type="button" class="pg-act" title="Delete this message and everything after it" :disabled="busy" @click="delMsg(m)"><i class="fas fa-trash-can" aria-hidden="true"></i><span class="sr-only">Delete</span></button>
                  <button v-if="m.id === lastAssistantId" type="button" class="pg-act" :title="m.error ? 'Retry' : 'Regenerate'" :disabled="busy || !selected" data-test="pg-regen" @click="regenerate(m.id)"><i class="fas fa-rotate-right" aria-hidden="true"></i><span class="sr-only">{{ m.error ? 'Retry' : 'Regenerate' }}</span></button>
                </span>
              </div>
            </template>
          </div>
        </div>

        <form class="pg-composer" @submit.prevent="send()">
          <textarea ref="composerEl" v-model="draft" class="textarea pg-input" rows="1"
            :placeholder="needsSetup ? 'Set up this provider to start chatting' : (selected ? 'Message ' + selected.modelId + '  (Enter to send, Shift+Enter for a new line)' : 'Pick a model first')"
            :disabled="!selected || needsSetup" aria-label="Message" @keydown="onKey"></textarea>
          <div class="pg-compose-side">
            <span v-if="draft" class="pg-est" title="Rough token estimate">≈{{ draftTokens }} tok</span>
            <b-button v-if="busy" type="is-danger" size="is-small" icon-left="stop" data-test="pg-stop" @click="stop">Stop</b-button>
            <b-button v-else native-type="submit" type="is-primary" size="is-small" icon-left="paper-plane" :disabled="!canSend" data-test="pg-send">Send</b-button>
          </div>
        </form>
      </div>
    </div>

    <!-- Setup modal: collect what a catalog model needs to chat -->
    <b-modal v-model="setupOpen" aria-role="dialog" aria-label="Set up provider">
      <div v-if="setup" class="pg-modal panel-lab" data-test="pg-setup-modal">
        <h2 class="pg-modal-title">Set up {{ setup.label }}</h2>
        <p class="muted pg-modal-sub">
          The Playground calls this provider straight from your browser over its OpenAI-compatible API. The values
          below are a starting point from the catalog — fix anything your provider expects.
        </p>
        <label class="lbl" for="pg-setup-url">Base URL</label>
        <input id="pg-setup-url" v-model="setup.baseUrl" class="input is-small" data-test="pg-setup-url" placeholder="https://…/v1" spellcheck="false" />
        <label class="lbl" for="pg-setup-key">API key</label>
        <input id="pg-setup-key" v-model="setup.key" class="input is-small" type="password" data-test="pg-setup-key"
          placeholder="sk-…" autocomplete="off" />
        <p class="pg-modal-send" data-test="pg-setup-send">
          Model sent: <code>{{ setupWillSend }}</code>
          <span v-if="setupWillSend !== setup.modelId" class="pg-modal-id-hint">catalog: {{ setup.modelId }}</span>
        </p>
        <b-checkbox v-model="setup.strip" size="is-small" data-test="pg-setup-strip">
          Strip the catalog prefix from model IDs — applies to every model of this provider
        </b-checkbox>
        <p class="pg-fine">
          The key stays in this browser and is sent only to this base URL. Model IDs not in the provider's list are
          sent exactly as typed, so brand-new or unlisted models work without updating anything.
        </p>
        <p v-if="testState && testState.msg && !testState.busy" class="pg-setup-test" :class="testState.ok ? 'is-ok' : 'is-err'" role="status" data-test="pg-setup-test">
          {{ testState.msg }}
        </p>
        <div class="pg-modal-actions">
          <button type="button" class="button is-small" data-test="pg-setup-test-btn"
            :disabled="!setup.baseUrl.trim() || (testState && testState.busy)" @click="runTest">
            {{ testState && testState.busy ? 'Testing…' : 'Test connection' }}
          </button>
          <button type="button" class="button is-primary is-small" data-test="pg-setup-save" :disabled="!setup.baseUrl.trim()" @click="saveSetup">Save and use here</button>
          <button type="button" class="button is-ghost is-small" data-test="pg-setup-cancel" @click="setupOpen = false">Not now</button>
        </div>
      </div>
    </b-modal>

    <!-- Mobile drawer backdrop (visible ≤1023px only) -->
    <div v-if="railOpen" class="pg-backdrop" aria-hidden="true" @click="railOpen = false"></div>
  </section>
</template>

<style scoped>
.pg-grid { display: grid; grid-template-columns: minmax(260px, 320px) minmax(0, 1fr); gap: 1rem; align-items: start; }
.pg-grid.rail-closed { grid-template-columns: minmax(0, 1fr); }
.pg-grid.rail-closed .pg-rail { display: none; }
.pg-rail { padding: 1rem; display: flex; flex-direction: column; gap: .55rem; position: sticky; top: 4.5rem; }
.pg-count { color: var(--faint); font-size: .74rem; }
.pg-sep { border-top: 1px solid var(--line); margin: .35rem 0; }
.pg-row { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
.pg-val { color: var(--muted); font-size: .8rem; font-variant-numeric: tabular-nums; }
.pg-inline-lbl { font-size: .85rem; color: var(--text); }
.pg-max { max-width: 7rem; text-align: right; }
.pg-system { min-height: 4.5rem; resize: vertical; }
.pg-fine { color: var(--faint); font-size: .76rem; line-height: 1.45; margin: 0; }
.pg-warn { color: var(--gold); font-size: .78rem; margin: 0; }

/* History list */
.pg-hist-head { display: flex; align-items: center; justify-content: space-between; }
.pg-hist { display: flex; flex-direction: column; gap: 2px; max-height: 13rem; overflow-y: auto; }
.pg-hist-item { display: flex; align-items: center; border-radius: 8px; padding-right: .2rem; }
.pg-hist-item:hover { background: var(--surface-2); }
.pg-hist-item.active { background: var(--teal-dim); }
.pg-hist-open { flex: 1; min-width: 0; background: none; border: 0; text-align: left; padding: .32rem .5rem; cursor: pointer; display: flex; flex-direction: column; gap: .05rem; color: var(--text); border-radius: 8px; }
.pg-hist-open:disabled { cursor: not-allowed; opacity: .6; }
.pg-hist-title { font-size: .82rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pg-hist-time { font-size: .68rem; color: var(--faint); }
.pg-hist-item .pg-actions { opacity: 0; }
.pg-hist-item:hover .pg-actions, .pg-hist-item:focus-within .pg-actions { opacity: 1; }
.pg-rename { width: 100%; }
.pg-hist-clear { background: none; border: 0; color: var(--faint); font-size: .72rem; cursor: pointer; text-align: left; padding: .15rem 0; }
.pg-hist-clear:hover:not(:disabled) { color: var(--rose); }
.pg-prov-opt { display: flex; justify-content: space-between; gap: .6rem; align-items: baseline; min-width: 0; width: 100%; }
.pg-prov-n { color: var(--faint); font-size: .74rem; flex: none; }
.pg-off { color: var(--gold); }
.pg-rail-toggle { font-size: .95rem; }
.pg-edit { display: flex; flex-direction: column; gap: .4rem; max-width: min(46rem, 92%); }
.pg-edit-actions { display: flex; gap: .4rem; justify-content: flex-end; }
.pg-backdrop { display: none; }

.pg-picker { position: relative; }
.pg-picklist {
  position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 30;
  background: var(--bg-elev, var(--surface-2)); border: 1px solid var(--line-2, var(--line));
  border-radius: 10px; box-shadow: 0 10px 28px rgba(0,0,0,.35);
  max-height: 340px; overflow-y: auto; padding: .25rem;
}
.pg-pick-group { font-size: .68rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--faint); padding: .45rem .5rem .2rem; }
.pg-pick-item { display: block; width: 100%; text-align: left; background: none; border: 0; color: var(--text); cursor: pointer; padding: .3rem .5rem; border-radius: 8px; }
.pg-pick-item:hover, .pg-pick-item.is-active { background: var(--teal-dim); }
.pg-pick-none, .pg-pick-more { color: var(--faint); font-size: .76rem; padding: .45rem .5rem; }

.pg-opt { display: flex; justify-content: space-between; gap: .6rem; align-items: baseline; }
.pg-opt-id { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pg-opt-score { font-weight: 800; font-variant-numeric: tabular-nums; }
.pg-opt-dim, .pg-opt-sub { color: var(--faint); font-size: .74rem; }
.pg-opt-sub { display: block; }
.pg-opt-setup { color: var(--gold); font-size: .68rem; flex: none; }

.pg-setup-row { display: flex; align-items: center; justify-content: space-between; gap: .6rem; margin-top: .55rem; }

/* Setup modal — padding + fluid width match the site's other modals
   (mp-modal / tiers-modal); the old edge-to-edge 520px box overflowed
   small screens and looked unstyled. */
.pg-modal { display: flex; flex-direction: column; gap: .5rem; padding: 1.4rem 1.25rem; max-width: 520px; }
.pg-modal-title { font-size: 1.05rem; font-weight: 700; margin: 0; }
.pg-modal-sub { font-size: .82rem; margin: 0; line-height: 1.45; }
.pg-modal-id-hint { color: var(--faint); font-weight: 400; margin-left: .35rem; }
.pg-modal-send { font-size: .84rem; margin: 0; }
.pg-modal-send code { background: var(--surface-3, var(--surface-2)); color: var(--teal); border-radius: 5px; padding: .08rem .35rem; }
.pg-setup-test { font-size: .8rem; margin: 0; }
.pg-setup-test.is-ok { color: var(--teal); }
.pg-setup-test.is-err { color: var(--rose); }
.pg-modal-actions { display: flex; gap: .5rem; justify-content: flex-end; margin-top: .3rem; flex-wrap: wrap; }
.pg-pick-custom .pg-opt-sub { display: block; }

.pg-card { border: 1px solid var(--line); border-radius: 12px; padding: .7rem .8rem; background: var(--surface-2); }
.pg-card-top { display: flex; gap: .6rem; align-items: flex-start; }
.pg-card-name { font-weight: 700; color: var(--text); word-break: break-word; }
.pg-card-name:hover { color: var(--teal); }
.pg-card-sub { color: var(--muted); font-size: .76rem; }
.pg-card-score { font-size: 1.5rem; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; cursor: help; }
.pg-card-facts { display: flex; flex-wrap: wrap; gap: .35rem; margin-top: .55rem; }

.pg-chat { display: flex; flex-direction: column; height: calc(100vh - 7.5rem); min-height: 480px; overflow: hidden; }
.pg-chat-head { display: flex; justify-content: space-between; align-items: center; padding: .6rem .9rem; border-bottom: 1px solid var(--line); }
.pg-chat-title { font-weight: 700; display: flex; align-items: center; gap: .5rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pg-dot { width: .55rem; height: .55rem; border-radius: 50%; background: var(--faint); flex: none; }
.pg-dot.live { background: var(--teal); box-shadow: 0 0 0 0 var(--teal-dim); animation: pg-pulse 1.2s infinite; }
@keyframes pg-pulse { 0% { box-shadow: 0 0 0 0 rgba(46,230,199,.5); } 100% { box-shadow: 0 0 0 8px rgba(46,230,199,0); } }

.pg-log { flex: 1; overflow-y: auto; padding: 1rem; display: flex; flex-direction: column; gap: 1rem; scroll-behavior: smooth; }
.pg-start { margin: auto 0; text-align: center; }
.pg-starters { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: .5rem; margin-top: .7rem; }
.pg-starter { border-radius: 12px; text-align: left; padding: .6rem .8rem; line-height: 1.35; white-space: normal; font-weight: 500; }
.pg-starter:disabled { opacity: .5; cursor: not-allowed; }

.pg-msg { display: flex; flex-direction: column; max-width: 100%; }
.pg-msg.user { align-items: flex-end; }
.pg-bubble { border-radius: 14px; padding: .6rem .85rem; max-width: min(46rem, 92%); word-wrap: break-word; }
.pg-bubble.user { background: var(--indigo-dim); border: 1px solid rgba(139,156,255,.35); white-space: pre-wrap; }
.pg-bubble.bot { background: var(--surface-2); border: 1px solid var(--line); }
.pg-who { font-size: .76rem; color: var(--muted); margin-bottom: .25rem; font-weight: 600; }
.pg-who a { color: var(--teal); }
.pg-who-sub { color: var(--faint); font-weight: 400; margin-left: .3rem; }
.pg-think { font-size: .8rem; color: var(--muted); margin-bottom: .35rem; max-width: min(46rem, 92%); }
.pg-think summary { cursor: pointer; color: var(--faint); }
.pg-think-body { white-space: pre-wrap; border-left: 2px solid var(--line-2); padding-left: .6rem; margin-top: .3rem; max-height: 14rem; overflow-y: auto; }
.pg-error { color: var(--rose); background: var(--rose-dim); border-radius: 10px; padding: .5rem .7rem; font-size: .85rem; margin-top: .35rem; max-width: min(46rem, 92%); }
.pg-meta { display: flex; flex-wrap: wrap; align-items: center; gap: .2rem .8rem; color: var(--faint); font-size: .72rem; margin-top: .3rem; font-variant-numeric: tabular-nums; }
.pg-stopped { color: var(--gold); }
.pg-actions { display: flex; gap: .15rem; opacity: .0; transition: opacity .12s; }
.pg-msg:hover .pg-actions, .pg-actions:focus-within, .pg-actions.inline { opacity: 1; }
.pg-act { background: none; border: 0; color: var(--faint); cursor: pointer; padding: .15rem .3rem; border-radius: 6px; }
.pg-act:hover:not(:disabled) { color: var(--teal); background: var(--teal-dim); }
.pg-act:disabled { opacity: .4; cursor: not-allowed; }

.pg-typing { display: inline-flex; gap: .3rem; padding: .8rem .9rem; width: fit-content; }
.pg-typing span { width: .4rem; height: .4rem; border-radius: 50%; background: var(--muted); animation: pg-blink 1.2s infinite both; }
.pg-typing span:nth-child(2) { animation-delay: .2s; }
.pg-typing span:nth-child(3) { animation-delay: .4s; }
@keyframes pg-blink { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; } }

.pg-composer { display: flex; gap: .6rem; align-items: flex-end; padding: .7rem .9rem; border-top: 1px solid var(--line); background: var(--bg-elev); }
.pg-input { flex: 1 1 auto; min-width: 0; width: auto; resize: none; min-height: 2.6rem; max-height: 240px; overflow-y: auto; }
.pg-compose-side { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: .3rem; }
.pg-est { color: var(--faint); font-size: .7rem; font-variant-numeric: tabular-nums; }

.pg-empty { padding: 2.2rem 1.5rem; text-align: center; max-width: 40rem; margin: 0 auto; display: flex; flex-direction: column; align-items: center; gap: .7rem; }
.pg-empty-icon { font-size: 1.8rem; color: var(--teal); }
.pg-empty-title { font-size: 1.15rem; font-weight: 700; margin: 0; }
.muted { color: var(--muted); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* Markdown inside replies */
.md :deep(p) { margin: 0 0 .55rem; }
.md :deep(p:last-child), .md :deep(ul:last-child), .md :deep(ol:last-child), .md :deep(pre:last-child) { margin-bottom: 0; }
.md :deep(ul), .md :deep(ol) { margin: 0 0 .55rem 1.25rem; }
.md :deep(ul) { list-style: disc; }
.md :deep(ol) { list-style: decimal; }
.md :deep(h3), .md :deep(h4), .md :deep(h5), .md :deep(h6) { font-weight: 700; margin: .7rem 0 .35rem; font-size: 1rem; }
.md :deep(code) { background: var(--surface-3); color: var(--teal); border-radius: 5px; padding: .05rem .3rem; font-size: .85em; }
.md :deep(pre) { background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: .7rem .8rem; overflow-x: auto; margin: 0 0 .55rem; position: relative; }
.md :deep(pre code) { background: none; color: var(--text); padding: 0; font-size: .82rem; }
.md :deep(pre[data-lang])::before { content: attr(data-lang); position: absolute; top: .25rem; right: .5rem; color: var(--faint); font-size: .68rem; text-transform: lowercase; }
.md :deep(blockquote) { border-left: 3px solid var(--line-2); padding-left: .7rem; color: var(--muted); margin: 0 0 .55rem; }
.md :deep(a) { color: var(--teal); text-decoration: underline; }
.md :deep(hr) { background: var(--line); height: 1px; margin: .7rem 0; }

@media (max-width: 1023px) {
  .pg-grid { grid-template-columns: 1fr; }
  .pg-grid.rail-closed .pg-rail { display: none; }
  .pg-chat { height: 75vh; }
  /* Rail becomes an overlay drawer; the backdrop behind it closes on tap. */
  .pg-rail { position: fixed; top: 4.2rem; left: .6rem; right: .6rem; bottom: .6rem; z-index: 40; overflow-y: auto; }
  .pg-backdrop { display: block; position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 39; }
}
@media (max-width: 600px) {
  .pg-bubble { max-width: 100%; }
  .pg-log { padding: .7rem; }
}
</style>
