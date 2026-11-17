// verify_prod_stats87.mjs — live verification of the stats-87
// "OpenRouter-only models" census on the deployed Pages site. Run after
// deploy: node tests/verify_prod_stats87.mjs (from the repo root).
// Exit 1 on any failure. Screenshots land in scripts/shots/.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const BASE = 'https://bitsnaps.github.io/benchmark_arena/';
const SHOTS = 'scripts/shots';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

// live census size — the expectations derive from the DEPLOYED doc, not the
// local snapshot, so this script stays valid across daily refreshes
const doc = await (await fetch(BASE + 'benchmark_results.json')).json();
const CARDS = doc.card_models || [];
const slugify = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const reveal = page.locator('label.switch:has-text("Show OpenRouter-only")');

try {
  // ── 1. Default load: census hidden, toggle present with the live count ──
  await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('.b-table .table tbody tr', { timeout: 45000 });
  await page.waitForTimeout(1500); // router/hydration settle
  check('default: census hidden', (await page.locator('.oronly-section').count()) === 0);
  check('default: reveal toggle present', (await reveal.count()) === 1);
  const tag = (await reveal.locator('.tag').innerText()).trim();
  check('default: count tag matches the deployed census',
        tag === String(CARDS.length), `tag=${tag} census=${CARDS.length}`);
  check('default: URL clean (no ?card)', !page.url().includes('card='), page.url());

  // ── 2. Reveal: section renders display-only rows ──
  await reveal.click();
  await page.waitForTimeout(1000);
  const section = page.locator('.oronly-section');
  check('reveal: section appears', (await section.count()) === 1);
  check('reveal: ?card=1 synced into the URL', page.url().includes('card=1'), page.url());
  await page.locator('.oronly-section').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/stats87-census.png` });
  await page.evaluate(() => window.localStorage.setItem('arena.pagesize', '0'));
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('.oronly-section .b-table .table tbody tr', { timeout: 45000 });
  await page.waitForTimeout(1200);
  const rows = page.locator('.oronly-section .b-table .table tbody tr');
  const n = await rows.count();
  check('rows: census lists exactly the deployed models', n === CARDS.length, `rows=${n} census=${CARDS.length}`);
  const first = rows.first();
  check('rows: OR-only chip present', (await first.locator('.oronly-chip').count()) === 1);
  const rankText = (await first.locator('.rank').innerText()).trim();
  check('rows: rank is an honest dash', rankText === '—', `got=${rankText}`);
  const hf = await first.locator('a.hf-chip').count();
  check('rows: HF chip present on open-weight rows', hf === 1);
  // ranked universe untouched: the ranked table's first row keeps a real rank
  const topRank = (await page.locator('.b-table .table tbody tr').first().locator('.rank').innerText()).trim();
  check('ranked table: #1 still carries a rank number', topRank === '1', `got=${topRank}`);

  // ── 3. Deep link + Closed-tab absence + model page ──
  await page.goto(BASE + '#/?card=1', { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('.b-table .table tbody tr', { timeout: 45000 });
  await page.waitForTimeout(1200);
  check('deep link: ?card=1 forces the census on', (await page.locator('.oronly-section').count()) === 1);
  await page.goto(BASE + '#/?tier=closed&card=1', { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('.b-table .table tbody tr', { timeout: 45000 });
  await page.waitForTimeout(1200);
  check('closed tab: section absent', (await page.locator('.oronly-section').count()) === 0);

  const card = CARDS[0];
  await page.goto(BASE + '#/model/' + slugify(card.name), { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('.model-head', { timeout: 30000 });
  await page.waitForTimeout(800);
  const headName = (await page.locator('.model-head h1, .model-head .title').first().innerText().catch(() => '')).trim();
  check('model page: card model resolves', headName.includes(card.name), `head=${headName}`);
  const unrated = (await page.locator('.model-head', { hasText: 'UNRATED' }).count()) >= 0
    && (await page.getByText('UNRATED').count()) > 0;
  check('model page: honest UNRATED state shown', unrated);
  await page.screenshot({ path: `${SHOTS}/stats87-model-page.png` });

  check('console: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

const failed = results.filter(r => !r.ok);
console.log(`\nverify_prod_stats87: ${results.length - failed.length}/${results.length} passed${failed.length ? ` — FAILED: ${failed.map(f => f.name).join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
