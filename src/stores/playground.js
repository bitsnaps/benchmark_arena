// ── Playground store v2 (module-level singleton, mirrors myProviders.js) ──
// Multi-conversation chat history, persisted to IndexedDB in this browser
// only. Two stores: `conversations` (one record per chat, with its own
// settings snapshot so switching chats restores the right model) and
// `meta` (activeId + UI prefs). The v1 single-conversation localStorage
// doc is migrated once on first boot. API keys are NEVER stored here:
// requests read the key from the selected My Providers entry at send
// time, so removing a provider (or Clear all there) leaves no credential
// behind in the Playground. Reasoning traces and in-flight flags stay in
// memory and are stripped on write.
//
// If IndexedDB won't open (rare private-mode setups), the store degrades
// to an in-memory driver: everything works, `persistent` flips false and
// the UI says history won't be saved. All IDB access goes through the
// injectable driver from lib/idb.js; writes run through a serialized
// queue (latest state wins) so streams and chat switches can't interleave.

import { computed, ref, toRaw } from 'vue';
import { createIdbDriver, createMemoryDriver, idbSupported } from '../lib/idb.js';

export const STORAGE_KEY = 'ba.playground.v1'; // legacy single-chat doc, migrated once
const MAX_MESSAGES = 200; // per conversation, enforced at write time (render sanity, not quota)

export const DEFAULT_SETTINGS = Object.freeze({
  providerId: '',
  modelId: '',
  system: '',
  temperature: null, // null = provider default (nothing sent)
  maxTokens: null,   // null = provider default
  stream: true,
});
const DEFAULT_UI = Object.freeze({ railOpen: true, providerFilter: '' });

const conversations = ref([]);
const activeId = ref('');
const ui = ref({ ...DEFAULT_UI });
const persistent = ref(true); // false = memory fallback (history lost on reload)
const ready = ref(false);

let driver = null;        // injected or IDB; null until ensurePlaygroundLoaded()
let loaded = false;
let readyPromise = null;
let seq = 0;
const uid = (p) => p + Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 6);

// ── write queue: every persist runs after the previous one, latest wins ──
let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.catch(() => {}).then(fn);
  // A dropped history write must never break the chat — but it must not be
  // invisible either (a DataCloneError once cost an hour of debugging).
  queue = run.catch((e) => { if (import.meta.env?.DEV) console.warn('[pg-persist] write failed:', e); });
  return run;
}
export const flushPersist = () => queue; // for tests

// Persistable snapshot of a conversation: no pending flag, no reasoning.
// IMPORTANT: read through toRaw() — a reactive Proxy anywhere in the record
// makes structuredClone (used by IndexedDB) throw DataCloneError, and the
// write silently dies. Raw objects clone cleanly.
function snapshot(conv) {
  const raw = toRaw(conv);
  const snap = {
    ...raw,
    settings: { ...toRaw(raw.settings) },
    messages: raw.messages.slice(-MAX_MESSAGES).map((msg) => {
      const { pending, reasoning, ...m } = toRaw(msg);
      return m;
    }),
  };
  return snap;
}
const persistConv = (id) => {
  if (!driver || !persistent.value) return;
  const conv = conversations.value.find(c => c.id === id);
  if (conv) enqueue(() => driver.putConversation(snapshot(conv)));
};
const persistMeta = () => {
  if (!driver || !persistent.value) return;
  enqueue(() => driver.putMeta('main', { activeId: activeId.value, ui: { ...ui.value } }));
};

const nowIso = () => new Date().toISOString();
const touch = (conv) => { conv.updatedAt = nowIso(); };

export function deriveTitle(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return 'New chat';
  return t.length > 48 ? t.slice(0, 47).trimEnd() + '…' : t;
}

function makeConversation(pref = {}) {
  const ts = nowIso();
  return {
    id: uid('c'),
    title: 'New chat',
    createdAt: ts,
    updatedAt: ts,
    settings: { ...DEFAULT_SETTINGS, ...pref },
    messages: [],
  };
}

// ── boot ───────────────────────────────────────────────────────────────
export function setDriver(d) { driver = d; } // tests / e2e seeds

function readLegacyDoc() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const doc = JSON.parse(raw);
    return doc && typeof doc === 'object' ? doc : null;
  } catch { return null; }
}

async function boot() {
  if (!driver) driver = (idbSupported() && createIdbDriver()) || null;
  if (!driver) { driver = createMemoryDriver(); persistent.value = false; }
  try {
    var convs = await driver.listConversations();
    var meta = (await driver.getMeta('main')) || {};
  } catch {
    driver = createMemoryDriver();
    persistent.value = false;
    convs = []; meta = {};
  }

  // One-time v1 → v2 migration: wrap the old single chat, drop the old key
  // only after the copy is durably written.
  if (!convs.length) {
    const legacy = readLegacyDoc();
    if (legacy && (Array.isArray(legacy.messages) || legacy.settings)) {
      const conv = makeConversation(legacy.settings || {});
      conv.messages = (Array.isArray(legacy.messages) ? legacy.messages : [])
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map(m => ({ at: nowIso(), ...m }));
      const firstUser = conv.messages.find(m => m.role === 'user');
      if (firstUser) conv.title = deriveTitle(firstUser.content);
      convs = [conv];
      await driver.putConversation(snapshot(conv));
      // Only drop the legacy doc when it is truly safe: with a memory-only
      // driver the migrated chat would vanish on reload, so we keep the
      // old key as the durable copy and re-migrate next boot.
      if (persistent.value) { try { globalThis.localStorage?.removeItem(STORAGE_KEY); } catch { /* ignore */ } }
    }
  }

  conversations.value = convs
    .filter(c => c && c.id && typeof c.title === 'string' && Array.isArray(c.messages) && c.settings)
    .map(c => ({ ...c, settings: { ...DEFAULT_SETTINGS, ...c.settings } }));
  if (!conversations.value.length) {
    const fresh = makeConversation();
    conversations.value = [fresh];
    persistConv(fresh.id);
  }

  activeId.value = typeof meta.activeId === 'string' && conversations.value.some(c => c.id === meta.activeId)
    ? meta.activeId
    : conversations.value.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0].id;
  ui.value = { ...DEFAULT_UI, ...(meta.ui && typeof meta.ui === 'object' ? meta.ui : {}) };
  persistMeta();
  ready.value = true;
}

export function ensurePlaygroundLoaded() {
  if (loaded) return readyPromise || Promise.resolve();
  loaded = true;
  readyPromise = boot();
  return readyPromise;
}

// ── selectors ──────────────────────────────────────────────────────────
export function usePlayground() {
  return {
    conversations, activeId, ui, persistent, ready,
    activeConversation,
    settings, messages,
    ensurePlaygroundLoaded, setSettings, setUi,
    addMessage, updateMessage, truncateFrom, clearConversation,
    newConversation, switchTo, renameConversation, deleteConversation, deleteAllHistory,
    flushPersist,
  };
}

export const activeConversation = computed(() =>
  conversations.value.find(c => c.id === activeId.value) || conversations.value[0] || null);

export const settings = computed(() => activeConversation.value?.settings || DEFAULT_SETTINGS);
export const messages = computed(() => activeConversation.value?.messages || EMPTY);
const EMPTY = [];

// ── mutations (active conversation) ────────────────────────────────────
export function setSettings(patch) {
  const conv = activeConversation.value;
  if (!conv) return;
  conv.settings = { ...conv.settings, ...patch };
  touch(conv);
  persistConv(conv.id);
  persistMeta();
}

export function setUi(patch) {
  ui.value = { ...ui.value, ...patch };
  persistMeta();
}

export function addMessage(m) {
  const conv = activeConversation.value;
  if (!conv) return '';
  const msg = { id: uid('m'), at: nowIso(), ...m };
  conv.messages = [...conv.messages, msg];
  if (m.role === 'user' && (conv.title === 'New chat' || !conv.title)) conv.title = deriveTitle(m.content);
  touch(conv);
  persistConv(conv.id);
  return msg.id;
}

export function updateMessage(id, patch, { persist = true } = {}) {
  const conv = activeConversation.value;
  if (!conv) return;
  // Spread from the RAW message: copying the reactive proxy would embed a
  // Proxy under `meta` again and poison the next IndexedDB write.
  conv.messages = conv.messages.map(m => (m.id === id ? { ...toRaw(m), ...patch } : m));
  touch(conv);
  if (persist) persistConv(conv.id);
}

// Drops the message with this id and everything after it (delete / edit).
export function truncateFrom(id) {
  const conv = activeConversation.value;
  if (!conv) return;
  const i = conv.messages.findIndex(m => m.id === id);
  if (i < 0) return;
  conv.messages = conv.messages.slice(0, i);
  touch(conv);
  persistConv(conv.id);
}

export function clearConversation() {
  const conv = activeConversation.value;
  if (!conv) return;
  conv.messages = [];
  conv.title = 'New chat';
  touch(conv);
  persistConv(conv.id);
}

// ── conversation-level ops ─────────────────────────────────────────────
export function newConversation(pref = {}) {
  const conv = makeConversation(pref);
  conversations.value = [conv, ...conversations.value];
  activeId.value = conv.id;
  persistConv(conv.id);
  persistMeta();
  return conv.id;
}

export function switchTo(id) {
  if (!conversations.value.some(c => c.id === id)) return;
  activeId.value = id;
  persistMeta();
}

export function renameConversation(id, title) {
  const conv = conversations.value.find(c => c.id === id);
  if (!conv) return;
  conv.title = deriveTitle(title);
  touch(conv);
  persistConv(id);
}

export function deleteConversation(id) {
  const i = conversations.value.findIndex(c => c.id === id);
  if (i < 0) return;
  conversations.value = conversations.value.filter(c => c.id !== id);
  if (driver && persistent.value) enqueue(() => driver.deleteConversation(id));
  if (activeId.value === id) {
    const next = conversations.value
      .slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    if (next) activeId.value = next.id;
    else activeId.value = newConversation();
  }
  persistMeta();
}

export function deleteAllHistory() {
  conversations.value = [];
  if (driver && persistent.value) enqueue(() => driver.clearConversations());
  activeId.value = newConversation();
}

export function resetPlaygroundForTests() {
  conversations.value = [];
  activeId.value = '';
  ui.value = { ...DEFAULT_UI };
  persistent.value = true;
  ready.value = false;
  driver = null;
  loaded = false;
  readyPromise = null;
  queue = Promise.resolve();
}
