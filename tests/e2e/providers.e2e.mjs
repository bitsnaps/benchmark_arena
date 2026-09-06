// Providers page e2e: nav link, catalog render, search narrowing, price cells.
// Runs under tests/run-e2e.mjs (vite preview on 4173, base /benchmark_arena/).
// Expectations are derived from the committed public/providers.json snapshot.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMatrix, sortMatrixRows, DEFAULT_COLUMNS } from '../../src/lib/pivot.js';

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
    const mx = sortMatrixRows(mxRows);
    const expectRows = mx.length;
    const expectNimFree = mx.filter(r => r.cells['nvidia-nim']?.free).length;
    const expectCols = DEFAULT_COLUMNS.length;

    const headCols = await page.locator('.pm-table thead th').count();
    if (headCols === expectCols + 1) ok(`pivot header: ${expectCols} provider columns + Model`);
    else fail(`pivot header columns: expected ${expectCols + 1}, got ${headCols}`);

    const domRows = await page.locator('.pm-table tbody tr').count();
    if (domRows === expectRows) ok(`pivot renders all ${domRows} canonical model rows`);
    else fail(`pivot rows: expected ${expectRows}, got ${domRows}`);

    const coverage = await page.locator('.pm-coverage').innerText();
    if (coverage.includes(`${expectRows} canonical models`) && coverage.includes('duplicate ids collapsed'))
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
