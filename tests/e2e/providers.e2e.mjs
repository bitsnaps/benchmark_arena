// Providers page e2e: nav link, catalog render, search narrowing, price cells.
// Runs under tests/run-e2e.mjs (vite preview on 4173, base /benchmark_arena/).
// Expectations are derived from the committed public/providers.json snapshot.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMatrix, sortMatrixRows, isBatchRow, DEFAULT_COLUMNS, cellBlend, latencyTier, normKey } from '../../src/lib/pivot.js';
import { capFromSlider } from '../../src/lib/priceFilter.js';
import { isNewModel, createdIndexFromMeta } from '../../src/lib/newFlag.js';
import { fmtUsd } from '../../src/lib/format.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = path.join(REPO, 'tests', 'e2e', 'shots');
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173/benchmark_arena/';

const catalog = JSON.parse(fs.readFileSync(path.join(REPO, 'public/providers.json'), 'utf8'));
const benchDoc = JSON.parse(fs.readFileSync(path.join(REPO, 'public/benchmark_results.json'), 'utf8'));
const modelsMeta = benchDoc.models_meta || {};
const KIND_LABEL = {
  'first-party': 'First-party labs',
  'cloud': 'Cloud platforms',
  'serverless': 'Serverless hosts',
  'aggregator': 'Aggregators & gateways',
};

let passed = 0, failed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };
const fail = (m) => { failed++; console.error(`  ✗ ${m}`); };

const run = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  try {
    // ── 1. Home → nav to Providers ──────────────────────────────────
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.click('nav.navbar .navbar-start >> text=Providers');
    await page.waitForURL('**/#/providers', { timeout: 10000 });
    await page.waitForSelector('.prov-card', { timeout: 10000 });
    ok('nav link lands on #/providers with provider cards rendered');

    // ── 2. Catalog completeness (derived from the committed JSON) ───
    const cards = await page.locator('.prov-card').count();
    if (cards === catalog.providers.length) ok(`all ${cards} provider cards rendered`);
    else fail(`provider cards: expected ${catalog.providers.length}, got ${cards}`);

    // ── 2a. stats-22 labs vs providers regroup: two super-sections ──
    const superTitles = (await page.locator('.prov-super-title').allInnerTexts()).map(s => s.trim());
    if (superTitles.join('|') === 'Providers|Labs')
      ok('super-sections render in order: Providers, then Labs');
    else fail(`super-sections wrong: "${superTitles.join('", "')}"`);
    const provCount = catalog.providers.filter(p => p.kind !== 'first-party').length;
    const labCount = catalog.providers.length - provCount;
    const provSection = page.locator('.prov-super', { has: page.locator('.prov-super-title', { hasText: 'Providers' }) });
    const labSection = page.locator('.prov-super', { has: page.locator('.prov-super-title', { hasText: 'Labs' }) });
    const provCards = await provSection.locator('.prov-card').count();
    const labCards = await labSection.locator('.prov-card').count();
    if (provCards === provCount) ok(`Providers section holds all ${provCards} third-party sellers`);
    else fail(`Providers section: expected ${provCount} cards, got ${provCards}`);
    if (labCards === labCount) ok(`Labs section holds all ${labCount} first-party labs`);
    else fail(`Labs section: expected ${labCount} cards, got ${labCards}`);

    for (const kind of catalog.kinds.filter(k => k !== 'first-party')) {
      const title = page.locator('.prov-kind-title', { hasText: KIND_LABEL[kind] });
      if (await title.count() === 1) ok(`kind sub-section "${KIND_LABEL[kind]}" present under Providers`);
      else fail(`kind sub-section "${KIND_LABEL[kind]}" missing`);
    }
    const kindTitles = await page.locator('.prov-kind-title').count();
    if (kindTitles === catalog.kinds.length - 1)
      ok('Labs carries its cards directly (no redundant first-party sub-header)');
    else fail(`kind sub-headers: expected ${catalog.kinds.length - 1}, got ${kindTitles}`);

    // stats-22 round 2: header summary stats — seller count chip + model total
    const provN = (await provSection.locator('.prov-sec-n').innerText()).trim();
    const labN = (await labSection.locator('.prov-sec-n').innerText()).trim();
    if (provN === String(provCount) && labN === String(labCount))
      ok(`header count chips match (${provCount} providers / ${labCount} labs)`);
    else fail(`count chips wrong: "${provN}" / "${labN}"`);
    const sumRows = (ps) => ps.reduce((a, p) => a + p.models.length, 0);
    const thirdParty = catalog.providers.filter(p => p.kind !== 'first-party');
    const labsOnly = catalog.providers.filter(p => p.kind === 'first-party');
    const provStats = await provSection.locator('.prov-sec-stats').innerText();
    const labStats = await labSection.locator('.prov-sec-stats').innerText();
    if (provStats.includes(`${sumRows(thirdParty)} models`) && labStats.includes(`${sumRows(labsOnly)} models`))
      ok(`header stats carry model totals (Providers ${sumRows(thirdParty)}, Labs ${sumRows(labsOnly)})`);
    else fail(`header stats wrong: "${provStats.trim()}" / "${labStats.trim()}"`);

    // ── 2c. stats-22 round 2: collapsible behavior ─────────────
    await page.click('button:has-text("Collapse all")');
    await page.waitForTimeout(250);
    if (await page.locator('.prov-card:visible').count() === 0)
      ok('collapse all hides every card');
    else fail(`collapse all: ${await page.locator('.prov-card:visible').count()} cards still visible`);
    if (await page.locator('.prov-section-head').count() === 2)
      ok('both section headers (with their stats) stay visible when collapsed');
    else fail(`headers after collapse: ${await page.locator('.prov-section-head').count()}`);
    const ariaClosed = await labSection.locator('.prov-section-head').getAttribute('aria-expanded');
    if (ariaClosed === 'false') ok('aria-expanded flips on collapse');
    else fail(`aria-expanded after collapse: "${ariaClosed}"`);

    // state persists across reload
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.prov-section-head', { timeout: 10000 });
    if (await page.locator('.prov-card:visible').count() === 0)
      ok('collapsed state persists across reload');
    else fail(`persistence: ${await page.locator('.prov-card:visible').count()} cards visible after reload`);

    await page.click('button:has-text("Expand all")');
    await page.waitForTimeout(250);
    const visAll = await page.locator('.prov-card:visible').count();
    if (visAll === catalog.providers.length) ok(`expand all restores all ${visAll} cards`);
    else fail(`expand all: ${visAll}/${catalog.providers.length} visible`);

    // single-section toggle: only Labs folds, Providers stays open
    await labSection.locator('.prov-section-head').click();
    await page.waitForTimeout(250);
    const labsVis = await labSection.locator('.prov-card:visible').count();
    const provsVis = await provSection.locator('.prov-card:visible').count();
    if (labsVis === 0 && provsVis === provCount)
      ok(`section header toggles independently (Labs folded, Providers keeps ${provsVis})`);
    else fail(`single toggle: labsVisible=${labsVis} provsVisible=${provsVis} (expected 0/${provCount})`);
    await labSection.locator('.prov-section-head').click();
    await page.waitForTimeout(250);

    // an active search force-expands so matches are never hidden; clearing
    // the search restores the stored (collapsed) state
    await page.click('button:has-text("Collapse all")');
    await page.waitForTimeout(250);
    await page.fill('input.input', 'opus');
    await page.waitForTimeout(400);
    const visSearch = await page.locator('.prov-card:visible').count();
    if (visSearch > 0) ok(`search force-expands sections (${visSearch} cards visible while searching)`);
    else fail('search while collapsed hid all matches');
    await page.fill('input.input', '');
    await page.waitForTimeout(400);
    if (await page.locator('.prov-card:visible').count() === 0)
      ok('clearing the search restores the stored collapsed state');
    else fail('cleared search did not restore collapsed state');
    await page.click('button:has-text("Expand all")'); // restore for the specs below
    await page.waitForTimeout(250);

    // The biggest provider's card shows its full model count
    const biggest = [...catalog.providers].sort((a, b) => b.models.length - a.models.length)[0];
    const card = page.locator('.prov-card', { has: page.locator('.prov-name', { hasText: biggest.name }) });
    const sub = await card.locator('span.cell-sub').first().innerText();
    if (sub.includes(String(biggest.models.length))) ok(`"${biggest.name}" card reports ${biggest.models.length} models`);
    else fail(`"${biggest.name}" count text "${sub.trim()}" lacks ${biggest.models.length}`);

    // ── 2b. Keyless API providers (stats-17: NVIDIA NIM / OpenCode Zen / OrcaRouter)
    const apiProv = (name) => catalog.providers.find(p => p.name === name);
    const isFree = (m) => !!m.free || (m.in === 0 && (m.out ?? 0) === 0);

    const nim = apiProv('NVIDIA NIM');
    if (nim && nim.models.length >= 80) ok(`"NVIDIA NIM" card carries ${nim.models.length} rows`);
    else fail(`NVIDIA NIM card missing or thin: ${nim?.models.length}`);

    const zen = apiProv('OpenCode Zen');
    const zenFree = zen ? zen.models.filter(isFree) : [];
    if (zen && zenFree.length >= 5 && zenFree.every(m => m.base)) {
      ok(`"OpenCode Zen" free listings carry their base id (${zenFree.length})`);
    } else fail(`OpenCode Zen free listings wrong: ${zenFree.length} free`);

    const orca = apiProv('OrcaRouter');
    const orcaPriced = orca ? orca.models.filter(m => m.in != null) : [];
    const orcaFree = orca ? orca.models.filter(isFree) : [];
    if (orca && orcaPriced.length > 100 && orcaFree.length >= 4) {
      ok(`"OrcaRouter" card priced=${orcaPriced.length} free=${orcaFree.length}`);
    } else fail(`OrcaRouter wrong: priced=${orcaPriced.length} free=${orcaFree.length}`);

    // card sub-line reports its free count
    const zenCard = page.locator('.prov-card', { has: page.locator('.prov-name', { hasText: 'OpenCode Zen' }) });
    const zenSub = await zenCard.locator('span.cell-sub').first().innerText();
    if (zenSub.includes(`${zenFree.length} free`)) ok(`OpenCode Zen card reports "${zenFree.length} free"`);
    else fail(`OpenCode Zen card sub lacks free count: "${zenSub.trim()}"`);

    // header stats line mentions free listings
    const statsLine = await page.locator('span.cell-sub', { hasText: 'catalog rows' }).first().innerText();
    if (/free listings/.test(statsLine)) ok(`header stats mention free listings ("${statsLine.trim()}")`);
    else fail(`header stats lack free count: "${statsLine.trim()}"`);

    // an unpriced NVIDIA row renders an honest dash (no fabricated price)
    const nimCard = page.locator('.prov-card', { has: page.locator('.prov-name', { hasText: 'NVIDIA NIM' }) });
    const nimDash = await nimCard.locator('.prov-table tbody tr').first().locator('td.num').first().innerText();
    if (nimDash.trim() === '—') ok('NVIDIA NIM row shows an honest dash (no fabricated price)');
    else fail(`NVIDIA NIM price cell: "${nimDash}"`);

    // free chip tooltip carries the rate-limit caveat (free ≠ unlimited)
    // stats-26: Buefy b-tooltip — hover the chip, read the .tooltip-content
    const freeChip = zenCard.locator('.free-chip').first();
    await freeChip.hover();
    await page.waitForSelector('.tooltip-content:visible', { timeout: 5000 });
    const tip = (await page.locator('.tooltip-content:visible').first().innerText()).replace(/\s+/g, ' ');
    if (/rate limit/i.test(tip)) ok(`free chip tooltip carries the rate-limit caveat`);
    else fail(`free chip tooltip wrong: ${tip}`);
    await page.mouse.move(0, 0); // close the tooltip before the next probe
    // hovering the chip scrolled deep into the card list — go back up, or
    // the sticky navbar covers the header controls for the steps below
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);

    // ── 3. Search narrows across providers ──────────────────────────
    const q = 'opus';
    await page.fill('input.input', q);
    await page.waitForTimeout(400); // debounced re-render
    const narrowed = await page.locator('.prov-card').count();
    const shown = await page.locator('.prov-card', { hasText: q }).count();
    const narrowedRows = catalog.providers
      .map(p => ({ p, hits: p.models.filter(m => (m.id + ' ' + (m.name || '')).toLowerCase().includes(q)) }))
      .filter(x => x.hits.length || x.p.name.toLowerCase().includes(q));
    if (narrowed === narrowedRows.length && narrowed < catalog.providers.length) {
      ok(`search "${q}" narrows to ${narrowed}/${catalog.providers.length} providers (matches snapshot)`);
    } else fail(`search "${q}": expected ${narrowedRows.length} cards, got ${narrowed} (visible-with-text ${shown})`);
    await page.screenshot({ path: SHOTS + '/providers-search.png' });

    // ── 4. Price cells formatted as USD ─────────────────────────────
    await page.fill('input.input', '');
    await page.waitForTimeout(400);
    const firstNum = await page.locator('.prov-table tbody tr >> nth=0').locator('td.num').first().innerText();
    if (/^\$\d/.test(firstNum.trim())) ok(`price cell formatted (${firstNum.trim()})`);
    else fail(`price cell not USD-formatted: "${firstNum}"`);
    await page.screenshot({ path: SHOTS + '/providers.png', fullPage: false });

    // ── 4b. stats-23: pricing filters on By provider (shared with Compare) ──
    // The controls are the SAME reusable widget as the Compare tab's — one
    // component (PriceFilterControls) over one shared state (lib/priceFilter.js
    // singleton). Expectations derive from the committed catalog with the
    // shipped helpers — honest, not hardcoded.
    await page.waitForSelector('.pv-controls', { timeout: 10000 });
    ok('By provider carries the pricing-filter controls (free only + max price)');

    await page.selectOption('.prov-size select', '0'); // All — full tables for honest counting
    await page.waitForTimeout(300);

    const isFreeListing = (p, m) => !!m.free || !!p.free_tier || (m.in === 0 && (m.out ?? 0) === 0);
    const blendOf = (p, m) => cellBlend({ in: m.in, out: m.out, free: isFreeListing(p, m) });
    const allRows = catalog.providers.reduce((a, p) => a + p.models.length, 0);
    const freeSets = catalog.providers
      .map(p => ({ p, rows: p.models.filter(m => isFreeListing(p, m)) }))
      .filter(x => x.rows.length);
    const freeRowsExp = freeSets.reduce((a, x) => a + x.rows.length, 0);

    // free only: sellers narrow to those with ≥1 free listing, every shown
    // row is free, and every shown row carries its free chip
    await page.click('.pv-controls >> text=free only');
    await page.waitForTimeout(400);
    const freeCards = await page.locator('.prov-card').count();
    const freeRowsDom = await page.locator('.prov-card .prov-table tbody tr').count();
    const freeChips = await page.locator('.prov-card .prov-table .free-chip').count();
    if (freeCards === freeSets.length && freeRowsDom === freeRowsExp && freeChips === freeRowsExp)
      ok(`free toggle narrows By provider to ${freeCards} sellers / ${freeRowsDom} free rows (chips honest)`);
    else fail(`free toggle: cards ${freeCards}/${freeSets.length} rows ${freeRowsDom}/${freeRowsExp} chips ${freeChips}/${freeRowsExp}`);

    // the header totals line tracks the filter
    const freeTotals = await page.locator('span.cell-sub', { hasText: 'catalog rows' }).first().innerText();
    if (freeTotals.includes(`${freeRowsExp} of ${allRows} catalog rows`))
      ok(`totals line tracks the free filter ("${freeTotals.trim()}")`);
    else fail(`totals line wrong: "${freeTotals.trim()}"`);

    await page.click('.pv-controls >> text=free only'); // off again
    await page.waitForTimeout(300);
    const restoredCards = await page.locator('.prov-card').count();
    if (restoredCards === catalog.providers.length)
      ok(`free toggle off restores all ${restoredCards} seller cards`);
    else fail(`free toggle off: expected ${catalog.providers.length} cards, got ${restoredCards}`);

    // price cap: slider at mid-track → cubic cap over the catalog scale;
    // unpriced rows hide (OpenCode Zen non-free), pricier sellers drop out
    const blends = catalog.providers
      .flatMap(p => p.models.map(m => blendOf(p, m)))
      .filter(b => b != null);
    const universeMax = Math.max(1, Math.ceil(Math.max(...blends)));
    const cap = capFromSlider(50, universeMax);
    const capSets = catalog.providers
      .map(p => ({ p, rows: p.models.filter(m => { const b = blendOf(p, m); return b != null && b <= cap; }) }))
      .filter(x => x.rows.length);
    const capRows = capSets.reduce((a, x) => a + x.rows.length, 0);
    await page.locator('.pv-controls [role="slider"]').first().focus();
    for (let i = 0; i < 50; i++) await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(400);
    const capLabel = await page.locator('.pv-controls .pm-price-label').innerText();
    const capRowsDom = await page.locator('.prov-card .prov-table tbody tr').count();
    if (capRowsDom === capRows && capLabel === '≤ ' + fmtUsd(cap) + '/1M blended')
      ok(`price cap "${capLabel}" narrows to ${capRowsDom} rows blending ≤ ${fmtUsd(cap)}`);
    else fail(`price cap: label "${capLabel}" rows ${capRowsDom}/${capRows} (expected ≤ ${fmtUsd(cap)})`);

    // composition: free only + cap → the free rows (they blend to $0) —
    // exactly the free-only set from before
    await page.click('.pv-controls >> text=free only');
    await page.waitForTimeout(400);
    const bothRowsDom = await page.locator('.prov-card .prov-table tbody tr').count();
    if (bothRowsDom === freeRowsExp)
      ok(`free only + cap compose: ${bothRowsDom} rows (free blends to $0, survives any cap)`);
    else fail(`composed filters: expected ${freeRowsExp} rows, got ${bothRowsDom}`);

    // shared state travels: Compare reflects freeOnly + cap set on Tab 1
    const pivotFreeExp = buildMatrix(catalog.providers, DEFAULT_COLUMNS).rows
      .filter(r => !isBatchRow(r) && Object.values(r.cells).some(c => c.free)).length;
    await page.click('.tabs li >> text=Compare');
    await page.waitForSelector('.pm-table', { timeout: 10000 });
    const covText = await page.locator('.pm-coverage').innerText();
    if (covText.includes(`${pivotFreeExp} shown`))
      ok(`Compare inherits Tab 1's filter state (${pivotFreeExp} free rows shown)`);
    else fail(`Compare did not inherit state: "${covText.replace(/\s+/g, ' ').trim()}"`);

    // ...and back: clearing it on Compare restores the cap-only view on Tab 1
    await page.click('.pm-controls >> text=free only'); // off, on the Compare tab
    await page.waitForTimeout(300);
    await page.click('.tabs li >> text=By provider');
    await page.waitForSelector('.prov-card', { timeout: 10000 });
    const backRowsDom = await page.locator('.prov-card .prov-table tbody tr').count();
    const backLabel = await page.locator('.pv-controls .pm-price-label').innerText();
    if (backRowsDom === capRows && backLabel === '≤ ' + fmtUsd(cap) + '/1M blended')
      ok('Compare toggle-off carries back: Tab 1 shows the cap-only view again');
    else fail(`state round-trip: rows ${backRowsDom}/${capRows} label "${backLabel}"`);

    // restore the shared state for the shipped sections below
    await page.locator('.pv-controls [role="slider"]').first().focus();
    for (let i = 0; i < 50; i++) await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    const anyLabel = await page.locator('.pv-controls .pm-price-label').innerText();
    const fullRowsDom = await page.locator('.prov-card .prov-table tbody tr').count();
    if (anyLabel === 'any price' && fullRowsDom === allRows)
      ok(`cap cleared: ${fullRowsDom} catalog rows back, label "any price"`);
    else fail(`cap clear: label "${anyLabel}" rows ${fullRowsDom}/${allRows}`);
    await page.selectOption('.prov-size select', '50');
    await page.waitForTimeout(300);

    // ── 5. Compare pivot tab (stats-18) ─────────────────
    // Expected matrix is derived from the committed providers.json using the
    // SAME matcher the app ships — the check is honest, not hardcoded.
    await page.click('.tabs li >> text=Compare');
    await page.waitForSelector('.pm-table', { timeout: 10000 });
    ok('Compare tab renders the pivot table');

    const { rows: mxRows } = buildMatrix(catalog.providers, DEFAULT_COLUMNS);
    const mxAll = sortMatrixRows(mxRows);
    // stats-19: batch pricing variants are hidden by default — the DOM shows
    // only standard-endpoint rows until the toggle is switched on
    const mx = mxAll.filter(r => !isBatchRow(r));
    const batchRows = mxAll.length - mx.length;
    const expectRows = mx.length;
    const expectNimFree = mx.filter(r => r.cells['nvidia-nim']?.free).length;
    const expectCols = DEFAULT_COLUMNS.length;

    const headCols = await page.locator('.pm-table thead th').count();
    if (headCols === expectCols + 1) ok(`pivot header: ${expectCols} provider columns + Model`);
    else fail(`pivot header columns: expected ${expectCols + 1}, got ${headCols}`);

    // ── pagination (stats-21): bottom-right pager, page numbers between
    // the two arrows, app-wide shared size ────────────────────────────
    await page.waitForSelector('.pm-pager .app-pager', { timeout: 10000 });
    const p1Rows = await page.locator('.pm-table tbody tr').count();
    if (p1Rows === 50) ok('pager defaults to 50 rows on page 1');
    else fail(`pager default page size: expected 50 rows, got ${p1Rows}`);
    const prevArrow = page.locator('.pm-pager [aria-label="Previous page"]');
    const nextArrow = page.locator('.pm-pager [aria-label="Next page"]');
    // page numbers only — Buefy's arrows are PaginationButtons too (icon-only
    // innerText), so scope to the numbered list
    const pageNums = (await page.locator('.pm-pager .pagination-list .pagination-link').allInnerTexts()).map(s => s.trim());
    const ellipsis = await page.locator('.pm-pager .pagination-ellipsis').count();
    const lastPage = String(Math.ceil(mx.length / 50));
    if (await prevArrow.count() === 1 && await nextArrow.count() === 1
        && pageNums[0] === '1' && pageNums[pageNums.length - 1] === lastPage && ellipsis > 0)
      ok(`page numbers sit between the two arrows (${pageNums.join(' ')} of ${lastPage})`);
    else fail(`pager structure wrong: prev=${await prevArrow.count()} next=${await nextArrow.count()} nums=${pageNums.join(' ')} ellipsis=${ellipsis}`);
    const currentLabel = async () => {
      const cur = page.locator('.pm-pager .pagination-list .pagination-link.is-current');
      return (await cur.count()) ? (await cur.innerText()).trim() : '1'; // nav hides when everything fits one page
    };
    const p1First = await page.locator('.pm-table tbody tr .prov-model').first().innerText();
    await nextArrow.click();
    await page.waitForTimeout(300);
    const p2First = await page.locator('.pm-table tbody tr .prov-model').first().innerText();
    if ((await currentLabel()) === '2' && p1First !== p2First)
      ok(`next arrow flips rows ("${p1First}" → "${p2First}")`);
    else fail(`next arrow: current="${await currentLabel()}", first "${p2First}"`);
    // a filter change must land back on page 1 (and the pager quiets down
    // once the filtered result fits a single page)
    await page.fill('input.input', 'opus');
    await page.waitForTimeout(400);
    const navQuieted = await page.locator('.pm-pager nav.pagination').count() === 0;
    if ((await currentLabel()) === '1' && navQuieted) ok('filter change resets to page 1 (single-page result quiets the pager)');
    else fail(`filter reset: expected page 1 + quiet pager, got "${await currentLabel()}" navHidden=${navQuieted}`);
    await page.fill('input.input', '');
    await page.waitForTimeout(300);
    await page.selectOption('.pm-pager select', '0'); // All — legacy expectations below
    // the All-view flush mounts ~1k teleported tooltips — wait for it to settle
    await page.waitForFunction(
      (exp) => document.querySelectorAll('.pm-table tbody tr').length === exp,
      expectRows, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(300);

    const domRows = await page.locator('.pm-table tbody tr').count();
    if (domRows === expectRows) ok(`pivot renders ${domRows} canonical rows by default (batch hidden)`);
    else fail(`pivot rows: expected ${expectRows}, got ${domRows}`);

    // batch-variants toggle reveals the hidden pricing-mode rows (stats-19)
    await page.click('.pm-controls label:has-text("batch variants")');
    await page.waitForTimeout(400);
    const withBatch = await page.locator('.pm-table tbody tr').count();
    if (withBatch === mxAll.length && batchRows > 0)
      ok(`batch toggle reveals all ${withBatch} rows (+${batchRows} pricing variants)`);
    else fail(`batch toggle: expected ${mxAll.length} rows, got ${withBatch}`);
    await page.click('.pm-controls label:has-text("batch variants")'); // off again
    await page.waitForTimeout(300);
    const backRows = await page.locator('.pm-table tbody tr').count();
    if (backRows === expectRows) ok(`batch toggle off restores ${backRows} rows`);
    else fail(`batch toggle off: expected ${expectRows}, got ${backRows}`);

    const coverage = await page.locator('.pm-coverage').innerText();
    if (coverage.includes(`${mxAll.length} canonical models`) && coverage.includes('duplicate ids collapsed') && coverage.includes('batch variants hidden'))
      ok(`coverage line honest ("${coverage.replace(/\s+/g, ' ').trim()}")`);
    else fail(`coverage line wrong: "${coverage.trim()}"`);

    const nimChips = await page.locator('.pm-table .free-chip').count();
    if (nimChips >= expectNimFree) ok(`pivot free chips ≥ NIM's ${expectNimFree} free-tier cells (${nimChips})`);
    else fail(`free chips: expected ≥ ${expectNimFree}, got ${nimChips}`);

    const cheapestCells = await page.locator('.pm-cell.is-cheapest').count();
    if (cheapestCells > 0) ok(`cheapest-cell highlight active on ${cheapestCells} rows`);
    else fail('no cheapest-cell highlight found');

    // ── 5a. stats-24: AA TTFT latency tint ────────────────────────────
    // Expected tints derived from the SAME meta-aware join the app runs —
    // counts are exact, not vibes (batch rows are hidden in this view state).
    const { rows: latRows } = buildMatrix(catalog.providers, DEFAULT_COLUMNS, modelsMeta);
    const latVisible = latRows.filter(r => !isBatchRow(r) && r.latency != null);
    const tierCount = (t) => latVisible
      .filter(r => latencyTier(r.latency) === t)
      .reduce((n, r) => n + Object.keys(r.cells).length, 0);
    const expectLat = latVisible.reduce((n, r) => n + Object.keys(r.cells).length, 0);
    const domLat = await page.locator('.pm-table td.lat-fast, .pm-table td.lat-ok, .pm-table td.lat-slow').count();
    if (domLat === expectLat && expectLat > 0) ok(`latency tint active on exactly ${domLat} measured cells`);
    else fail(`latency tint: expected ${expectLat} tinted cells, got ${domLat}`);
    for (const [tier, sel] of [['fast', 'lat-fast'], ['ok', 'lat-ok'], ['slow', 'lat-slow']]) {
      const got = await page.locator(`.pm-table td.${sel}`).count();
      const exp = tierCount(tier);
      if (got === exp && exp > 0) ok(`${tier} tier tints ${got} cells (< ${tier === 'fast' ? '1.5' : tier === 'ok' ? '3.5' : '∞'} s)`);
      else fail(`${tier} tier: expected ${exp} cells, got ${got}`);
    }
    // stats-25: Buefy b-tooltip (append-to-body) — hover the trigger and read
    // the teleported .tooltip-content (native titles are gone from cells)
    const fableRow = page.locator('.pm-table tbody tr', { has: page.locator('.prov-model', { hasText: 'Claude Fable 5.1' }) });
    await fableRow.locator('td.lat-slow .b-tooltip').first().hover();
    await page.waitForSelector('.tooltip-content:visible', { timeout: 5000 });
    const fableTip = (await page.locator('.tooltip-content:visible').first().innerText()).replace(/\s+/g, ' ');
    if (fableTip.includes('AA TTFT 6.55 s') && fableTip.includes('Artificial Analysis'))
      ok(`cell tooltip (b-tooltip) carries the AA median ("...${fableTip.split('AA TTFT')[1]}")`);
    else fail(`cell tooltip missing TTFT: "${fableTip}"`);
    // legend documents the ladder with three tier chips
    const legendChips = await page.locator('p .legend-chip').count();
    const legendText = (await page.locator('p.cell-sub.mt-sm').last().innerText()).replace(/\s+/g, ' ');
    if (legendChips === 3 && legendText.includes('Latency tint') && legendText.includes('Unmeasured models stay gray'))
      ok('legend documents the ladder (3 tier chips, honest-gap note)');
    else fail(`legend wrong: chips=${legendChips} text="${legendText.slice(0, 120)}"`);


    // free-only toggle narrows the matrix (NIM carries most rows free, so
    // compare against rows minus non-free leftovers)
    const beforeFree = domRows;
    await page.click('.pm-controls >> text=free only');
    await page.waitForTimeout(400);
    const afterFree = await page.locator('.pm-table tbody tr').count();
    const expectFreeRows = mx.filter(r => Object.values(r.cells).some(c => c.free)).length;
    if (afterFree === expectFreeRows && afterFree < beforeFree)
      ok(`free toggle narrows to ${afterFree} rows with a free cell`);
    else fail(`free toggle: expected ${expectFreeRows} rows, got ${afterFree}`);
    await page.click('.pm-controls >> text=free only'); // off again
    await page.waitForTimeout(300);

    // search narrows pivot rows by name/id
    await page.fill('input.input', 'gpt-oss');
    await page.waitForTimeout(400);
    const gptOss = await page.locator('.pm-table tbody tr').count();
    const expectGO = mx.filter(r => r.search.includes('gpt-oss')).length;
    if (gptOss === expectGO && gptOss > 0 && gptOss < expectRows)
      ok(`pivot search "gpt-oss" narrows to ${gptOss} rows`);
    else fail(`pivot search: expected ${expectGO}, got ${gptOss}`);
    await page.fill('input.input', '');
    await page.waitForTimeout(300);

    // provider picker: chips clustered Providers / Labs (stats-22)
    // (innerTexts come back uppercase — the label is CSS text-transformed)
    const chipGroups = (await page.locator('.pm-chip-group').allInnerTexts()).map(s => s.trim().toLowerCase());
    if (chipGroups.join('|') === 'providers|labs') ok('picker chips clustered: Providers, then Labs');
    else fail(`picker clusters wrong: "${chipGroups.join('", "')}"`);
    // deselect down to 2 columns, table follows
    await page.click('.pm-chip:has-text("Fireworks AI")');
    await page.click('.pm-chip:has-text("DeepInfra")');
    await page.click('.pm-chip:has-text("Together AI")');
    await page.click('.pm-chip:has-text("Groq")');
    await page.waitForTimeout(400);
    const headCols2 = await page.locator('.pm-table thead th').count();
    if (headCols2 === 1 + (expectCols - 4)) ok(`provider picker trims columns to ${headCols2 - 1}`);
    else fail(`provider picker: expected ${expectCols - 3} columns total, got ${headCols2 - 1} headers`);
    await page.click('.pm-controls >> text=reset');
    await page.waitForTimeout(300);

    // back to tab 1: cards still render
    await page.click('.tabs li >> text=By provider');
    await page.waitForSelector('.prov-card', { timeout: 10000 });
    ok('switching back to By provider keeps the card view intact');
    await page.screenshot({ path: SHOTS + '/providers-compare.png' });

    // ── 5b. Per-provider card pagination (stats-21) ─────────────────
    // Shared size is still "All" here → every card renders its full table.
    const bigCard = page.locator('.prov-card', { has: page.locator('.prov-name', { hasText: biggest.name }) });
    const fullRows = await bigCard.locator('.prov-table tbody tr').count();
    if (fullRows === biggest.models.length)
      ok(`"All" size renders the full ${fullRows}-row table in "${biggest.name}"`);
    else fail(`card All rows: expected ${biggest.models.length}, got ${fullRows}`);

    // 50/page: the oversized card pages, small cards stay quiet
    await page.selectOption('.prov-size select', '50');
    await page.waitForTimeout(300);
    const pagedRows50 = await bigCard.locator('.prov-table tbody tr').count();
    if (pagedRows50 === 50) ok(`card table pages to 50 of ${biggest.models.length} rows`);
    else fail(`card page size: expected 50 rows, got ${pagedRows50}`);
    if (await bigCard.locator('.app-pager').count() === 1)
      ok('oversized card carries the pager (bottom-right, no repeated size select)');
    else fail(`card pager count: expected 1, got ${await bigCard.locator('.app-pager').count()}`);
    // a card that fits on one page stays pager-free — pick the biggest
    // provider still under the page size, with a unique name to match by
    const small = catalog.providers
      .filter(p => p.models.length > 0 && p.models.length < 50 && p.name !== biggest.name)
      .filter(p => catalog.providers.filter(x => x.name.includes(p.name)).length === 1)
      .sort((a, b) => b.models.length - a.models.length)[0];
    const smallCard = page.locator('.prov-card', { has: page.locator('.prov-name', { hasText: small.name }) });
    const smallRows = await smallCard.locator('.prov-table tbody tr').count();
    if (smallRows === small.models.length && await smallCard.locator('.app-pager').count() === 0)
      ok(`card that fits one page ("${small.name}", ${small.models.length} rows) stays pager-free`);
    else fail(`small card wrong: "${small.name}" rows=${smallRows}/${small.models.length} pager=${await smallCard.locator('.app-pager').count()}`);

    // card next arrow flips rows
    const c1First = await bigCard.locator('.prov-table tbody tr .prov-model').first().innerText();
    await bigCard.locator('[aria-label="Next page"]').click();
    await page.waitForTimeout(300);
    const c2First = await bigCard.locator('.prov-table tbody tr .prov-model').first().innerText();
    const cCur = (await bigCard.locator('.pagination-list .pagination-link.is-current').innerText()).trim();
    if (cCur === '2' && c1First !== c2First)
      ok(`card next arrow flips rows ("${c1First}" → "${c2First}")`);
    else fail(`card next: current=${cCur}, "${c1First}" → "${c2First}"`);

    // search wipes card pages — the card restarts at page 1 when refilled
    await page.fill('input.input', 'opus');
    await page.waitForTimeout(400);
    await page.fill('input.input', '');
    await page.waitForTimeout(400);
    const cCurReset = (await bigCard.locator('.pagination-list .pagination-link.is-current').innerText()).trim();
    if (cCurReset === '1') ok('search round-trip resets the card to page 1');
    else fail(`card reset: expected page 1, got "${cCurReset}"`);

    // ── 5c. stats-27: NEW badge — release-date flag with a shared window ──
    // Expected sets derived from the committed JSONs through the SAME lib
    // the app ships; the fresh profile runs the shipped 7-day default.
    // Tab 1 first: back to "All" so every card renders its full table and
    // the count is exact (5b left the shared size at 50).
    await page.selectOption('.prov-size select', '0');
    await page.waitForTimeout(400);
    const createdIdx = createdIndexFromMeta(modelsMeta);
    const expCardNew = catalog.providers.reduce((n, p) =>
      n + p.models.filter(m => isNewModel(createdIdx.get(normKey(m.id)) || null)).length, 0);
    const cardNew = await page.locator('.prov-card .new-chip').count();
    if (cardNew === expCardNew) ok(`provider-card NEW badges match the lib-derived count (${cardNew} listings of fresh models)`);
    else fail(`card NEW badges: expected ${expCardNew}, got ${cardNew}`);

    // hover one card badge — Buefy tooltip carries the release date + source
    const freshPick = catalog.providers
      .flatMap(p => p.models.map(m => ({ p, m, created: createdIdx.get(normKey(m.id)) })))
      .find(x => x.created && isNewModel(x.created));
    if (freshPick) {
      const pickCard = page.locator('.prov-card', { has: page.locator('.prov-name', { hasText: freshPick.p.name }) });
      const pickRow = pickCard.locator('tr', { has: page.locator('.prov-model', { hasText: freshPick.m.name || freshPick.m.id }) });
      await page.mouse.move(0, 400); // park away — stale tooltip ghosts (stats-26 lesson)
      await pickRow.locator('.new-chip').first().hover();
      await page.waitForSelector('.tooltip-content:visible', { timeout: 5000 });
      const tip = (await page.locator('.tooltip-content:visible').first().innerText()).replace(/\s+/g, ' ');
      if (tip.includes(`Released ${freshPick.created}`) && tip.includes('per OpenRouter'))
        ok(`card badge tooltip carries the date + source ("${tip.split('—')[0].trim()}")`);
      else fail(`card badge tooltip wrong: "${tip}"`);
    } else fail('no fresh listing found in the committed catalog — badge check vacuous');

    // Compare rows: r.created stamped by buildMatrix; badge as a sibling of
    // the row-name tooltip. All size (shared) → every non-batch row renders.
    await page.click('.tabs li >> text=Compare');
    await page.waitForSelector('.pm-table', { timeout: 10000 });
    const { rows: newMxRows } = buildMatrix(catalog.providers, DEFAULT_COLUMNS, modelsMeta);
    const expNew7 = sortMatrixRows(newMxRows).filter(r => !isBatchRow(r) && isNewModel(r.created));
    await page.waitForFunction(
      (exp) => document.querySelectorAll('.pm-table tbody tr .new-chip').length === exp,
      expNew7.length, { timeout: 15000 }).catch(() => {});
    const rowNew7 = await page.locator('.pm-table tbody tr .new-chip').count();
    if (rowNew7 === expNew7.length) ok(`Compare NEW badges match at the 7-day window (${rowNew7} rows)`);
    else fail(`Compare NEW badges: expected ${expNew7.length}, got ${rowNew7}`);

    // one unique-named badged row: hover its badge (sibling tooltip)
    const nameCounts = new Map();
    for (const r of newMxRows) nameCounts.set(r.name, (nameCounts.get(r.name) || 0) + 1);
    const uniqNew = expNew7.find(r => r.name && nameCounts.get(r.name) === 1);
    if (uniqNew) {
      const nRow = page.locator('.pm-table tbody tr', { has: page.locator('.prov-model', { hasText: uniqNew.name }) });
      await page.mouse.move(0, 400);
      await nRow.locator('.new-chip').first().hover();
      await page.waitForSelector('.tooltip-content:visible', { timeout: 5000 });
      const tip = (await page.locator('.tooltip-content:visible').first().innerText()).replace(/\s+/g, ' ');
      if (tip.includes(`Released ${uniqNew.created}`) && tip.includes('flagged NEW for 7 days'))
        ok(`row badge tooltip honest for "${uniqNew.name}" (released ${uniqNew.created}, 7-day window)`);
      else fail(`row badge tooltip wrong: "${tip}"`);
    }

    // the shared window selector on the Compare controls: widen → re-flag
    // (expected counts come from the FULL matrix — filtering the 7d subset
    // would trivially return the same rows)
    const nonBatch = sortMatrixRows(newMxRows).filter(r => !isBatchRow(r));
    const expNew30 = nonBatch.filter(r => isNewModel(r.created, Date.now(), 30)).length;
    const NEW_SELECT = '.pm-controls select[aria-label="How recent a release must be to show the NEW badge"]';
    await page.mouse.move(0, 400);
    await page.selectOption(NEW_SELECT, '30');
    await page.waitForFunction(
      (exp) => document.querySelectorAll('.pm-table tbody tr .new-chip').length === exp,
      expNew30, { timeout: 15000 }).catch(() => {});
    const rowNew30 = await page.locator('.pm-table tbody tr .new-chip').count();
    if (rowNew30 === expNew30 && rowNew30 > rowNew7)
      ok(`window selector → 30 days re-flags ${rowNew30} rows (was ${rowNew7}) — same data, wider window`);
    else fail(`window switch: expected ${expNew30} badges at 30d (was ${rowNew7}), got ${rowNew30}`);

    // persistence: pick 14 days, reload — the choice survives per device
    const expNew14 = nonBatch.filter(r => isNewModel(r.created, Date.now(), 14)).length;
    await page.selectOption(NEW_SELECT, '14');
    await page.waitForTimeout(300);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.pm-table', { timeout: 15000 });
    await page.waitForFunction(
      (exp) => document.querySelectorAll('.pm-table tbody tr .new-chip').length === exp,
      expNew14, { timeout: 15000 }).catch(() => {});
    const rowNew14 = await page.locator('.pm-table tbody tr .new-chip').count();
    if (rowNew14 === expNew14 && rowNew14 >= rowNew7)
      ok(`window choice survives a reload (${rowNew14} badges at the persisted 14-day window)`);
    else fail(`persistence: expected ${expNew14} badges after reload, got ${rowNew14}`);
    // leave the shipped default behind for the rest of the run
    await page.selectOption(NEW_SELECT, '7');
    await page.waitForTimeout(300);

    // ── 6. Console cleanliness ──────────────────────────────────────
    const real = consoleErrors.filter(e => !/favicon|Download the Vue Devtools/i.test(e));
    if (!real.length) ok('zero console errors on the providers page');
    else fail(`console errors: ${real.slice(0, 3).join(' | ')}`);
  } catch (e) {
    fail(`exception: ${e.message}`);
    await page.screenshot({ path: SHOTS + '/providers-fail.png', fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }

  console.log(`\nproviders e2e: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
};

run();
