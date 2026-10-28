// ── Providers store (module-level singleton, mirrors data.js) ─────────
// Powers the /providers page: per-provider model price catalogs built by
// bench_scraper.py (LiteLLM catalog + OpenRouter API) into providers.json.
// Lazy on purpose — only this view calls ensureProvidersLoaded(), so the
// ~400KB catalog never slows the leaderboard's first paint.

import { ref } from 'vue';

const rawData = ref(null);
const loading = ref(true);
const error = ref(null);

let pending = null;

export function ensureProvidersLoaded() {
  if (rawData.value) return Promise.resolve();
  if (!pending) {
    pending = (async () => {
      try {
        const res = await fetch('providers.json');
        if (!res.ok) throw new Error(String(res.status));
        rawData.value = await res.json();
      } catch {
        error.value = 'Failed to load provider pricing data.';
      } finally {
        loading.value = false;
      }
    })();
  }
  return pending;
}

// stats-66: hard re-fetch of the catalog (Ibrahim: "prices are changing
// constantly"). GitHub Pages serves JSON with browser caching, so a revisit
// can silently show yesterday's deploy — the refresh button busts the cache
// with a one-shot query param + no-store and swaps the data in place. On
// failure we keep whatever is already on screen and surface the error.
export async function reloadProviders() {
  loading.value = true;
  error.value = null;
  try {
    const res = await fetch('providers.json?cb=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    rawData.value = await res.json();
  } catch {
    error.value = 'Refresh failed — showing the data already on screen. Check the connection and try again.';
  } finally {
    loading.value = false;
  }
}

export function useProviders() {
  return { rawData, loading, error, ensureProvidersLoaded, reloadProviders };
}
