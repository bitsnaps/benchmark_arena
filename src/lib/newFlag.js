// ── NEW badge: flag freshly released models ────────────────────────────
// stats-27, Ibrahim: "flagging `new` for new released models, so when we
// run a fresh scraping data these `new` models will get this tag" — with a
// user-adjustable window (default 7 days, 14/30 also offered).
//
// Design (approved proposal): DATE-BASED, not scrape-diff-based. The flag
// is computed at render time from models_meta.created (the date the model
// was added to the OpenRouter catalog — already mined by bench_scraper.py
// and published in benchmark_results.json), so every fresh scrape
// re-evaluates it automatically: new models get the badge the moment the
// pipeline picks them up and it expires on its own, with zero pipeline
// state. Records without a `created` date never get a badge (honest gap,
// same policy as the latency layer).
//
// Granularity: per-MODEL, like latency. The badge joins via normalized API
// id (normKey — org prefix stripped), so a new provider LISTING of an old
// model never lights up; only genuinely new models do.

import { ref } from 'vue';
import { normKey } from './pivot.js';

// Window choices offered in the UI. 7 days is the shipped default (Ibrahim:
// "instead of 30-day window let's make it 7-day and the user can change it
// via the UI").
export const NEW_WINDOW_CHOICES = [7, 14, 30];
export const NEW_WINDOW_DEFAULT = 7;
const NEW_WINDOW_KEY = 'arena.newWindow';

// ── Shared singleton window state (pager.js / priceFilter.js pattern) ──
// One module-level ref so every surface (home rows, provider cards, Compare
// rows, model cards, the selector controls) shows and changes the SAME
// window; the choice persists per device.
function loadWindow() {
  try {
    const v = parseInt(localStorage.getItem(NEW_WINDOW_KEY), 10);
    return NEW_WINDOW_CHOICES.includes(v) ? v : NEW_WINDOW_DEFAULT;
  } catch { return NEW_WINDOW_DEFAULT; } // node tests / private mode
}

export const newWindowDays = ref(loadWindow());

export function setNewWindowDays(d) {
  const v = NEW_WINDOW_CHOICES.includes(Number(d)) ? Number(d) : NEW_WINDOW_DEFAULT;
  newWindowDays.value = v;
  try { localStorage.setItem(NEW_WINDOW_KEY, String(v)); } catch { /* private mode */ }
}

// Pure: has this model been released within the last `windowDays` days?
// CALENDAR-day semantics (UTC date boundaries), not fractional hours — a
// model released exactly 7 dates ago still counts on the 7th day, matching
// how the selector labels ("7 days") read to a human. `created` is the
// models_meta.created string ("YYYY-MM-DD", full ISO also accepted); null /
// missing / unparseable → false (honest gap). `now` defaults to the real
// clock but is injectable for tests and data-driven verification.
const dayFloor = (ms) => Math.floor(ms / 86400000);
export function isNewModel(created, now = Date.now(), windowDays = newWindowDays.value) {
  const w = Number(windowDays);
  if (created == null || !Number.isFinite(w) || w < 0) return false;
  const t = Date.parse(String(created));
  if (!Number.isFinite(t)) return false;
  return dayFloor(now) - dayFloor(t) <= w;
}

// Pure: normKey(or_id)-first, normKey(meta key)-fallback index of release
// dates — the exact join discipline of ttftIndexFromMeta (stats-24), so a
// catalog id ('anthropic/claude-fable-5.1'), an OpenRouter listing id, or a
// meta display name all resolve to the same model's date.
export function createdIndexFromMeta(meta) {
  const idx = new Map();
  for (const [name, m] of Object.entries(meta || {})) {
    const created = m && m.created;
    if (!created) continue;
    const byId = normKey(m.or_id);
    if (byId && !idx.has(byId)) idx.set(byId, String(created));
    const byName = normKey(name);
    if (byName && !idx.has(byName)) idx.set(byName, String(created));
  }
  return idx;
}

// Pure: resolve one pivot row's release date — first joining id wins, the
// row key (already normalized) as fallback; null when the row joins nothing.
export function createdForRow(row, idx) {
  if (!row || !idx) return null;
  for (const id of row.ids || []) {
    const hit = idx.get(normKey(id));
    if (hit) return hit;
  }
  return idx.get(row.key) ?? null;
}

// One place for the badge tooltip wording (and for tests to assert on).
export function newBadgeTitle(created, windowDays = newWindowDays.value) {
  return `Released ${created} (per OpenRouter) · flagged NEW for ${windowDays} days — change the window with the "New badge" selector`;
}

// Selector tooltip (the control's own hint).
export const NEW_WINDOW_HINT =
  'Models released within this many days carry a NEW badge (release date per OpenRouter). The window applies everywhere — leaderboard, provider cards, Compare rows and model cards.';
