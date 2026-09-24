// Methodology e2e (stats-45): the "how this works" page at the END of the
// navbar. Static content — the spec guards placement, routing and content,
// so the page can't silently detach from the nav or lose a section:
//   1. Methodology is the LAST item in the navbar menu
//   2. clicking it lands on #/methodology and renders the page head
//   3. all key sections exist (pipeline steps, Score formula, coverage,
//      price blend, value lens, providers join, honesty rules, freshness)
//   4. direct deep link #/methodology works (hash router)
//   5. in-page jump chips scroll to their section heading
//   6. zero console/page errors
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHOTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'shots');
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173/benchmark_arena/';

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }
const ok = (msg) => console.log('  ok:', msg);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // CI-box hardening: preview server + chromium contend for CPU (stats-36)
  page.setDefaultNavigationTimeout(60000);
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  try {
    // ── 1. Methodology is the LAST navbar-menu item ────────────────────
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('.navbar-start a', { timeout: 10000 });
    const navTexts = (await page.locator('.navbar-start a').allInnerTexts()).map(s => s.trim());
    if (navTexts[navTexts.length - 1] === 'Methodology' && navTexts.length >= 2)
      ok(`navbar menu ends with Methodology [${navTexts.join(', ')}]`);
    else fail(`Methodology should be the LAST navbar item, got [${navTexts.join(', ')}]`);

    // ── 2. Click through: route + page head ────────────────────────────
    await page.click('.navbar-start >> text=Methodology');
    await page.waitForURL('**/#/methodology', { timeout: 10000 });
    await page.waitForSelector('h1.section-title', { timeout: 10000 });
    const h1 = (await page.locator('h1.section-title').innerText()).trim();
    if (h1 === 'Methodology') ok('nav click lands on #/methodology with the Methodology page head');
    else fail(`h1 = "${h1}", expected "Methodology"`);
    // active state on the nav item
    const activeCount = await page.locator('.navbar-start a.is-active', { hasText: 'Methodology' }).count();
    if (activeCount === 1) ok('navbar marks Methodology as active');
    else fail('Methodology nav item lacks the is-active state');

    // ── 3. Key sections all present ────────────────────────────────────
    const body = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    const needs = [
      'Methodology',
      'From public leaderboards to one snapshot',
      'Collect', 'Merge', 'Gate', 'Publish',
      'Reading the leaderboard',
      'Our Score — the ranking metric',
      'Harmonize each column',
      'Score = w × mean(harmonized covered) + (1 − w) × 50',
      'Coverage Level (CL)',
      'Core vs context benchmarks',
      'Tiers, ranks & older versions',
      'Reading the money columns',
      'List API price per 1M tokens',
      '(3 × input + output) / 4',
      'Value = Score ÷ blended $/1M',
      'time-to-first-token',
      'Beyond the table',
      'The Providers page',
      'Honesty rules',
      'Dashes over guesses',
      'not an official ranking',
      'Freshness & verification',
      'benchmark_results.json',
      'providers.json',
    ];
    const missing = needs.filter(n => !body.includes(n));
    if (!missing.length) ok(`all ${needs.length} content anchors present`);
    else fail('missing content: ' + JSON.stringify(missing));
    const steps = await page.locator('.mstep').count();
    if (steps === 4) ok('pipeline renders as 4 step panels');
    else fail(`pipeline step panels = ${steps}, expected 4`);

    // ── 4. Direct deep link (hash router) ──────────────────────────────
    await page.goto(BASE + '#/methodology', { waitUntil: 'networkidle' });
    await page.waitForSelector('h1.section-title', { timeout: 10000 });
    const deepH1 = (await page.locator('h1.section-title').innerText()).trim();
    if (deepH1 === 'Methodology') ok('deep link #/methodology renders directly');
    else fail(`deep link h1 = "${deepH1}", expected "Methodology"`);

    // ── 5. Jump chip scrolls to the honesty section ────────────────────
    await page.locator('.chip', { hasText: 'Honesty rules' }).click();
    await page.waitForTimeout(900); // smooth scroll
    const inView = await page.locator('#honesty').evaluate((el) => {
      const r = el.getBoundingClientRect();
      // top must be visible BELOW the fixed navbar (~56px tall)
      return r.top > 40 && r.top < window.innerHeight;
    });
    if (inView) ok('jump chip scrolls the Honesty rules section into view');
    else fail('jump chip did not bring #honesty into view');

    await page.screenshot({ path: path.join(SHOTS, 'methodology.png'), fullPage: false });
  } catch (e) {
    fail('exception: ' + e.message);
    await page.screenshot({ path: path.join(SHOTS, 'methodology-fail.png'), fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }

  const real = errors.filter(e => !/favicon|Download the Vue Devtools/i.test(e));
  if (real.length) fail('console/page errors: ' + real.slice(0, 3).join(' | '));
  else ok('zero console/page errors');
  if (process.exitCode) process.exit(1);
  console.log('METHODOLOGY E2E PASSED');
})();
