// ── Pricing filter: one reusable core for every seller-side surface ────
// stats-23. The "free only" toggle + "max price" slider used to live
// separately in the Compare pivot (filterMatrix in pivot.js) and on the
// home leaderboard (leaderboard store) — same contract, two copies. This
// module owns the contract once so every surface (By provider, Compare,
// and future adopters) filters identically and can never drift.
//
// The contract (unchanged since stats-18/19, now written down in ONE place):
//   freeOnly  — keep only rows with a FREE LISTING. Free ≠ unlimited: the
//               UI carries the rate-limit caveat wherever "free" shows.
//   maxPrice  — keep priced rows whose 3:1 in:out blended $/1M is at most
//               the cap. FREE rows survive ANY cap — the predicate owns the
//               "free counts as $0" rule (cellBlend and priceFor both blend
//               free to 0 anyway); rows with NO price at all are hidden
//               while a cap is active (nothing to compare) and survive when
//               there is no cap. null cap = no filtering.
//
// State follows the pager.js pattern: module-level singleton refs, so
// every component that calls usePriceFilter() shares one filter state and
// the tabs can never disagree.

import { computed, ref } from 'vue';
import { fmtUsd } from './format.js';

// The slider maps its 0–100 position onto $/1M CUBICALLY so the
// interesting sub-$10 zone keeps most of the track (same shape the
// Compare tab shipped with in stats-19).
export const SLIDER_EXP = 3;

// Pure: slider position (0..100) → absolute $/1M blended cap.
// 100 means "any price" → null. maxBlend (the largest blend in the active
// universe) only shapes the scale; it is clamped to ≥ 1 so the mapping
// stays sane before data loads.
export function capFromSlider(v, maxBlend, exp = SLIDER_EXP) {
  if (v >= 100) return null;
  const top = Math.max(1, Number(maxBlend) || 1);
  return Math.round(top * Math.pow(v / 100, exp) * 100) / 100;
}

// Pure: THE pricing-filter predicate. `item` is opaque (catalog row, pivot
// row, leaderboard row — anything); the caller supplies the two resolved
// facts per row:
//   blend — the 3:1 in:out blended $/1M, or null when the row lists no
//           price at all
//   free  — whether the row carries a free listing (suffix twin, zero
//           price, or a provider-level free tier)
// The predicate OWNS the "free counts as $0" rule: a free row survives any
// cap regardless of the blend passed in, so a caller cannot forget it.
export function passesPricing(item, { blend, free }, { freeOnly = false, maxPrice = null } = {}) {
  if (freeOnly && !free) return false;
  if (maxPrice != null && !free && (blend == null || blend > maxPrice)) return false;
  return true;
}

// ── Shared singleton state ─────────────────────────────────────────────
const freeOnly = ref(false);
const sliderVal = ref(100); // 100 = any price

// Largest 3:1 blend in the active universe — the data-owning view keeps
// this current (ProvidersView derives it from the whole catalog so ONE
// slider position means the SAME cap on every tab). It only shapes the
// slider's $ scale, never the row filters themselves.
export const priceUniverseBlend = ref(1);

export function usePriceFilter() {
  const maxPrice = computed(() => capFromSlider(sliderVal.value, priceUniverseBlend.value));
  const maxPriceLabel = computed(() => (maxPrice.value == null
    ? 'any price'
    : `≤ ${fmtUsd(maxPrice.value)}/1M blended`));
  return { freeOnly, sliderVal, maxPrice, maxPriceLabel };
}
