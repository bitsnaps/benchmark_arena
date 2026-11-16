// ── Leaderboard UI store (module-level singleton) ─────────────────────
// Cross-view state: search filter + side-by-side compare selection +
// freshness/coverage controls (older versions toggle, min-CL slider) +
// seller-side controls (free-listing toggle, max-price slider, seller pick).

import { ref, watch } from 'vue';

const searchQuery = ref('');
const compareMode = ref(false);
const compareRows = ref([]);

// Older (superseded) versions are hidden from the default leaderboard;
// the toggle interleaves them INLINE in the same ranking (dimmed, unranked).
const showOlder = ref(false);
// Min-coverage slider (CL %): rows below the threshold are hidden.
// 0 = show everything. Coverage opacity tiers stay visible otherwise.
const minCl = ref(0);

// ── Availability filters (stats-18 "available at" layer) ──────────────
// freeOnly: keep rows with a FREE LISTING at some seller (free ≠ unlimited
// — rate limits apply; the UI carries the caveat wherever "free" shows).
// maxPrice: keep rows whose 3:1 blended $/1M is at most this, with free
// listings counting as $0 (so the two filters compose). null = no cap.
// sellerId: keep rows listed by that provider's catalog ('' = any).
const freeOnly = ref(false);
const maxPrice = ref(null);
const sellerId = ref('');

// ── stats-34: input-modality filter ───────────────────────────────────
// '' = any; 'image' | 'audio' | 'video' = rows whose input_modalities
// include the token. Rows with UNKNOWN modalities hide while a filter is
// on (same honesty rule as the price cap hiding unpriced rows).
const modFilter = ref('');

// ── stats-79: "New & unranked" reveal toggle ──────────────────────────
// The unranked census is a traceability surface (is model X still pending
// its first probe?), not a default view: hidden unless asked for. The
// choice persists to localStorage under a versioned key; ?unranked=1 deep
// links win over the stored value on load (HomeView owns the param sync).
const UNRANKED_STORAGE_KEY = 'bl_unranked_v1';
const UNRANKED_SCHEMA_VERSION = 1;
const readStoredUnranked = () => {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    const raw = window.localStorage.getItem(UNRANKED_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return parsed && parsed.version === UNRANKED_SCHEMA_VERSION ? parsed.on === true : false;
  } catch { return false; }
};
const showUnranked = ref(readStoredUnranked());
watch(showUnranked, (on) => {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (!on) window.localStorage.removeItem(UNRANKED_STORAGE_KEY);
    else window.localStorage.setItem(
      UNRANKED_STORAGE_KEY,
      JSON.stringify({ version: UNRANKED_SCHEMA_VERSION, on: true }),
    );
  } catch { /* storage blocked/full — the toggle still works for the session */ }
}, { flush: 'sync' });

// ── stats-85: ECI reference-column toggle ─────────────────────────────
// The ECI column (Epoch Capabilities Index) is a display-only calibration
// reference — it never feeds the Score blend (stats-82 contract). Ibrahim
// (2026-11-16): "add ECI to the list of benchmarks, so the user
// select/deselect from the drop-down list" — so the Avg-set panel's ECI
// checkbox toggles COLUMN VISIBILITY only. Default ON (ECI leads, per the
// approved first-class design). Only the OFF state is written to
// localStorage under a versioned key, so the shipped default survives
// cleared storage; ?eci=0 deep links hide, ?eci=1 forces back on and wins
// over the stored value on load (HomeView owns the param sync).
const ECI_COL_STORAGE_KEY = 'bl_eci_col_v1';
const ECI_COL_SCHEMA_VERSION = 1;
const readStoredEci = () => {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return true;
    const raw = window.localStorage.getItem(ECI_COL_STORAGE_KEY);
    if (!raw) return true;
    const parsed = JSON.parse(raw);
    return parsed && parsed.version === ECI_COL_SCHEMA_VERSION ? parsed.on !== false : true;
  } catch { return true; }
};
const showEci = ref(readStoredEci());
watch(showEci, (on) => {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (on) window.localStorage.removeItem(ECI_COL_STORAGE_KEY);
    else window.localStorage.setItem(
      ECI_COL_STORAGE_KEY,
      JSON.stringify({ version: ECI_COL_SCHEMA_VERSION, on: false }),
    );
  } catch { /* storage blocked/full — the toggle still works for the session */ }
}, { flush: 'sync' });

// Leaving compare mode resets the selection
watch(compareMode, (on) => {
  if (!on) compareRows.value = [];
});

const isSameModel = (a, b) => a.name === b.name;

// Cap side-by-side at 5 models
const canCheck = (row) =>
  compareRows.value.some(r => r.name === row.name) || compareRows.value.length < 5;

const clearCompare = () => { compareRows.value = []; };

// Teal highlight for the best score per benchmark among compared rows
const isBest = (bench, row) => {
  if (row[bench] === null || row[bench] === undefined) return false;
  const max = Math.max(...compareRows.value.map(r => r[bench] ?? -1));
  return max > 0 && row[bench] === max;
};

export { UNRANKED_STORAGE_KEY, UNRANKED_SCHEMA_VERSION, ECI_COL_STORAGE_KEY, ECI_COL_SCHEMA_VERSION };

export function useLeaderboard() {
  return {
    searchQuery, compareMode, compareRows, showOlder, minCl,
    freeOnly, maxPrice, sellerId, modFilter, showUnranked, showEci,
    isSameModel, canCheck, clearCompare, isBest,
  };
}
