// stats-21: ONE shared page size for every paginated surface — the home
// leaderboard, the Compare pivot and the per-provider cards. Options and
// default are identical everywhere so the number of pages per table feels
// the same ("users won't be surprised"), and changing the size on any one
// table changes it on all of them. 0 = All — the pre-pagination full
// scroll, kept as an explicit choice rather than a special case.
import { ref, watch } from 'vue';

export const PAGE_ALL = 0;
export const PAGE_SIZES = [20, 50, 100]; // plus PAGE_ALL ("All")
export const DEFAULT_PAGE_SIZE = 50;

const KEY = 'arena.pagesize';
// stats-20 kept per-table sizes — folded into the shared setting on first read
const LEGACY_KEYS = ['arena.pagesize.home', 'arena.pagesize.pivot'];

// Accept only the shipped options; anything else (corrupt localStorage, the
// old pivot-only 25) folds back to the default so every table agrees.
export function sanitizePageSize(v) {
  if (v === PAGE_ALL || v === 20 || v === 50 || v === 100) return v;
  return DEFAULT_PAGE_SIZE;
}

const intOf = (raw) => {
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
};

// Pure read (unit-tested): the shared key wins; otherwise the newest legacy
// per-table key migrates (25 folds to 50); otherwise the default.
export function readStoredSize(get) {
  const own = get(KEY);
  if (own != null) return sanitizePageSize(intOf(own));
  for (const k of LEGACY_KEYS) {
    const raw = get(k);
    if (raw != null) return sanitizePageSize(intOf(raw));
  }
  return DEFAULT_PAGE_SIZE;
}

// Module-level singleton — every surface reads and writes the same ref.
const stored = (() => {
  try {
    const size = readStoredSize((k) => localStorage.getItem(k));
    for (const k of LEGACY_KEYS) localStorage.removeItem(k);
    localStorage.setItem(KEY, String(size));
    return size;
  } catch { return DEFAULT_PAGE_SIZE; } // private mode — session-only size
})();

const pageSize = ref(stored);
watch(pageSize, (v) => {
  try { localStorage.setItem(KEY, String(v)); } catch { /* private mode */ }
});

export function usePageSize() { return pageSize; }

// Never strand a page pointer past the last page.
export function clampPage(p, totalPages) {
  return Math.min(Math.max(1, p), Math.max(1, totalPages));
}
