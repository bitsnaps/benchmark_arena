// verify_prod_stats79.mjs — live verification of the stats-79 unranked
// reveal toggle on the deployed Pages site. Run after deploy lands:
//   node tests/verify_prod_stats79.mjs   (from the repo root)
// Exit 1 on any failure. Screenshots land in scripts/shots/.
import { chromium } from 'playwright';

const BASE = 'https://bitsnaps.github.io/benchmark_arena/';
const SHOTS = 'scripts/shots';
import { mkdirSync } from 'fs'; mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

const toggle = page.locator('label.switch', { hasText: 'Show new & unranked' });
const section = page.locator('div.unranked-section');

try {
  // ── 1. Default load: census hidden, toggle present with N>0 ──────────
  await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('table tbody tr', { timeout: 45000 });
  await page.waitForTimeout(1500); // router/hydration settle
  check('default: no unranked section in DOM', (await section.count()) === 0);
  check('default: URL clean (no ?unranked)', !page.url().includes('unranked'));
  check('default: reveal toggle visible', await toggle.isVisible());
  const tagText = (await toggle.textContent() || '').trim();
  const n = parseInt((tagText.match(/(\d+)/) || [])[1], 10);
  check('default: toggle count N>0', Number.isFinite(n) && n > 0, `N=${n}`);
  const stored0 = await page.evaluate(() => window.localStorage.getItem('bl_unranked_v1'));
  check('default: localStorage empty', stored0 === null, `got=${stored0}`);
  await toggle.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/stats79-default.png` });

  // ── 2. Click to reveal: section + URL param + persistence ────────────
  await toggle.click();
  await section.waitFor({ state: 'visible', timeout: 10000 });
  check('click: section visible', await section.isVisible());
  const h2 = (await section.locator('h2.section-title').first().textContent() || '').trim();
  check('click: section titled New & unranked', /new\s*&\s*unranked/i.test(h2), h2);
  check('click: URL carries ?unranked=1', page.url().includes('unranked=1'), page.url());
  const stored1 = await page.evaluate(() => window.localStorage.getItem('bl_unranked_v1'));
  const parsed = JSON.parse(stored1 || 'null');
  check('click: localStorage persisted {version:1,on:true}',
        parsed && parsed.version === 1 && parsed.on === true, `got=${stored1}`);
  const nRows = await section.locator('table tbody tr').count();
  check('click: census rows rendered', nRows > 0, `rows=${nRows}`);
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/stats79-revealed.png` });

  // ── 3. Deep link #/?unranked=1 wins over empty storage ───────────────
  // Hash router: the app writes the param INSIDE the hash (that is what
  // toggling produces and what a user copy-pastes); outer ?unranked=1 is
  // ignored, same as ?tier/?free/?price.
  await page.evaluate(() => window.localStorage.clear());
  await page.goto(BASE + '#/?unranked=1', { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('table tbody tr', { timeout: 45000 });
  await page.waitForTimeout(1500);
  check('deep link: section visible on load', await section.isVisible());

  // ── 4. Toggle off via deep-linked load: param dropped, storage cleared ─
  await toggle.click();
  await section.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
  const gone = (await section.count()) === 0 || !(await section.isVisible());
  check('toggle off: section hidden again', gone);
  check('toggle off: URL param dropped', !page.url().includes('unranked'), page.url());
  const stored2 = await page.evaluate(() => window.localStorage.getItem('bl_unranked_v1'));
  check('toggle off: localStorage cleared', stored2 === null, `got=${stored2}`);
} finally {
  check('console clean across all states', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
}

const failed = results.filter(r => !r.ok);
console.log(`\nverify_prod_stats79: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
