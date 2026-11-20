// ── stats-94: the runtime HF lane ("add any Hugging Face model") ──────────
// Phase-2 of the curated HF lane (stats-93): the user can paste ANY HF repo
// id and the app fetches its public identity client-side (huggingface.co/api
// echoes any Origin, so no CORS wall — recon finding, worklog 2026-11-20).
//
// CONTRACT (the same census discipline as the baked lane, enforced here):
//   · a runtime entry is a CARD row: card + hf_only true, every benchmark
//     cell null — it can never join pivotAll, so no Score, rank, grade,
//     harmonization or avg-set math can see it (same red lines as stats-87).
//   · identity only: name, org, created date, downloads/likes, params from
//     the safetensors header — nothing is fabricated; an absent field stays
//     null.
//   · quantized/mirror repos are refused (same curation discipline as the
//     baked lane's _HF_LANE_QUANT_RE — the lane tracks upstream releases).
//   · a repo whose derived display name already exists on the board (ranked
//     or census) is refused — one row per product, no duplicate rows, and a
//     ranked/census row's meta can never be shadowed by a runtime record.
//   · everything lives in THIS browser's localStorage (versioned key); the
//     shipped snapshot is never touched. A baked lane row with the same
//     name always wins over a runtime duplicate (store merge rule).
//   · auto-graduate stays future-proof: once a repo gets an OpenRouter
//     listing, the next data refresh bakes it properly and the merge rules
//     hand the row to the baked census (baked wins, runtime dup drops).
//
// This module owns STORAGE + VALIDATION + FETCH only. Row/meta building for
// the reactive store lives in stores/data.js (it re-derives rows from
// runtimeEntries on every snapshot change — one source of truth, no drift).

import { ref } from 'vue';

export const RUNTIME_HF_STORAGE_KEY = 'bl_runtime_hf_v1';
export const RUNTIME_HF_SCHEMA_VERSION = 1;
export const HF_API_BASE = 'https://huggingface.co/api/models/';

// org/repo — letters/digits/dots/dashes/underscores, exactly one slash.
// (URL prefixes are stripped by normalizeHfInput before this runs.)
const REPO_ID_RE = /^[\w][\w.-]*\/[\w][\w.-]*$/;

// Parity with the scraper's _HF_LANE_QUANT_RE (stats-93): quantized builds,
// merged/franken models and mirror repos never enter the lane.
const QUANT_RE = /(gguf|awq|gptq|nvfp4|int[48]|fp[48]|mlx|onnx|bnb|4-?bit|8-?bit|uncensored|heretic|frankenmoe|unlocked|-it$)/i;

// stats-70 norm-key discipline: '+' is identity-bearing; everything else
// non-alphanumeric folds. Used for the board-collision guard.
const normKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9+]/g, '');

// ── Input normalization ────────────────────────────────────────────────────
// Accepts a bare repo id ("org/repo") or a pasted HF URL
// ("https://huggingface.co/org/repo", "hf.co/org/repo", with ?ref=… / #…).
// Returns the clean "org/repo" or null (not repo-shaped / wrong slash count).
export function normalizeHfInput(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\//i, '')
       .replace(/^(www\.)?(huggingface\.co|hf\.co)\//i, '')
       .replace(/[?#].*$/, '')
       .replace(/\/+$/, '');
  // datasets repos are out of scope — the lane tracks model releases
  s = s.replace(/^datasets\//i, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const id = parts[0] + '/' + parts[1];
  return REPO_ID_RE.test(id) ? id : null;
}

// Cheap check for the picker: does the query look like it MIGHT be a repo?
// (looser than normalize — "org/repo" mid-typing should offer the add
// option). Full validation happens in addRuntimeRepo.
export function isRepoShaped(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  const s = raw.trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^(www\.)?(huggingface\.co|hf\.co)\//i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
  return /^[^/]+\/[^/]+$/.test(s);
}

// ── Storage (SSR-safe — same guards as stores/data.js) ───────────────────
function openStorage() {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  return window.localStorage;
}

function readStored() {
  try {
    const ls = openStorage();
    if (!ls) return [];
    const raw = ls.getItem(RUNTIME_HF_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== RUNTIME_HF_SCHEMA_VERSION || !Array.isArray(parsed.repos)) {
      return [];
    }
    // keep only shape-valid entries (storage may be hand-edited / stale)
    return parsed.repos.filter(e => e && typeof e.hf_id === 'string' && REPO_ID_RE.test(e.hf_id));
  } catch { return []; }
}

function persist(list) {
  try {
    const ls = openStorage();
    if (!ls) return; // storage unavailable (private mode) — session-only lane
    if (!list.length) ls.removeItem(RUNTIME_HF_STORAGE_KEY);
    else ls.setItem(RUNTIME_HF_STORAGE_KEY, JSON.stringify({ version: RUNTIME_HF_SCHEMA_VERSION, repos: list }));
  } catch { /* storage blocked/full — the add still works for the session */ }
}

// ── Module state (singleton, like the stores) ────────────────────────────
const entries = ref([]);   // [{ hf_id, added, name, org, created, downloads, likes, pipeline_tag, total_params_b }]
const loaded = ref(false);

function ensureLoaded() {
  if (loaded.value) return;
  entries.value = readStored();
  loaded.value = true;
}

// Read the persisted lane AT MODULE INIT — the data store derives census
// rows from these entries on every boot, so a reload must rehydrate the
// lane before the first render (deep links ?models=<runtime-slug> resolve
// through the slug index that reads this).
ensureLoaded();

// Display name = repo basename (the baked lane's convention: "org/Repo-X"
// → "Repo-X"). Collision safety comes from the add guard, not the derivation.
export const repoBase = (hfId) => {
  const parts = String(hfId).split('/');
  return parts.length === 2 ? parts[1] : String(hfId);
};

// ── Row + meta builders (SAME shapes as the scraper's lane builders) ─────
export function buildRuntimeRow(entry, allBenchmarks) {
  const row = {
    name: entry.name,
    num_benchmarks: 0,
    cl: 0,
    card: true,
    hf_only: true,
    runtime: true,
    'Epoch ECI': null, // explicit so the ECI column renders its dash
  };
  for (const b of allBenchmarks || []) row[b] = null;
  return row;
}

export function buildRuntimeMeta(entry) {
  return {
    or_id: null,
    or_name: null,
    provider: entry.org || null,
    created: entry.created ?? null,
    context_length: null,
    max_output_tokens: null,
    modality: null,
    input_modalities: [],
    output_modalities: [],
    tokenizer: null,
    knowledge_cutoff: null,
    total_params_b: entry.total_params_b ?? null,
    active_params_b: null,
    params_source: entry.total_params_b != null ? 'huggingface' : null,
    pricing_usd_per_1m: null,
    reasoning: null,
    supported_parameters: [],
    hugging_face_id: entry.hf_id,
    or_free_variants: null,
    description: null,
    superseded_by: null,
    match: 'runtime-hf',
    hf_only: true,
    hf_runtime_added: entry.added ?? null,
  };
}

// ── HF fetch (identity only — one request per add, no polling) ───────────
export async function fetchHfRepo(hfId) {
  // the HF API wants the slash intact ("org/repo") — encode per segment
  const url = HF_API_BASE + String(hfId).split('/').map(encodeURIComponent).join('/');
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    if (res.status === 404 || res.status === 401) {
      throw new Error(`"${hfId}" is not a public Hugging Face repo (HTTP ${res.status}).`);
    }
    if (res.status === 429) {
      throw new Error('Hugging Face rate limit hit — try again in a minute.');
    }
    throw new Error(`Hugging Face returned HTTP ${res.status}.`);
  }
  const p = await res.json();
  const sf = p?.safetensors ?? null;
  const total = sf && typeof sf.total === 'number' ? sf.total : null;
  return {
    hf_id: hfId,
    name: repoBase(hfId),
    org: String(hfId).split('/')[0],
    created: (p?.createdAt || '').slice(0, 10) || null,
    downloads: typeof p?.downloads === 'number' ? p.downloads : null,
    likes: typeof p?.likes === 'number' ? p.likes : null,
    pipeline_tag: typeof p?.pipeline_tag === 'string' ? p.pipeline_tag : null,
    total_params_b: total ? Math.round((total / 1e9) * 10) / 10 : null,
  };
}

// ── Add / remove ──────────────────────────────────────────────────────────
// knownNames — every name already on the board (ranked + census). A repo
// whose display name collides is refused. Returns:
//   { ok: true, entry }                                   — added
//   { ok: false, reason, error, entry? }                  — refused / failed
// reasons: 'bad-shape' | 'quant' | 'already-added' | 'already-on-board' | 'fetch'
export async function addRuntimeRepo(rawId, { knownNames = [] } = {}) {
  ensureLoaded();
  const hfId = normalizeHfInput(rawId);
  if (!hfId) {
    return { ok: false, reason: 'bad-shape', error: 'Use a Hugging Face repo id like "org/model-name".' };
  }
  if (QUANT_RE.test(hfId)) {
    return { ok: false, reason: 'quant', error: 'That looks like a quantized/mirror repo — the lane tracks upstream model releases.' };
  }
  const existing = entries.value.find(e => e.hf_id === hfId);
  if (existing) {
    return { ok: false, reason: 'already-added', error: `"${hfId}" is already in your HF lane.`, entry: existing };
  }
  // collision check BEFORE the fetch — the display name is the repo
  // basename (deterministic), so a doomed add costs zero requests
  const nameGuess = repoBase(hfId);
  const guessNorm = normKey(nameGuess);
  if (guessNorm && knownNames.some(n => normKey(n) === guessNorm)) {
    return { ok: false, reason: 'already-on-board', error: `"${nameGuess}" is already on the board — nothing to add.` };
  }
  let entry;
  try {
    entry = await fetchHfRepo(hfId);
  } catch (e) {
    return { ok: false, reason: 'fetch', error: e?.message || 'Hugging Face fetch failed.' };
  }
  const stored = { ...entry, added: new Date().toISOString().slice(0, 10) };
  entries.value = [...entries.value, stored];
  persist(entries.value);
  return { ok: true, entry: stored };
}

export function removeRuntimeRepo(name) {
  ensureLoaded();
  const before = entries.value.length;
  entries.value = entries.value.filter(e => e.name !== name);
  if (entries.value.length !== before) {
    persist(entries.value);
    return true;
  }
  return false;
}

export function runtimeRepoCount() {
  ensureLoaded();
  return entries.value.length;
}

// Test hook: wipe module state and re-read from the CURRENT window storage
// (tests install a fake globalThis.window first, then call this).
export function __resetRuntimeHfForTests() {
  loaded.value = false;
  ensureLoaded();
}

// The store derives census rows + meta records from these entries on every
// snapshot change — baked rows always win the merge (see stores/data.js).
export { entries as runtimeEntries };
