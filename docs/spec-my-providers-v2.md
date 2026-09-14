# stats-38 spec — "My gateways" Compare-pivot columns (v2) + My Providers style polish

Ibrahim (post-migration review): *"let's continue and move to implement the v2 as you
described, the style is just to polish the UI (looks like some missing paddings/margins
on the form and the listing of my-providers table), keep buttons design consistent with
other previous pages."*

Two deliverables, one PR: the v2 Compare integration promised in the stats-37 spec's
non-goals, and the styling pass Ibrahim flagged.

## Part A — v2: opt-in "my gateways" columns on the Compare pivot

The Compare tab joins catalog sellers into one row per canonical model. v2 overlays the
user's own gateways as EXTRA columns so his price sits beside the catalog's — the exact
question v2 exists for: "am I paying less via my gateway?"

### Invariants (all inherited, none new)
1. **Additive overlay** — user cells live OUTSIDE `row.cells` (in a separate `row.mine`
   map). Coverage counts, `cheapestPid` highlighting, `filterMatrix`, the price slider
   universe and every guard stay catalog-only by construction.
2. **Read-only mirrors** — gateway prices come from the user's parsed listing at render
   time; nothing score- or price-shaped is written to localStorage.
3. **Zero catalog pollution** — the overlay is computed per render from
   `useMyProviders()` + a `buildCatalogIndex` over `pivotAll`/`modelsMeta` (the same
   pure, unit-tested pieces the panel uses).
4. **Honest gaps** — no published price → dash; not served → absent dot; free twin →
   free chip with the rate-limit caveat. Never fabricated.

### Behavior
- A `my gateways` switch joins the batch-variants switch in the Compare controls. It
  renders only when ≥1 connected provider has ≥1 chat-capable listing (else the column
  would be pure noise). State persists (`arena.providers.mine-col`).
- When ON: one column per user provider, appended after catalog columns, header =
  provider label with a dashed accent + "mine" marker. Sorting by a mine column works
  (`cells[pid] ?? mine[pid]` fallback in the comparator).
- **Row join**: per pivot row, `matchOne(r.key, catalogIndex)` resolves the arena row
  (the SAME staged matcher the panel uses — exact → dated → thinking), then the overlay
  map (arena name → that provider's matched SKUs) supplies cells. One user SKU can
  legitimately surface on a base row and a dated-snapshot twin row — both rows ARE the
  same arena model; the tooltip enumerates SKUs either way.
- **Headline SKU** (`headlineSku`): cheapest PAID SKU by the 3:1 blend wins (the paid
  SKU is the product comparable to catalog cells); no paid blend → a free twin (blend 0,
  free chip); neither → listed-but-unpriced dash. Every SKU (id, variant tag, in/out,
  free) stays visible in the cell tooltip.
- **Undercut marker** (`undercutsMine`): when the headline blend undercuts the row's
  cheapest CATALOG blend (`rowBlend(r)`, catalog-only by construction) → a small green
  "cheaper" marker on the mine cell with both numbers in the tooltip. Neutral when
  higher; absent when either side is unpriced.
- Coverage line gains the mine columns in its count and a short "via your gateways"
  suffix when active; the tab-2 legend paragraph documents the honesty rules.

### Pure lib additions (unit-tested, no Vue)
- `buildMineOverlay(providers, index)` → `Map<arenaName, Map<providerId, sku[]>>`
  (chat-only, same CHAT_ENDPOINTS rule).
- `headlineSku(skus)` → `{ kind: 'paid'|'free'|'unpriced', cell }`.
- `undercutsMine(mineBlend, catalogBlend)` → boolean|null.

## Part B — style polish (Ibrahim's list)

Diagnosis: `.panel-lab` carries no global padding — every other page pads it inline
(`padding:1.2rem`); the three My Providers surfaces (cards, empty state, modal) didn't,
which is exactly the "missing paddings/margins" he saw. Buttons used pill `.chip`s plus
an off-brand `--acc` blue, while the rest of the app uses Buefy `b-button` for actions
and chips only for selections.

- Padding/margins: `1.2rem` on `.mp-card` / `.mp-empty` / `.mp-modal` (the app-wide
  panel-lab convention); section header / banner / table spacing tuned.
- Buttons → the app's action vocabulary (aria-labels unchanged):
  - `Add provider`, modal save → `b-button type="is-primary"` (matches ComparePanel /
    ModelDetailView primary CTAs);
  - Export / Import / Resync / Edit / Cancel → default `b-button size="is-small"`;
    Import becomes a real button over a hidden file input and stays enabled with zero
    providers (import must work on a fresh browser);
  - Clear all / Delete → `b-button type="is-danger"` outlined → solid when armed
    (two-step arming preserved);
  - intent-question options stay `.chip` (they ARE selection chips, same as
    Advisor/Benchmarks);
  - busy state moves from a "Working…" string to Buefy's `:loading` spinner.

## Part C — tests

- Unit (tests/unit/myProviders.test.js): overlay mapping (chat-only, free/variant
  flags, honest null pricing), headlineSku (paid-beats-free, cheapest-paid, free-only,
  unpriced-only, partial pricing), undercutsMine truth table.
- e2e (myproviders.e2e.mjs): fixture gains OpenRouter-style `pricing` blocks + an
  `:free` twin of an arena model; new journey asserts the switch → column header →
  exact blended cell for a priced SKU → honest dash for an unpriced SKU → absent dot
  for a non-served row → multi-SKU tooltip on hover → toggle persists across reload →
  columns vanish on clear-all. Counts updated (banner 4 of 6, search scoping 3/4/4).
- home.e2e navbar pin unchanged (still 5 items).

## Non-goals (unchanged)

CORS proxy worker, manual link overrides, extra matcher passes, backend sync — the v2
candidate list stays as banked in stats-36/37.
