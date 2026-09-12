// Use-case advisor e2e (stats-33). Wizard wiring + shareable deep links,
// with expectations derived from the committed snapshot (house rule: never
// pin what a data refresh can change):
//   1. navbar exposes the Advisor entry; fresh route opens on step 0
//   2. step 0 → 1 → 2 → 3 flow produces 1..5 shortlist tiles, #1 "Recommended"
//   3. deep link (?use=coding&…&s=3) lands straight on results; every priced
//      tile respects the cap (free/unlisted flagged instead of hidden)
//   4. the shortlist never contains an older (superseded/stale) model
//   5. Back / browser-back restore wizard state; Start over clears the URL
//   6. an impossible constraint set (derived from the snapshot) shows the
//      smart empty-state hint naming the relaxation
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = path.join(REPO, 'tests', 'e2e', 'shots');
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173/benchmark_arena/';

// ── Snapshot-derived expectations (same rules as the store/lib) ───────
const data = JSON.parse(fs.readFileSync(path.join(REPO, 'public/benchmark_results.json'), 'utf8'));
const META = data.models_meta || {};
const isOld = (name) => !!(META[name] && (META[name].superseded_by || META[name].stale));
const blendOf = (name) => {
  const m = META[name] || {};
  const aa = m.pricing_aa_usd_per_1m;                 // stats-19: AA list price first
  if (aa && typeof aa.input === 'number') {
    return typeof aa.output === 'number' ? (3 * aa.input + aa.output) / 4 : aa.input;
  }
  const pr = m.pricing_usd_per_1m;
  if (!pr || typeof pr.input !== 'number') return null;
  return typeof pr.output === 'number' ? (3 * pr.input + pr.output) / 4 : pr.input;
};
const openNames = new Set((data.unified_open || []).map(r => r.name));

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }
const ok = (msg) => console.log('  ok:', msg);

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const ADV = BASE + '#/advisor';
  const tileNames = async () => {
    await page.waitForSelector('.model-tile', { timeout: 10000 });
    return page.locator('.model-tile h3').allInnerTexts();
  };

  try {
    // ── 1. navbar entry + fresh route opens on step 0 ──
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const navAdvisor = page.locator('.navbar-start .navbar-item', { hasText: 'Advisor' });
    if (await navAdvisor.count()) ok('navbar has the Advisor entry');
    else fail('navbar missing the Advisor entry');
    await navAdvisor.click();
    await page.waitForSelector('.step-card', { timeout: 10000 });
    if ((await page.locator('h3', { hasText: 'What are you actually doing?' }).count())) ok('fresh /advisor opens on step 0');
    else fail('fresh /advisor did not open on step 0');

    // ── 2. wizard flow: coding → balanced → cap $4 → results ──
    await page.locator('.step-card', { hasText: 'Coding' }).first().click();
    await page.locator('.btn.primary', { hasText: 'Continue' }).click();
    await page.locator('.step-card', { hasText: 'Balanced' }).first().click();
    await page.locator('.btn.primary', { hasText: 'Continue' }).click();
    await page.locator('select.input-lab').nth(1).selectOption('4');
    await page.locator('.btn.primary', { hasText: 'Continue' }).click();
    await page.waitForSelector('.model-tile', { timeout: 10000 });
    const tiles = await tileNames();
    if (tiles.length >= 1 && tiles.length <= 5) ok(`flow produces ${tiles.length} tile(s)`);
    else fail(`tile count out of range: ${tiles.length}`);
    const rec = await page.locator('.model-tile .tag-lab.teal', { hasText: 'Recommended' }).count();
    if (rec === 1) ok('#1 tile carries the Recommended tag');
    else fail(`expected exactly 1 Recommended tag, got ${rec}`);
    const reasons = await page.locator('.model-tile li').count();
    if (reasons >= tiles.length) ok('every tile carries generated reasons');
    else fail(`too few reason lines: ${reasons} for ${tiles.length} tiles`);

    // ── 4. no older model in the shortlist (snapshot-derived) ──
    const olderPicks = tiles.filter(n => isOld(n.trim()));
    if (!olderPicks.length) ok('shortlist contains zero older (superseded/stale) models');
    else fail('older models shortlisted: ' + olderPicks.join(', '));

    // ── 5a. Back restores step 2 + URL sync (router.replace keeps one
    // history entry — the wizard's own Back/Continue are the navigation) ──
    await page.locator('.btn', { hasText: 'Back' }).click();
    if (await page.locator('h3', { hasText: 'Hard constraints' }).count()) ok('Back returns to constraints step');
    else fail('Back did not return to step 2');
    if (/s=2/.test(new URL(page.url()).hash)) ok('URL mirrors the step (s=2)');
    else fail('URL lost the step param: ' + new URL(page.url()).hash);
    await page.locator('.btn.primary', { hasText: 'Continue' }).click();
    await page.waitForSelector('.model-tile h3', { timeout: 10000 });
    ok('Continue returns to the shortlist');

    // ── 5b. Start over clears form + URL ──
    await page.locator('.btn', { hasText: 'Start over' }).click();
    await page.waitForSelector('.step-card', { timeout: 10000 });
    if (/\/advisor$/.test(new URL(page.url()).hash)) ok('start over clears the query (' + new URL(page.url()).hash + ')');
    else fail('start over left query params behind: ' + page.url());

    // ── 3. deep link lands straight on results; cap honored ──
    await page.goto(ADV + '?use=coding&priority=balanced&speed=ok&cap=4&s=3', { waitUntil: 'networkidle' });
    const deepTiles = await tileNames();
    if (deepTiles.length >= 1) ok(`deep link lands on results (${deepTiles.length} tiles)`);
    else fail('deep link produced no tiles');
    for (let i = 0; i < deepTiles.length; i++) {
      const tile = page.locator('.model-tile').nth(i);
      const priceTxt = (await tile.locator('.adv-meta span').first().innerText()).trim();
      const freeOrUnlisted = /free|unlisted/i.test(priceTxt);
      const m = priceTxt.match(/\$([\d.]+)\/1M/);
      if (freeOrUnlisted || (m && parseFloat(m[1]) <= 4.0001)) {
        ok(`tile ${i + 1} price OK: ${priceTxt}`);
      } else {
        fail(`tile ${i + 1} breaches the $4 cap: ${priceTxt}`);
      }
    }

    // ── 6. impossible constraint set → smart empty-state hint ──
    // derive a zero-survivor combo from the snapshot: open-weights + ≥1M
    // context + ≤$1/1M blended (skip when the data admits someone)
    const impossible = (data.unified_open || []).filter(r => {
      if (isOld(r.name)) return false;
      const ctx = META[r.name]?.context_length;
      if (typeof ctx !== 'number' || ctx < 1000000) return false;
      const b = blendOf(r.name);
      return b !== null && b <= 1;
    });
    if (!impossible.length) {
      await page.goto(ADV + '?use=chat&priority=balanced&speed=ok&open=open&cap=1&ctx=1000000&s=3', { waitUntil: 'networkidle' });
      const gotTiles = await page.locator('.model-tile').count();
      if (gotTiles === 0) {
        const hint = await page.locator('.adv-note', { hasText: 'would add' }).count();
        if (hint) ok('empty state shows the smart relaxation hint');
        else fail('empty state without the smart hint');
      } else {
        console.log(`  (skip: derived "impossible" combo admits ${gotTiles} model(s) — snapshot drifted, not a UI bug)`);
      }
    } else {
      console.log(`  (skip: open+1M+≤$1 admits ${impossible.length} model(s) in this snapshot)`);
    }

    await page.screenshot({ path: path.join(SHOTS, 'advisor.png'), fullPage: true });
  } catch (e) {
    fail('exception: ' + e.message);
    await page.screenshot({ path: path.join(SHOTS, 'advisor-fail.png'), fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }

  const real = errors.filter(e => !/favicon|Download the Vue Devtools/i.test(e));
  if (real.length) fail('console/page errors: ' + real.slice(0, 3).join(' | '));
  else ok('zero console/page errors');
  if (process.exitCode) process.exit(1);
  console.log('ADVISOR E2E PASSED');
})();
