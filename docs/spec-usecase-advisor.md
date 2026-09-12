# Use-case Advisor — Spec (stats-33)

Status: DRAFT for review · Owner: @bitsnaps · Source of truth: this file
Upstream discussion: Discord 2026-09-12 (use-case card list, top-5 shortlist confirmed by Ibrahim)

## 1. Summary

A 4-step wizard at `#/advisor` that turns user intent — what they're doing, how they trade
quality against cost and latency, and any hard constraints — into a ranked shortlist of up
to 5 models with generated, data-grounded reasons. Everything is computed client-side,
deterministically, from the same JSON snapshot the leaderboard uses. No backend, no
LLM-in-the-loop, no pipeline changes.

Design ethos: the advisor is a **re-weighted leaderboard, not a heuristic**. Every number
on a tile must be traceable to `benchmark_results.json` through the same formulas the rest
of the site uses.

## 2. Goals / Non-goals

Goals (v1):
- 6 use-case profiles incl. a dedicated **Vision & media** card (Ibrahim: "an entire use
  case for some users").
- Shortlist of **5** tiles with reasons, deep links into `/model/:id` and Compare.
- Shareable deep-link state, consistent with `?tier=` / `?avg=` patterns.
- Honest handling of sparse/unknown data (flags, never silent zeros).

Non-goals (v1):
- No audio / video / image-*generation* recommendations (modality data expansion is
  explicitly future work per Ibrahim; v1 vision = image *input* only).
- No LLM-in-the-loop, no backend, no persistence beyond the URL.
- No admin UI — the config file IS the admin surface.
- No provider-level price comparison inside the advisor (Providers page covers that).

## 3. UX

### 3.1 Route & nav

- Route `{ path: '/advisor', name: 'advisor', component: AdvisorView }` (lazy-loaded).
- Nav entry **"Advisor"** placed directly after "Leaderboard" — it is the decision entry
  point (proposal; easy to move). Mobile is safe: navbar already collapses to a burger.

### 3.2 Steps (adapted from Ibrahim's template)

| Step | Content |
|---|---|
| 0 | Use case — 6 cards: Coding · Agentic workflows · Hard reasoning · Everyday chat · Creative writing · **Vision & media** |
| 1 | Priority (cost-first / balanced / quality-first) + Speed (snappy / a few s is fine / think as long as you want) |
| 2 | Hard constraints: min context (any / 128K+ / 200K+ / 1M+) · vision required (no/yes) · weights (any / open-weights only / hosted API only) · max blended $/1M (no cap / $1 / $4 / $12) · **strict mode toggle** (see 3.6) |
| 3 | Shortlist (≤5) with reasons; tiles link to `/model/:id` + "Compare" button; "Start over" resets |

- Step 0 requires a choice before Continue (as in template).
- Choosing **Vision & media** pre-sets *vision required = yes* on step 2 (user can change it).

### 3.3 Deep links

`#/advisor?use=coding&priority=balanced&speed=ok&ctx=200000&vision=1&open=any&cap=4&strict=0`

- Opening with `use` present jumps straight to results (step 3) using defaults for any
  missing params. No params → step 0. Back/forward must work (router query sync).

## 4. Scoring model

### 4.1 Use-case profiles (config data, `src/config/advisorProfiles.js`)

| Profile | Benchmarks | Column coverage today* |
|---|---|---|
| coding | DeepSWE, SWE-Marathon, FrontierSWE, CyberGem | 21 / 17 / 9 / 22 of 115 |
| agentic | VendingBench, SWE-Marathon, ARC-AGI-2 | 50 / 17 / 48 |
| reasoning | ARC-AGI-2, SimpleBench.com | 48 / 27 |
| chat | Arena.ai Text, BenchLM.ai, Artificial Analysis | 91 / 90 / 73 |
| creative | EQBench CW, Design Arena | 43 / 18 |
| vision | Design Arena (+ image-input filter) | 18 |

\* non-null per-benchmark cells across the 115 unified rows (snapshot 2026-09-11 02:34).
Coverage is why §4.2 exists — FrontierSWE (9) and Design Arena (18) are too thin to stand alone.

### 4.2 Profile score & coverage fallback

- `profileScore(m, p)` = **sparse mean** of m's non-null scores on `p.benches` — the same
  "plain average of the scores a model actually has" semantics as the leaderboard's
  `scoreForModel`. Reuse the store function; do NOT duplicate the math.
- Coverage tag per model: `solid` (≥2 profile benches covered) · `thin` (exactly 1) ·
  `limited` (0 covered → fall back to the core-8 sparse mean, the leaderboard default set).
- Tiles display the tag ("limited data — showing general score"). No silent blending.

### 4.3 Priority × speed weight table (all 9 combos, sum = 1)

| priority \ speed | fast | ok | think-long |
|---|---|---|---|
| **cost-first** | q .38 · c .42 · s .20 | q .45 · c .45 · s .10 | q .50 · c .50 · s 0 |
| **balanced** | q .53 · c .27 · s .20 | q .60 · c .30 · s .10 | q .70 · c .30 · s 0 |
| **quality-first** | q .73 · c .12 · s .15 | q .80 · c .15 · s .05 | q .84 · c .16 · s 0 |

(q = profile quality, c = cost, s = speed)

### 4.4 Cost score

- **Blended price recipe**: `blended = (3×input + 1×output) / 4` USD per 1M tokens
  (3:1 input:output assumption, shown in a tooltip). `cache_read` ignored in v1.
- Source precedence: `pricing_usd_per_1m` (OpenRouter, 88/107 models) →
  `pricing_aa_usd_per_1m` (75/107) → unknown.
- Normalization over the snapshot: `costScore = 1 − (log1p(p) − log1p(p_min)) / (log1p(p_max) − log1p(p_min))`
  where p_min/p_max are the min/max blended prices among models with known price
  (log scale — prices span ~3 orders of magnitude). Data-driven, never hard-coded.
- Free-tier signal: models with `or_free_variants` get a "free variant available" chip
  (thin today: 4/107 — displayed when present, never a ranking factor in v1).

### 4.5 Speed score

- From `aa_ttft_seconds` (65/107): same log normalization shape as cost. TTFT only —
  no throughput data; stated in a UI footnote ("latency = time-to-first-token").

### 4.6 Per-model weight renormalization (unknowns ≠ zero)

For each model, only components with known data participate; weights renormalize to sum 1
over the known components. An unknown never penalizes — it just doesn't vote, and the tile
flags it ("price unlisted", "TTFT unlisted"). A model with no scores at all is excluded
("no benchmark coverage").

### 4.7 Hard constraints (step 2) & strict mode

| Constraint | Default (pass + flag) | Strict mode |
|---|---|---|
| min context | unknown context_length passes, tile flags "context unlisted" | unknowns dropped |
| vision required | unknown modality passes + flag | unknowns dropped |
| price cap | unknown price passes + flag | unknowns dropped |
| open weights | `open` = model ∈ unified_open set (43) · `api` = ∈ unified_closed (72) · `any` = union — membership, not the sparse `hugging_face_id` field (54/107) | n/a (always exact) |

Strict mode = one toggle on step 2, persisted as `strict=1`. Default off — hard filters on
62%-coverage fields would silently kill a third of the catalog.

### 4.8 Ranking, tie-breaks, shortlist

1. Apply constraints → surviving models.
2. Composite = Σ wᵢ·scoreᵢ over known components (§4.3 + §4.6).
3. Sort desc; tie-breaks in order: higher profile coverage count → lower blended price
   (unknown = +∞) → newer `created`.
4. Take **5** (Ibrahim-confirmed). Ranks shown 1–5, #1 tagged "Recommended".

### 4.9 Reasons (generated, deterministic order, max 3 + flags)

Quality → price → speed → open/free, then flags. Examples:
- "Best coding score among models under $4/1M"
- "2nd profile score, 3.1× cheaper than #1"
- "Fastest listed TTFT (0.42s)" · "Open weights" · "Free variant available"
- Flags: "limited data — showing general score" · "context unlisted" · "price unlisted"

### 4.10 Empty state with a smart hint (P1)

If nothing survives, compute for each constraint how many models a one-notch relaxation
would admit and surface the biggest: "No model fits. Relaxing the price cap to $12 would
add 7 options." Deterministic, cheap, and turns a dead end into guidance.

## 5. File plan

| File | Role |
|---|---|
| `src/config/advisorProfiles.js` | Data only: profiles, weight table, price recipe, cap ladders |
| `src/lib/advisor.js` | Pure functions (no Vue imports): profileScore, blendedPrice, cost/speed score, composite, constraints, rank, buildReasons, emptyStateHint |
| `src/views/AdvisorView.vue` | Wizard UI (Buefy/lab-token styling adapted from Ibrahim's template) |
| `src/router/index.js`, `src/App.vue` | Route + nav entry |
| unit + e2e tests | see §6 |

No changes to scraper / merge / guard / cron — the advisor is client-side over the
existing snapshot; the daily pipeline is untouched.

## 6. Testing

Unit (golden, deterministic):
- Weight table: all 9 combos sum to 1; spot-check each cell.
- Blended price: `(3·10 + 1·50)/4 = 20` golden; source precedence OR→AA→unknown.
- Sparse-mean parity: advisor profileScore ≡ store scoreForModel on the same subset.
- **DeepSeek variant sanity**: coding profile ranks V4 Pro 0813 above V4 Flash 0731
  (stats-32 ground truth must survive the new feature).
- Renormalization: unknown-TTFT model under balanced/fast still sums weights to 1.
- Constraints: unknowns pass+flag by default, drop in strict; open-weights membership
  uses unified_open.
- Tie-breaks: coverage → price → created ordering.

E2E: wizard flow (coding → balanced → cap $4 → 5 tiles with reasons), deep-link restores
state, start-over resets, empty-state hint renders. Prepush gate extended with these.

## 7. Open points (non-blocking, veto-friendly)

1. Nav placement: "Advisor" right after "Leaderboard".
2. Vision profile is Design-Arena-proxied + core-mean fallback until a real vision bench
   lands — honest footnote in UI, flagged tiles.
3. `cache_read` ignored in the blended price (v1 simplification).
4. Vision & media auto-sets vision-required (user can undo on step 2).
