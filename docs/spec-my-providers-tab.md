# stats-37 — "My Providers" re-homed into the Providers page as a third tab

Approved by Ibrahim 2026-09-14 (msg 1549110998869352469, "LGTM, let's start
implementing the migration spec") after the providers-custom-3 reflection.
This is a **re-home, not a rewrite**: everything stats-36 shipped (matcher,
store, add/paste flow, matched/unlisted split, honest dashes, read-only score
mirroring) survives unchanged; only the shell moves from the standalone
`/my-providers` page into the existing Providers page.

## 1. Summary

The Providers page (`/providers`) already owns the "who sells which models,
at what price" domain: tab 1 lists catalog sellers (providers.json, refreshed
nightly), tab 2 is the stats-18 Compare pivot. A user's own gateway is just
another seller, so "My providers" becomes tab 3 of the same page — one
destination for everything provider-shaped, no dedicated navbar item, and the
future v2 (an opt-in "my provider" column in the Compare pivot) becomes a
same-page/state problem instead of a cross-page one.

## 2. Goals / Non-goals

Goals
- Third `b-tab-item` "My providers" on `/providers`, deep-linkable via
  `?view=mine` (extending the existing `?view=compare` grammar).
- Legacy `/my-providers` URLs keep working via a router redirect.
- Shared search scopes rows inside the panel (with browse mode), consistent
  with tab 1's search semantics.
- Restyle the add/edit modal with the page's Buefy-native form controls
  (`b-field` / `b-input` / `b-radio`), keeping every aria-label (e2e contract).
- Navbar drops the standalone item (6 → 5 top-level entries).

Non-goals (v2 candidates, unchanged from providers-custom-2/3)
- No Compare-pivot column for user providers (per-SKU `[1m]`/`:free` matched
  rows vs canonical pivot rows needs its own mapping pass).
- No pricing filters on tab 3; no CORS proxy; no manual link-to-catalog
  overrides; no extra matcher passes; no backend/account sync.

## 3. Invariants (must hold after the migration)

1. **User data is an additive overlay.** Nothing from localStorage is ever
   merged into the catalog arrays: footer counts (`N of M catalog rows`),
   guard invariants, the price-filter slider universe (`catalogMaxBlend`)
   and the Compare pivot all stay catalog-only. Tab 3 renders regardless of
   the catalog's loading/error state — its only catalog touchpoint is the
   read-only mirror from `benchmark_results.json` via the data store.
2. **Scores / CL / reference prices stay mirrored READ-ONLY** at render time
   via data-store accessors; nothing score-shaped is written to localStorage
   (stats-36 contract, unchanged).
3. **Zero data migration.** The storage key (`ba.myproviders.v1`), the store
   schema, and the export payload kind (`benchmark-arena-my-providers`) are
   untouched — visitors who added providers under stats-36 keep them.
4. **Home stays untouched** (Ibrahim's standing rule). The only home-adjacent
   change is the navbar item removal in App.vue; no HomeView code or chunk
   content changes.

## 4. Changes

| File | Change |
|------|--------|
| `src/components/MyProvidersPanel.vue` | **New.** The stats-36 view extracted into a panel component; props `{ search }`; page head dropped (the Providers page owns the page head — one compact safety line remains); per-provider cards / tables / intent question / danger zone / export-import unchanged. Shared-search scoping computed (`cards`): row-level filter on arena name + listing id, browse mode on label / base URL, non-matching cards drop off (mirrors tab 1). |
| `src/views/ProvidersView.vue` | Third tab renders `<MyProvidersPanel :search="q" />` with no catalog guards; tab deep-link map extended (`compare`→1, `mine`→2); page-head copy gains one clause; header comment updated to three tabs. Pricing filters stay per-tab inside tabs 1–2 (already the case — nothing to remove). |
| `src/router/index.js` | `/my-providers` → `redirect` to `{ name: 'providers', query: { view: 'mine' } }`; site-map comment updated. |
| `src/App.vue` | "My Providers" navbar item removed. |
| `src/views/MyProvidersView.vue` | **Deleted** (content lives in the panel). |
| `src/lib/myProviders.js` | Header comment only ("powers the My Providers tab"). |
| `tests/e2e/myproviders.e2e.mjs` | Retargeted to the tab: navbar-item-absent check, redirect check, tab-click check, `?view=mine` deep link; full paste journey unchanged (same selectors); new shared-search scoping checks (row filter + browse mode + unlisted section collapsing away); persistence, clear-all, console clean unchanged. |
| `tests/e2e/home.e2e.mjs` | Pinned navbar list updated to the 5 remaining items. |

Unit tests need no change: `lib/myProviders.js` and `stores/myProviders.js`
are byte-untouched.

## 5. Acceptance

- Full prepush gate green (unit + leak guard + build + all e2e specs).
- `verify_prod_stats37.mjs` against the live site: new bundle, home sanity
  with 5-item navbar, `/my-providers` redirect lands on the tab, tab click
  works, paste journey (2-of-3 banner, mirrored score, `[1m]` chip, unlisted
  row), search scoping, persistence, clear-all, console clean.
- `docs/` spec committed separately before implementation (stats-34 precedent).
