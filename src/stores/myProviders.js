// ── My Providers store (module-level singleton, mirrors data.js) ──────
// Owns the user's self-supplied AI providers: configs + fetched/pasted
// model listings, persisted to localStorage under a VERSIONED key so a
// future backend/SaaS sync can migrate the same payload shape (stats-36).
//
// Hard rules (agreed design):
//   • Client-side only — the API key, if given, lives here and is sent
//     exclusively to the provider's own base URL. There is no server.
//   • We persist provider CONFIG + raw model listings only. Scores,
//     ranks and prices are mirrored read-only from the arena snapshot at
//     render time — never stored, never stale.
//   • clearAll() wipes everything (Ibrahim's clean-up requirement);
//     exportPayload()/importPayload() give the user ownership of the data.

import { ref, computed } from 'vue';

export const STORAGE_KEY = 'ba.myproviders.v1';
export const SCHEMA_VERSION = 1;

const INTENTS = ['', 'scores', 'prices', 'track'];

const providers = ref(null); // null = not loaded yet; [] = loaded, empty
let pendingLoad = null;

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function readStorage() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return [];
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const doc = JSON.parse(raw);
    if (doc?.version !== SCHEMA_VERSION || !Array.isArray(doc.providers)) return [];
    return doc.providers.filter(p => p && p.id && p.label);
  } catch {
    return []; // corrupt or unavailable storage → start clean, never throw
  }
}

function writeStorage(list) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (!list.length) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, providers: list }));
  } catch { /* private mode / quota — session-only */ }
}

export function ensureMyProvidersLoaded() {
  if (providers.value !== null) return Promise.resolve();
  if (!pendingLoad) {
    pendingLoad = Promise.resolve().then(() => { providers.value = readStorage(); });
  }
  return pendingLoad;
}

function commit() {
  writeStorage(providers.value || []);
}

// ── Actions ───────────────────────────────────────────────────────────
export function addProvider({ label, baseUrl = '', key = '', mode = 'fetch' }) {
  const p = {
    id: uid(),
    label: String(label || 'Untitled provider').slice(0, 80),
    baseUrl: String(baseUrl || '').trim(),
    key: String(key || ''),
    mode, // 'fetch' | 'paste'
    intent: '', // '' | 'scores' | 'prices' | 'track' (post-sync question)
    addedAt: new Date().toISOString(),
    lastSyncAt: null,
    lastError: null,
    models: [], // parsed listings from lib/myProviders.js (never scores)
  };
  providers.value = [...(providers.value || []), p];
  commit();
  return p;
}

export function updateProvider(id, patch) {
  providers.value = (providers.value || []).map(p =>
    p.id === id ? { ...p, ...patch, id: p.id } : p);
  commit();
}

export function removeProvider(id) {
  providers.value = (providers.value || []).filter(p => p.id !== id);
  commit();
}

export function clearAll() {
  providers.value = [];
  commit();
}

// Store a fresh listing for a provider (fetch success or paste import).
// Models arrive already parsed by lib/myProviders.js — config + listing
// fields only, NO created dates, NO scores.
export function setModels(id, models, { via } = {}) {
  providers.value = (providers.value || []).map(p => p.id === id
    ? { ...p, models: models || [], lastSyncAt: new Date().toISOString(), lastError: null, ...(via ? { mode: via } : {}) }
    : p);
  commit();
}

export function setError(id, message) {
  providers.value = (providers.value || []).map(p => p.id === id ? { ...p, lastError: message } : p);
  commit();
}

// ── Export / import (backup + future SaaS migration shape) ───────────
export function exportPayload() {
  return JSON.stringify({
    kind: 'benchmark-arena-my-providers',
    version: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    providers: providers.value || [],
  }, null, 2);
}

export function importPayload(text) {
  let doc;
  try { doc = JSON.parse(String(text || '')); } catch { return { ok: false, error: 'Not valid JSON.' }; }
  if (!doc || doc.kind !== 'benchmark-arena-my-providers' || !Array.isArray(doc.providers)) {
    return { ok: false, error: 'Not a My Providers export file.' };
  }
  const clean = doc.providers
    .filter(p => p && p.id && p.label)
    .map(p => ({
      id: String(p.id),
      label: String(p.label).slice(0, 80),
      baseUrl: String(p.baseUrl || ''),
      key: String(p.key || ''),
      mode: p.mode === 'paste' ? 'paste' : 'fetch',
      intent: INTENTS.includes(p.intent) ? p.intent : '',
      addedAt: p.addedAt || null,
      lastSyncAt: p.lastSyncAt || null,
      lastError: null,
      models: Array.isArray(p.models) ? p.models : [],
    }));
  providers.value = clean;
  commit();
  return { ok: true, count: clean.length };
}

// ── Derived ───────────────────────────────────────────────────────────
const hasAny = computed(() => (providers.value || []).length > 0);

export function useMyProviders() {
  return {
    providers, hasAny, ensureMyProvidersLoaded,
    addProvider, updateProvider, removeProvider, clearAll,
    setModels, setError, exportPayload, importPayload,
  };
}
