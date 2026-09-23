# Spec: Compare-tab score column (stats-40)

Ibrahim: "I'd rather like the lighter column that shows the unified scores (or one of the
benchmarks, user can select...) — it can be hidden with a simple toggle."

## Decision shape

Two options were on the table: (a) swap the Compare pivot's column dimension (models ×
score-sources) or (b) the LIGHTER hybrid — keep the models × providers price pivot untouched
and add ONE optional reference column. Ibrahim picked (b).

## Design

- **Toggle**: `score` switch in the Compare tab controls (next to `batch variants`), default
  OFF — current behavior is byte-identical when off. State persists locally
  (`arena.providers.score-col`) and deep-links as `?score=1&src=<bench>` (URL beats stored
  state when present, same contract as `?view=`).
- **Source select**: appears when the toggle is on — `Unified (CL)` default, plus every
  benchmark in the snapshot (`SHORT` labels). Unknown `?src=` values reset to unified.
- **Column placement**: between Model and the seller columns — a score is a per-MODEL
  property (same discipline as latency/created, stats-24/27), so ONE value per row no matter
  how many selected sellers list the model. Seller cells, cheapest-teal highlighting, pricing
  filters, coverage counts are never affected.
- **Values**: `unified` → the store's `scoreForModel` (the exact CL-weighted aggregate the
  leaderboard ranks by — parity by construction, no re-derivation). A benchmark source → the
  row's raw cell on that leaderboard's OWN 0-100 scale (header tooltip warns columns are not
  cross-comparable; Unified is the comparable one). Formatting/colors via the shared
  `fmtScore`/`scoreColor`.
- **Join**: reuses the my-gateways staged matcher (`buildCatalogIndex` + `matchOne` over
  `r.key`) — both opt-in layers always agree on WHAT a row is. No new matching discipline.
- **Honesty**: a row whose model is not on the board (or has no cell on the chosen
  benchmark) renders `—`, never a fabricated score. Catalog long tail (fine-tunes, niche
  hosts) is mostly off-board; that is expected and stays visible.
- **Sorting**: the Score header participates in the existing column-sort cycle — first click
  sorts descending (scores read best high→low), unlike price columns which start ascending.

## Tests

- e2e (`providers.e2e.mjs` §5d): default-off, toggle reveals, unified value equals the
  stats-35 mirror for a spot-checked model, benchmark source equals the raw snapshot cell,
  off-board row renders `—`, header sort descending, deep link restores source, toggle-off
  cleans the URL, zero console errors.
- No new lib surface: the view composes already-unit-tested pure functions
  (`buildCatalogIndex`, `matchOne`, `scoreForModel`).
