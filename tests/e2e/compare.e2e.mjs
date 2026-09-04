// Side-by-side comparison e2e: presets, deep links, cap, mobile scroll.
// Runs under tests/run-e2e.mjs (vite preview on 4173, base /benchmark_arena/).
// Expectations are derived from the committed snapshot, so a data refresh
// cannot silently invalidate the suite.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = path.join(REPO, 'tests', 'e2e', 'shots');
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173/benchmark_arena/';

// Expectations computed from the real snapshot (mirrors stores/data.js logic)
const data = JSON.parse(fs.readFileSync(path.join(REPO, 'public/benchmark_results.json'), 'utf8'));
const CORE = ['Artificial Analysis','BenchLM.ai','Arena.ai Text','SimpleBench.com','ARC-AGI-2','Design Arena','SWE-Marathon','FrontierSWE'];
const avg = r => { const v = CORE.map(b => r[b]).filter(x => x != null); return v.length ? v.reduce((a,b)=>a+b,0)/v.length : -1; };
const slugify = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const closedRows = data.unified_closed || [];
const openRows = data.unified_open || [];
const closedNames = new Set(closedRows.map(r => r.name));
const pivotAll = [];
{ const seen = new Set();
  for (const r of [...closedRows, ...openRows]) { if (seen.has(r.name)) continue; seen.add(r.name); pivotAll.push(r); } }
const META = data.models_meta || {};
const isSup = r => !!(META[r.name] && (META[r.name].superseded_by || META[r.name].stale)); // mirror store: presets use current models only
const sorted = pivotAll.filter(r => !isSup(r)).sort((a, b) => avg(b) - avg(a));
const top3 = sorted.slice(0, 3);
const topOpen3 = sorted.filter(r => !closedNames.has(r.name)).slice(0, 3);
const top5 = sorted.slice(0, 5);
const withMeta = pivotAll.filter(r => (data.models_meta || {})[r.name]).length;
const BENCHES = data.benchmarks || [];
console.log('top3:', top3.map(r => r.name), '| topOpen3:', topOpen3.map(r => r.name));

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }
const ok = (msg) => console.log('  ok:', msg);

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const heads = () => page.locator('.cmp-headcell');

  // ── 1. Empty state + presets ──
  await page.goto(BASE + '#/compare', { waitUntil: 'networkidle' });
  await page.waitForSelector('.panel-lab .chip', { timeout: 10000 });
  const h1 = (await page.locator('h1.section-title').innerText()).trim();
  if (h1 !== 'Side by side') fail('compare h1, got ' + h1);
  else ok('empty state renders with title "Side by side"');
  if (await page.locator('.panel-lab .chip').count() !== 3) fail('expected 3 preset chips');
  else ok('3 preset chips offered');

  // ── 2. Preset "Top 3 overall" loads columns + URL ──
  await page.locator('.panel-lab .chip', { hasText: 'Top 3 overall' }).click();
  await page.waitForSelector('.cmp-headcell', { timeout: 10000 });
  await page.waitForTimeout(500);
  if ((await heads().count()) !== 3) fail('preset should load 3 columns, got ' + (await heads().count()));
  else ok('preset loads 3 model columns');
  const urlSlugs = decodeURIComponent(page.url().split('models=')[1] || '');
  if (urlSlugs !== top3.map(r => slugify(r.name)).join(',')) fail(`URL models= mismatch: ${urlSlugs}`);
  else ok(`URL synced: ?models=${urlSlugs}`);
  const groupTexts = (await page.locator('.cmp-group').allInnerTexts()).map(s => s.trim().toLowerCase());
  if (groupTexts.length !== 4 || !groupTexts.some(t => t.startsWith('specs')) || !groupTexts.some(t => t.startsWith('pricing')))
    fail('expected 4 group headers (Headline/Specs/Pricing/Scores), got ' + JSON.stringify(groupTexts));
  else ok('group headers: ' + groupTexts.join(' | '));

  // ── 3. Winner highlighting + metadata hints ──
  const winners = await page.locator('.winner-cell').count();
  if (winners < 8) fail(`expected >= 8 winner cells with 3 models, got ${winners}`);
  else ok(`winner cells highlight row bests (${winners} teal cells)`);
  const hint = (await page.locator('.cmp-corner .cmp-hint').innerText()).trim();
  if (!hint.startsWith(`${withMeta}/`)) fail(`meta coverage hint should start ${withMeta}/, got "${hint}"`);
  else ok(`meta coverage hint: "${hint}"`);
  const labels = await page.locator('.cmp-label').count();
  if (labels !== 5 + 10 + 4 + BENCHES.length) fail(`spec label count: expected ${5+10+4+BENCHES.length}, got ${labels}`);
  else ok(`matrix rows: ${labels} (headline 5 + specs 10 + pricing 4 + scores ${BENCHES.length})`);
  const chipsCells = await page.locator('.cmp-cell .chips').count();
  if (chipsCells < 1) fail('modalities chips row missing');
  else ok('modalities rendered as icon chips');
  await page.screenshot({ path: SHOTS + '/compare-desktop.png', fullPage: false });

  // ── 4. Autocomplete add / remove ──
  const before = await heads().count();
  await page.fill('.cmp-toolbar input.input', 'grok');
  await page.waitForSelector('.dropdown-content .dropdown-item', { timeout: 10000 });
  await page.locator('.dropdown-content .dropdown-item').first().click();
  await page.waitForTimeout(600);
  if ((await heads().count()) !== before + 1) fail(`autocomplete add failed (${before} → ${(await heads().count())})`);
  else ok(`autocomplete added a Grok model (${before} → ${await heads().count()} columns)`);
  if (!page.url().includes('models=') || decodeURIComponent(page.url().split('models=')[1]).split(',').length !== before + 1)
    fail('URL should carry ' + (before + 1) + ' slugs, got ' + page.url());
  else ok('URL updated after add');
  await page.locator('.cmp-x').first().click();
  await page.waitForTimeout(500);
  if ((await heads().count()) !== before) fail('remove should shrink columns back');
  else ok('x button removes a column');

  // ── 5. Deep link with 2 models + title ──
  const closed1 = [...closedRows].filter(r => !isSup(r)).sort((a, b) => avg(b) - avg(a))[0];
  const open1 = [...openRows].filter(r => !isSup(r)).sort((a, b) => avg(b) - avg(a))[0];
  const duo = [closed1, open1].map(r => slugify(r.name)).join(',');
  await page.goto(BASE + '#/compare?models=' + duo, { waitUntil: 'networkidle' });
  await page.waitForSelector('.cmp-headcell', { timeout: 10000 });
  if ((await heads().count()) !== 2) fail('duo deep link should resolve 2 columns');
  else ok(`deep link resolves ${closed1.name} vs ${open1.name}`);
  const headNames = (await page.locator('.cmp-headcell .model-link').allInnerTexts()).map(s => s.trim());
  if (headNames.join('|') !== [closed1.name, open1.name].join('|')) fail('column order should follow URL: ' + headNames);
  else ok('column order follows URL order');
  const title = await page.title();
  if (!title.includes(closed1.name) || !title.includes(open1.name)) fail('title should name both models: ' + title);
  else ok(`document.title = "${title}"`);
  const firstHref = await page.locator('.cmp-headcell .model-link').first().getAttribute('href');
  if (!firstHref.includes('#/model/')) fail('column name should link to model page, got ' + firstHref);
  else ok('column names link to model score cards');

  // ── 6. Unknown slug cleans up to empty state ──
  await page.goto(BASE + '#/compare?models=does-not-exist', { waitUntil: 'networkidle' });
  await page.waitForSelector('.panel-lab .chip', { timeout: 10000 });
  if (page.url().includes('models=')) fail('unknown-only URL should be cleaned, got ' + page.url());
  else ok('fully-unknown deep link falls back to empty state (URL cleaned)');

  // ── 7. 5-model cap: autocomplete disabled ──
  await page.goto(BASE + '#/compare?models=' + top5.map(r => slugify(r.name)).join(','), { waitUntil: 'networkidle' });
  await page.waitForSelector('.cmp-headcell', { timeout: 10000 });
  if ((await heads().count()) !== 5) fail('cap deep link should show 5 columns, got ' + (await heads().count()));
  else ok('5-model deep link loads at cap');
  if ((await page.locator('.cmp-toolbar input.input[disabled]').count()) !== 1) fail('autocomplete should be disabled at cap');
  else ok('add-model disabled at 5/5 (cap enforced)');
  const capTag = (await page.locator('.cmp-toolbar .tag').first().innerText()).trim();
  if (capTag !== '5/5') fail('cap tag, got ' + capTag);
  else ok('counter tag shows 5/5');
  await page.screenshot({ path: SHOTS + '/compare-cap5.png' });

  // ── 8. Navbar pill entry seeds URL from home checkboxes ──
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.b-table .table tbody tr');
  await page.locator('label.switch:has-text("Compare")').click();
  await page.locator('.b-table .table tbody tr .b-checkbox input').nth(0).click({ force: true });
  await page.locator('.b-table .table tbody tr .b-checkbox input').nth(1).click({ force: true });
  await page.waitForTimeout(400);
  await page.click('.compare-pill');
  await page.waitForSelector('.cmp-headcell', { timeout: 10000 });
  await page.waitForTimeout(400);
  const pillSlugs = decodeURIComponent(page.url().split('models=')[1] || '').split(',');
  if (pillSlugs.length !== 2) fail('pill entry should seed 2 slugs, got ' + pillSlugs);
  else ok('navbar pill → /compare seeds URL with checked models (2)');
  // clearing returns to empty state
  await page.click('.cmp-toolbar button:has-text("Clear all")');
  await page.waitForSelector('.panel-lab .chip', { timeout: 10000 });
  ok('Clear all returns to the empty state');

  // ── 9. Home panel "Full comparison" CTA ──
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.b-table .table tbody tr');
  await page.locator('label.switch:has-text("Compare")').click();
  await page.locator('.b-table .table tbody tr .b-checkbox input').nth(0).click({ force: true });
  await page.locator('.b-table .table tbody tr .b-checkbox input').nth(1).click({ force: true });
  await page.waitForTimeout(400);
  await page.locator('button:has-text("Full comparison")').click();
  await page.waitForSelector('.cmp-headcell', { timeout: 10000 });
  if (!page.url().includes('/compare')) fail('panel CTA should route to /compare, got ' + page.url());
  else ok('home panel "Full comparison" CTA → /compare');

  // ── 10. Mobile 390px: grid scrolls horizontally ──
  const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mob.on('pageerror', e => errors.push('mobile pageerror: ' + e.message));
  await mob.goto(BASE + '#/compare?models=' + top3.map(r => slugify(r.name)).join(','), { waitUntil: 'networkidle' });
  await mob.waitForSelector('.cmp-headcell', { timeout: 10000 });
  const scroll = await mob.locator('.cmp-scroll').evaluate(el => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  if (scroll.sw <= scroll.cw) fail(`mobile grid should overflow-x (sw=${scroll.sw}, cw=${scroll.cw})`);
  else ok(`mobile 390px: comparison scrolls horizontally (${scroll.sw}px > ${scroll.cw}px)`);
  const labelVisible = await mob.locator('.cmp-label').first().isVisible();
  if (!labelVisible) fail('sticky label column should stay visible on mobile');
  else ok('sticky metric labels visible on mobile');
  await mob.screenshot({ path: SHOTS + '/compare-mobile.png' });

  if (errors.length) fail('page errors: ' + errors.join(' | '));
  else ok('zero console/page errors');

  await browser.close();
  console.log(process.exitCode ? 'COMPARE SMOKE FAILED' : 'COMPARE SMOKE PASSED');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
