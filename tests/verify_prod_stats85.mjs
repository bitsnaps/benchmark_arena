// verify_prod_stats85.mjs — live verification of the stats-85 ECI
// reference-column toggle on the deployed Pages site. Run after deploy:
//   node tests/verify_prod_stats85.mjs   (from the repo root)
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

const eciTh = () => page.locator('.b-table .table thead th', { hasText: /^ECI/ });
const aaTh = () => page.locator('.b-table .table thead th', { hasText: /^AA/ });
const trigger = page.locator('.avg-dropdown .avg-trigger');
const eciRow = page.locator('.avg-dropdown .avg-bench-row', { hasText: 'ECI' });

try {
  // ── 1. Default load: ECI column leads, toggle present and checked ────
  await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('.b-table .table tbody tr', { timeout: 45000 });
  await page.waitForTimeout(1500); // router/hydration settle
  check('default: ECI header present', (await eciTh().count()) === 1);
  const thTexts0 = await page.locator('.b-table .table thead th').allInnerTexts();
  const eciIdx0 = thTexts0.findIndex(t => t.trim() === 'ECI');
  const aaIdx0 = thTexts0.findIndex(t => t.trim() === 'AA');
  check('default: ECI leads the benchmark block (before AA)', eciIdx0 >= 0 && aaIdx0 > eciIdx0, `ECI@${eciIdx0} AA@${aaIdx0}`);
  check('default: URL clean (no ?eci)', !page.url().includes('eci='), page.url());
  const stored0 = await page.evaluate(() => window.localStorage.getItem('bl_eci_col_v1'));
  check('default: localStorage empty', stored0 === null, `got=${stored0}`);

  // ── 2. Panel: ECI toggle row exists, then uncheck hides the column ───
  await trigger.click();
  await eciRow.waitFor({ state: 'visible', timeout: 10000 });
  check('panel: ECI toggle row present', await eciRow.isVisible());
  const note = (await eciRow.textContent() || '');
  check('panel: honest display-only note', /never feeds the score/i.test(note));
  await page.screenshot({ path: `${SHOTS}/stats85-panel.png` });
  await eciRow.locator('label.b-checkbox, label.checkbox').first().click();
  await page.waitForTimeout(800); // router.replace settles
  check('uncheck: ECI header gone', (await eciTh().count()) === 0);
  check('uncheck: URL carries ?eci=0', page.url().includes('eci=0'), page.url());
  const stored1 = await page.evaluate(() => window.localStorage.getItem('bl_eci_col_v1'));
  const parsed = JSON.parse(stored1 || 'null');
  check('uncheck: localStorage persisted {version:1,on:false}',
        parsed && parsed.version === 1 && parsed.on === false, `got=${stored1}`);
  check('uncheck: benchmark columns untouched (AA still present)', (await aaTh().count()) === 1);
  await page.screenshot({ path: `${SHOTS}/stats85-hidden.png` });

  // ── 3. Deep link #/?eci=0 hides on a fresh load; ?eci=1 wins back ────
  // Hash router: the app writes the param INSIDE the hash (that is what
  // toggling produces and what a user copy-pastes).
  await page.goto(BASE + '#/?eci=0', { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('.b-table .table tbody tr', { timeout: 45000 });
  await page.waitForTimeout(1500);
  check('deep link ?eci=0: column hidden on load', (await eciTh().count()) === 0);
  await page.goto(BASE + '#/?eci=1', { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('.b-table .table tbody tr', { timeout: 45000 });
  await page.waitForTimeout(1500);
  const thTexts1 = await page.locator('.b-table .table thead th').allInnerTexts();
  const eciIdx1 = thTexts1.findIndex(t => t.trim() === 'ECI');
  const aaIdx1 = thTexts1.findIndex(t => t.trim() === 'AA');
  check('deep link ?eci=1: column restored and leading', eciIdx1 >= 0 && aaIdx1 > eciIdx1, `ECI@${eciIdx1} AA@${aaIdx1}`);
  const stored2 = await page.evaluate(() => window.localStorage.getItem('bl_eci_col_v1'));
  check('deep link ?eci=1: stored OFF choice cleared', stored2 === null, `got=${stored2}`);
  await page.screenshot({ path: `${SHOTS}/stats85-restored.png` });
} finally {
  check('console clean across all states', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
}

const failed = results.filter(r => !r.ok);
console.log(`\nverify_prod_stats85: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
