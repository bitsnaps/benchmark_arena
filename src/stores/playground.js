// ── Playground store (module-level singleton, mirrors myProviders.js) ──
// One conversation + its settings, persisted to this browser only. API
// keys are NEVER stored here: requests read the key from the selected
// My Providers entry at send time, so removing a provider (or Clear all
// there) leaves no credential behind in the Playground.

import { ref } from 'vue';

export const STORAGE_KEY = 'ba.playground.v1';
const MAX_MESSAGES = 200;

export const DEFAULT_SETTINGS = Object.freeze({
  providerId: '',
  modelId: '',
  system: '',
  temperature: null, // null = provider default (nothing sent)
  maxTokens: null,   // null = provider default
  stream: true,
});

const settings = ref({ ...DEFAULT_SETTINGS });
const messages = ref([]);
let loaded = false;

function read() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const doc = JSON.parse(raw);
    return doc && typeof doc === 'object' ? doc : null;
  } catch { return null; }
}

function write() {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({
      settings: settings.value,
      // An in-flight reply is saved as whatever has arrived, never "pending".
      messages: messages.value.slice(-MAX_MESSAGES).map(({ pending, ...m }) => m),
    }));
  } catch { /* private mode / quota — session-only */ }
}

export function ensurePlaygroundLoaded() {
  if (loaded) return;
  loaded = true;
  const doc = read();
  if (!doc) return;
  const s = doc.settings || {};
  settings.value = {
    ...DEFAULT_SETTINGS,
    providerId: typeof s.providerId === 'string' ? s.providerId : '',
    modelId: typeof s.modelId === 'string' ? s.modelId : '',
    system: typeof s.system === 'string' ? s.system : '',
    temperature: Number.isFinite(s.temperature) ? s.temperature : null,
    maxTokens: Number.isFinite(s.maxTokens) ? s.maxTokens : null,
    stream: s.stream !== false,
  };
  messages.value = Array.isArray(doc.messages)
    ? doc.messages.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    : [];
}

export function setSettings(patch) {
  settings.value = { ...settings.value, ...patch };
  write();
}

let seq = 0;
const mid = () => Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 6);

export function addMessage(m) {
  const msg = { id: mid(), at: new Date().toISOString(), ...m };
  messages.value = [...messages.value, msg];
  write();
  return msg.id;
}

export function updateMessage(id, patch, { persist = true } = {}) {
  messages.value = messages.value.map(m => (m.id === id ? { ...m, ...patch } : m));
  if (persist) write();
}

// Drops the message with this id and everything after it (regenerate / edit).
export function truncateFrom(id) {
  const i = messages.value.findIndex(m => m.id === id);
  if (i < 0) return;
  messages.value = messages.value.slice(0, i);
  write();
}

export function clearConversation() {
  messages.value = [];
  write();
}

export function resetPlaygroundForTests() {
  settings.value = { ...DEFAULT_SETTINGS };
  messages.value = [];
  loaded = false;
}

export function usePlayground() {
  return {
    settings, messages, ensurePlaygroundLoaded, setSettings,
    addMessage, updateMessage, truncateFrom, clearConversation,
  };
}
