// Providers page e2e: nav link, catalog render, search narrowing, price cells.
// Runs under tests/run-e2e.mjs (vite preview on 4173, base /benchmark_arena/).
// Expectations are derived from the committed public/providers.json snapshot.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMatrix, sortMatrixRows, isBatchRow, DEFAULT_COLUMNS } from '../../src/lib/pivot.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = path.join(REPO, 'tests', 'e2e', 'shots');
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173/benchmark_arena/';

const catalog = JSON.parse(fs.readFileSync(path.join(REPO, 'public/providers.json'), 'utf8'));
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

    for (const kind of catalog.kinds) {
      const title = page.locator('.prov-kind-title', { hasText: KIND_LABEL[kind] });
      if (await title.count() === 1) ok(`kind section "${KIND_LABEL[kind]}" present`);
      else fail(`kind section "${KIND_LABEL[kind]}" missing`);
    }

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
    const freeChip = zenCard.locator('.free-chip').first();
    const tip = await freeChip.getAttribute('title');
    if (tip && /rate limit/i.test(tip)) ok(`free chip tooltip carries the rate-limit caveat`);
    else fail(`free chip tooltip wrong: ${tip}`);

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

    // provider picker: deselect down to 2 columns, table follows
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
