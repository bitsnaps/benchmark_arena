# stats-51 spec — custom pricing keys for My Providers + side-by-side gateway cells

Ibrahim (post-stats-49.1): *"I'd go for your previous last suggestion regarding the
feature that allow users to define custom key names for input/output pricing… the
pricing is deeply nested to `pricing.input_per_1M_tokens`… we don't want to lock our
app on that specific provider's output. I liked the live check idea, it will help
users to check the results before hitting the Fetch & Add button. Also feeding the
unlisted-rows sounds good to me."*

Reference shape (his real `/v1/models` entry): `pricing.{input,output}_per_1M_tokens`
as per-1M numbers — no OpenRouter `prompt`/`completion` at all, so the built-in
extractor never saw these prices (honest dash today).

## Part A — per-provider pricing keys (the lens)

- Provider config gains optional `priceKeys: { input, output, unit }`
  (`unit: 'token' | '1m'`, default token). Storage schema stays **v1** — purely
  additive; records without the field load untouched; `importPayload` maps it
  defensively (hand-edited garbage imports as null, feature off).
- Two dot-path inputs + an explicit unit radio in the Add/Edit modal. Paths are
  sanitized (`sanitizeKeyPath`): letters/digits/`_`/`$`/`-` segments, `[n]` array
  indexes normalized to `.n.`, ≤16 segments / ≤128 chars, `__proto__` /
  `constructor` / `prototype` rejected outright.
- **Raw entries persist**: `coerceModel` now keeps the original listing entry
  (`raw`) per model — within the "config + raw listings" contract — so keys
  resolve at RENDER time. Editing a key re-prices My Providers + Compare
  instantly, no re-sync (critical for paste mode). Legacy pre-stats-51 models
  resolve `pricing.*` paths through a shim over the already-persisted pricing
  subtree; deeper paths honestly miss and the preview suggests a re-sync.
- **Per-side priority**: custom key wins when it yields a valid number, else
  that side falls back to the built-in prompt/completion path — configuring
  keys can only ADD prices, never break working providers. A key that resolves
  to a non-numeric value is an honest null for that side (garbage must not
  silently un-fall-back into a wrong-shaped number); the preview warns.
- **No unit guessing** (carried discipline): the radio is explicit; a light
  auto-SUGGEST pre-selects per-1M when the key name says so
  (`/per.?1.?m/i`), one click to override, preview shows final numbers either way.

## Part B — the live check (preview before commit)

`previewPricingKeys(models, priceKeys)` (pure, unit-tested) powers a preview
line in the modal: "N of M listed models priced via your keys · sample
`gpt-6-sol` → in $2.11 / out $10.55 per 1M" plus honest counters (entries
falling back to standard pricing, non-numeric key hits, legacy records).
Sources: pasted text (add/paste-import, live per keystroke), the stored listing
(edit — the lens), or a dry-run **"Test keys on the live listing"** button in
add-fetch mode (nothing persisted). Preview samples show EXACT values
(`fmtSample`), not `fmtUsd`'s table rounding — $10.55 vs $11 is exactly the
difference being verified.

## Part C — Compare cells go side by side

Gateway ("mine") cells adopt the catalog cell format: `$in/$out` per 1M
side by side (Ibrahim: "show them side by side into the Compare tab as well").
The 3:1 blend that drives sorting, undercut markers and comparisons stays in
the tooltip. Partial pricing becomes visible (`$—/$11`) instead of an unpriced
dash. Tooltip gains a provenance marker when prices came via custom keys.

## Part D — bug fix found during implementation

The unlisted-rows "Provider $/1M" column called `extractPricing(props.row)` on
the row WRAPPER (no prompt/completion on it) — it dashed even when the provider
published prices. Now reads the row's precomputed key-aware price. Ibrahim's
"feeding the unlisted-rows sounds good to me" is implemented by the same
key-aware extractor.

## Invariants kept (stats-38, unchanged)

Overlay never touches `row.cells`; cheapest-cell highlighting, filters, coverage
counts and the slider universe stay catalog-only; nothing score- or price-shaped
is computed at storage time; honest gaps everywhere (no fabricated numbers).

## Tests

- Unit (myProviders.test.js → 49): sanitize/normalize (incl. prototype
  pollution), resolveKeyPath (deep nesting, arrays, misses), parsePriceValue
  (currency strings, garbage), extractPricingFor (Ibrahim shape, unit modes,
  per-side fallback, garbage→null, legacy shim, string entries), preview
  counters, overlay + headline over key-priced SKUs, legacy provider parity.
- e2e (myproviders.e2e.mjs): new Sol Gateway journey — keys auto-suggest the
  unit, preview BEFORE save, two mine columns, `$2.11/$11` side-by-side cell,
  blend+provenance tooltip, broken-key edit → live warn → `$—/$11` partial
  cell (no re-sync) → restore re-prices instantly. 8c's blend assertion
  updated to the new side-by-side format (`$2/$10`).
