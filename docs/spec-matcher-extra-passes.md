# Spec: matcher extra passes (stats-39)

Approved by Ibrahim 2026-09-16 after the dry run ("yes, let's implement it … compare
results before vs after … so we can revert changes in case needed").

## Goal

Close the measured gap the conservative matcher leaves on reseller listings: route
and preview SKUs of models the arena DOES track currently land as unmatched. Dry run
(`scripts/matcher_eval/`, UnoRouter dump × 2026-09-15 catalog): 67→74 unique keys
(37→41%), 88→95 SKU pairs, +7 pairs, 0 regressions.

## Non-goals

- No catalog-side normalization (`-beta` strips) — grok-4.20-reasoning stays unmatched.
- No effort (`-high/-low`) / `-chat-latest` passes — 0 measured gain, defer until a
  real gateway ships them.
- No UI/schema/storage changes; no e2e fixture changes (pure-logic change + labels).

## Design

`matchOne(key, index, rawBase = null)` — optional third param. All new passes live in
one delimited block AFTER the shipped passes; without `rawBase` behavior is
byte-identical to today (revert = delete the block, or just stop passing rawBase).

Passes (raw-anchored, in order, each re-normalizing and handing the remainder to the
shipped matcher so strip+dated / strip+thinking combos work):

| pass | raw regex | example |
|---|---|---|
| `preview` | `[-_.]preview([-_.]\d{2,4})?$` | gemini-3-pro-preview → Gemini 3 Pro |
| `route` | `[-_.](nitro\|online\|search\|exp\|latest)$` | glm-5.3-search → GLM-5.3 |
| `thinksearch` | `[-_.]think(ing)?[-_.]search$` | glm-5.2-think-search:free → GLM-5.2 |

Guards (inherited + new): strips only fire on the RAW id with a separator boundary
(never the squashed normKey — kills `quark-search`→`quark` false positives); stripped
remainder ≥5 chars; final gate is still an exact index hit. No prefix matching — the
Fable 5→5.1 trap stays structurally impossible.

## File changes

1. `src/lib/myProviders.js`
   - `parseModelListing`: keep `base` (raw id minus `[variant]`/`:free`) on each model.
   - `matchOne(key, index, rawBase = null)`: delimited extra-pass block (above).
   - `matchListing`: pass `m.base ?? null` through.
2. `src/components/MyProvidersPanel.vue`: extend `PASS_LABEL` (preview/route/thinksearch;
   combo labels arrive as `route+dated` etc. and fall back to the raw string — acceptable).
3. `tests/unit/myProviders.test.js`: positive cases per pass, guard negatives
   (no separator → no strip; short remainder; strip misses index; combo strip+dated),
   plus a direction-B pin: `matchOne(key, index)` 2-arg call unchanged.

## Verification (the before/after contract)

- `scripts/matcher_eval/before_after.mjs before` captured 88 SKU pairs pre-change.
- After implementation: `node before_after.mjs after` must print
  `kept=88 added=7 lost=0` and `DIFF VERDICT: CLEAN` (added set == dry-run prediction).
- Unit suite + full prepush gate; then deploy and re-verify the harness against prod data.
