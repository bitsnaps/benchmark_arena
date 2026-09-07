// Availability e2e (stats-18): the "available at" cross-seller layer.
// Expectations derive from the committed snapshot (models_meta.available_at),
// so a data refresh cannot silently invalidate the spec:
//   1. leaderboard free chips = visible rows with a free listing
//   2. Free toggle filters exactly those rows (toolbar click + ?free=1)
//   3. max-price slider (?price=) keeps blended price ≤ cap, free as $0
//   4. seller filter (?seller=) keeps rows the seller's catalog lists
//   5. model card renders the full per-seller "Available at" panel with
//      free chips + the rate-limit caveat (free ≠ unlimited)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = path.join(REPO, 'tests', 'e2e', 'shots');
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173/benchmark_arena/';

const data = JSON.parse(fs.readFileSync(path.join(REPO, 'public/benchmark_results.json'), 'utf8'));
const META = data.models_meta || {};
const isOld = r => !!(META[r.name] && (META[r.name].superseded_by || META[r.name].stale));

// dedupe closed-first like the store's pivotAll
const seen = new Set();
const rows = [];
for (const r of [...(data.unified_closed || []), ...(data.unified_open || [])]) {
  if (seen.has(r.name)) continue;
  seen.add(r.name);
  rows.push(r);
}
const visible = rows.filter(r => !isOld(r));

// mirror the store's filter semantics
const avail = m => m?.available_at ?? [];
const hasFree = m => avail(m).some(a => a.free);
const blend = m => {
  // stats-19: AA list price wins when present (same rule as the store)
  const aa = m?.pricing_aa_usd_per_1m;
  if (aa && typeof aa.input === 'number') {
    const out = typeof aa.output === 'number' ? aa.output : null;
    return out === null ? aa.input : (3 * aa.input + out) / 4;
  }
  const pr = m?.pricing_usd_per_1m;
  if (!pr || typeof pr.input !== 'number') return null;
  const out = typeof pr.output === 'number' ? pr.output : null;
  return out === null ? pr.input : (3 * pr.input + out) / 4;
};
const filterPrice = m => (hasFree(m) ? 0 : blend(m));

const freeRows = visible.filter(r => hasFree(META[r.name]));
const CAP = 0.5;
const capRows = visible.filter(r => { const p = filterPrice(META[r.name]); return p !== null && p <= CAP; });
const ZEN = 'opencode-zen';
const zenRows = visible.filter(r => avail(META[r.name]).some(a => a.p === ZEN));
const bothRows = visible.filter(r => hasFree(META[r.name]) && filterPrice(META[r.name]) !== null && filterPrice(META[r.name]) <= CAP);

// anchor: a widely hosted model with free listings
const ANCHOR = visible.find(r => r.name === 'deepseek v4 flash') || freeRows[0];
const ANCHOR_AVAIL = META[ANCHOR.name].available_at || [];
const ANCHOR_ZEN = ANCHOR_AVAIL.find(a => a.p === ZEN);

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }
const ok = (msg) => console.log('  ok:', msg);
// hash-only navigations re-render the SPA without a reload, so poll briefly
// for the expected final count instead of sampling the transition state
const expectCount = async (page, selector, expected, label) => {
  let n = -1;
  for (let i = 0; i < 40; i++) {
    n = await page.locator(selector).count();
    if (n === expected) break;
    await page.waitForTimeout(100);
  }
  if (n === expected) ok(`${label}: ${n}`);
  else fail(`${label} = ${n}, expected ${expected}`);
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  try {
    // ── 1. default leaderboard: free + sellers chips match the snapshot ──
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('.b-table .table tbody tr', { timeout: 15000 });
    await expectCount(page, '.b-table .table tbody tr', visible.length, 'default rows');
    await expectCount(page, '.b-table .free-chip', freeRows.length, 'free chips');
    const availChipRows = visible.filter(r => {
      const n = avail(META[r.name]).length;
      if (!n) return false;
      return n >= 2 || avail(META[r.name])[0].p !== 'openrouter';
    });
    await expectCount(page, '.b-table .avail-chip', availChipRows.length, 'sellers chips');

    // anchor row: free chip tooltip names the sellers + the caveat
    const anchorRow = page.locator('.b-table tbody tr', { has: page.locator('.model-link', { hasText: ANCHOR.name }) }).first();
    const chipTitle = await anchorRow.locator('.free-chip').first().getAttribute('title');
    if (chipTitle && chipTitle.includes('rate limits apply') && chipTitle.includes(ANCHOR_ZEN ? 'OpenCode Zen' : '·')) {
      ok('anchor free chip tooltip carries the caveat + sellers');
    } else fail(`anchor free chip title = "${chipTitle}"`);

    // ── 2. Free toggle click filters exactly the free rows ──
    await page.locator('label.switch', { hasText: 'Free' }).first().click();
    await page.waitForTimeout(150);
    await expectCount(page, '.b-table .table tbody tr', freeRows.length, 'rows after Free toggle');
    const url1 = page.url();
    if (url1.includes('free=1')) ok('Free toggle syncs ?free=1 into the URL');
    else fail('Free toggle did not sync ?free=1 — url: ' + url1);
    // toggle back off
    await page.locator('label.switch', { hasText: 'Free' }).first().click();
    await page.waitForTimeout(150);
    await expectCount(page, '.b-table .table tbody tr', visible.length, 'rows after Free toggle off');

    // ── 3. ?free=1 deep link pre-filters (hash router: params live after #/) ──
    await page.goto(BASE + '#/?free=1', { waitUntil: 'load' });
    await page.waitForSelector('.b-table .table tbody tr', { timeout: 15000 });
    await expectCount(page, '.b-table .table tbody tr', freeRows.length, 'rows with ?free=1');

    // ── 4. ?price= cap: blended price ≤ cap, free counts as $0 ──
    await page.goto(`${BASE}#/?price=${CAP}`, { waitUntil: 'load' });
    await page.waitForSelector('.b-table .table tbody tr', { timeout: 15000 });
    await expectCount(page, '.b-table .table tbody tr', capRows.length, `rows with ?price=${CAP}`);
    // b-tag renders Bulma's .tag class — price cap tag shows "≤ $0.50"
    const tagText = (await page.locator('.tag', { hasText: '≤' }).first().innerText()).trim();
    if (tagText.includes('$')) ok(`price tag shows the cap: "${tagText}"`);
    else fail(`price tag = "${tagText}", expected a $ cap`);

    // ── 5. ?seller= filter: only rows the seller's catalog lists ──
    await page.goto(`${BASE}#/?seller=${ZEN}`, { waitUntil: 'load' });
    await page.waitForSelector('.b-table .table tbody tr', { timeout: 15000 });
    await expectCount(page, '.b-table .table tbody tr', zenRows.length, `rows with ?seller=${ZEN}`);
    // unknown slug is IGNORED (never applied) — full listing stays visible
    await page.goto(`${BASE}#/?seller=no-such-seller`, { waitUntil: 'load' });
    await page.waitForSelector('.b-table .table tbody tr', { timeout: 15000 });
    await expectCount(page, '.b-table .table tbody tr', visible.length, 'rows with unknown ?seller (ignored, full list)');

    // ── 6. filters compose: ?free=1&price= ──
    await page.goto(`${BASE}#/?free=1&price=${CAP}`, { waitUntil: 'load' });
    await page.waitForSelector('.b-table .table tbody tr', { timeout: 15000 });
    await expectCount(page, '.b-table .table tbody tr', bothRows.length, 'rows with ?free=1&price=' + CAP);

    // ── 7. model card: full "Available at" panel ──
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('.b-table .table tbody tr', { timeout: 15000 });
    await page.locator('.model-link', { hasText: ANCHOR.name }).first().click();
    await page.waitForSelector('.model-head', { timeout: 10000 });
    await page.waitForSelector('.avail-row', { timeout: 10000 });
    await expectCount(page, '.avail-row', ANCHOR_AVAIL.length, 'model card seller rows');
    const panelText = await page.locator('section').innerText();
    if (panelText.includes('Available at')) ok('panel heading present');
    else fail('model card has no "Available at" heading');
    // Zen row: free chip + caveat; unpriced sellers show a dash
    const zenRow = page.locator('.avail-row', { has: page.locator('.avail-seller', { hasText: 'OpenCode Zen' }) }).first();
    if (await zenRow.locator('.free-chip').count()) ok('Zen seller row carries the free chip');
    else fail('Zen seller row missing free chip');
    const zenChipTitle = await zenRow.locator('.free-chip').getAttribute('title');
    if (zenChipTitle === 'Free tier — rate limits apply, not unlimited') ok('free chip tooltip = exact caveat');
    else fail(`free chip tooltip = "${zenChipTitle}"`);
    // a priced seller row shows in / out
    const pricedEntry = ANCHOR_AVAIL.find(a => typeof a.in === 'number' && a.p !== 'openrouter');
    if (pricedEntry) {
      const pricedRow = page.locator('.avail-row', { has: page.locator('.avail-seller', { hasText: pricedEntry.n }) }).first();
      const priceText = await pricedRow.locator('.avail-price').innerText();
      if (priceText.includes('/')) ok(`priced seller row shows in/out: "${priceText.trim()}"`);
      else fail(`priced seller row text = "${priceText}", expected "in / out"`);
    }
    // footer caveat
    if (ANCHOR_ZEN && panelText.includes('rate-limited, not unlimited')) ok('panel footer carries the free ≠ unlimited caveat');
    else if (ANCHOR_ZEN) fail('panel footer missing the rate-limit caveat');

    await page.screenshot({ path: path.join(SHOTS, 'avail-panel.png'), fullPage: false });
  } catch (e) {
    fail('exception: ' + e.message);
    await page.screenshot({ path: path.join(SHOTS, 'avail-fail.png'), fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }

  const real = errors.filter(e => !/favicon|Download the Vue Devtools/i.test(e));
  if (real.length) fail('console/page errors: ' + JSON.stringify(real, null, 2));
  else ok('zero console errors');

  console.log(process.exitCode ? 'AVAIL E2E FAILED' : 'AVAIL E2E PASSED');
})();
