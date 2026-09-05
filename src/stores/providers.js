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

export function useProviders() {
  return { rawData, loading, error, ensureProvidersLoaded };
}
