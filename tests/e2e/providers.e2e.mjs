// Providers page e2e: nav link, catalog render, search narrowing, price cells.
// Runs under tests/run-e2e.mjs (vite preview on 4173, base /benchmark_arena/).
// Expectations are derived from the committed public/providers.json snapshot.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

    // ── 5. Console cleanliness ──────────────────────────────────────
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
