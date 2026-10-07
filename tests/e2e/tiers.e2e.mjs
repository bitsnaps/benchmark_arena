// stats-60 e2e: model grade chips on the leaderboard — default Overall mode,
// the Tiers modal (Off), localStorage persistence, ?tiers= deep links
// (per-axis + unknown-value drop) and URL reflection. Expectations derive
// from the committed snapshot where a specific row matters; otherwise the
// assertions are shape/behavior-based so a data refresh cannot invalidate
// the suite.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = path.join(REPO, 'tests', 'e2e', 'shots');
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173/benchmark_arena/';

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }
const ok = (msg) => console.log('  ok:', msg);

const LETTERS = ['S', 'A', 'B', 'C', 'D', 'Unrated'];

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(60000);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 160)}`));

  // ── 1. default mode (Overall grade): chips on the leaderboard ─────────
  await page.goto(BASE + '#/', { waitUntil: 'load' });
  await page.waitForSelector('table tbody tr', { timeout: 30000 });
  await page.waitForTimeout(2000);
  const chips = page.locator('table tbody tr .grade-chip');
  const chipCount = await chips.count();
  if (chipCount >= 10) ok(`overall mode: ${chipCount} grade chips on page 1`);
  else fail(`expected ≥10 grade chips by default, got ${chipCount}`);

  const texts = await chips.allTextContents();
  const bad = texts.filter((t) => !LETTERS.includes(t.trim()));
  if (bad.length === 0) ok('every chip text is a grade letter or Unrated');
  else fail(`unexpected chip texts: ${bad.slice(0, 5).join(', ')}`);

  // default sort = Score desc → the first row is the top-scored model → S
  const firstRowChip = page.locator('table tbody tr').first().locator('.grade-chip').first();
  const firstText = (await firstRowChip.textContent() || '').trim();
  if (firstText === 'S') ok('top-ranked row carries grade S');
  else fail(`top-ranked row chip is '${firstText}', expected 'S'`);

  // the trigger button reflects the default mode
  const trigger = page.locator('.tiers-trigger');
  const triggerText = await trigger.textContent();
  if (/Tiers\s*·\s*Overall grade/.test(triggerText || '')) ok('toolbar trigger shows Overall grade');
  else fail(`trigger text unexpected: ${triggerText}`);

  // ── 2. the modal: switch to Off → chips disappear + URL reflects ─────
  await trigger.click();
  const modal = page.locator('.tiers-modal');
  await modal.waitFor({ state: 'visible', timeout: 10000 });
  const options = await modal.locator('.tiers-option').count();
  if (options === 3) ok('modal offers exactly the three modes');
  else fail(`expected 3 mode options, got ${options}`);

  await modal.locator('.tiers-option', { hasText: 'Off' }).click();
  await page.waitForTimeout(800);
  const chipsAfterOff = await page.locator('table tbody tr .grade-chip').count();
  if (chipsAfterOff === 0) ok('Off mode removes every grade chip');
  else fail(`expected 0 chips after Off, got ${chipsAfterOff}`);

  const urlOff = page.url();
  if (/tiers=off/.test(urlOff)) ok('?tiers=off reflected into the URL');
  else fail(`URL missing tiers=off: ${urlOff}`);

  // ── 3. persistence: reload keeps Off (localStorage) ───────────────────
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('table tbody tr', { timeout: 30000 });
  await page.waitForTimeout(1500);
  const chipsAfterReload = await page.locator('table tbody tr .grade-chip').count();
  if (chipsAfterReload === 0) ok('reload keeps Off (localStorage persists)');
  else fail(`chips reappeared after reload: ${chipsAfterReload}`);

  // ── 4. ?tiers=axis deep link: Q/V/S chips ─────────────────────────────
  await page.goto(BASE + '#/?tiers=axis', { waitUntil: 'load' });
  await page.waitForSelector('table tbody tr', { timeout: 30000 });
  await page.waitForTimeout(1500);
  const axisQ = await page.locator('table tbody tr .grade-chip:has(.grade-axis)').count();
  if (axisQ >= 10) ok(`axis mode: ${axisQ} axis chips (Q/V/S) on page 1`);
  else fail(`expected ≥10 axis chips, got ${axisQ}`);
  const qChip = await page.locator('table tbody tr').first().locator('.grade-chip').first().textContent();
  if (/^Q/.test((qChip || '').trim())) ok('first axis chip is Quality-labeled');
  else fail(`first axis chip unexpected: ${qChip}`);

  // ── 5. unknown ?tiers= value: dropped from URL, default chips return ──
  // (fresh context so the localStorage mode from earlier steps does not leak)
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page2 = await ctx2.newPage();
  await page2.goto(BASE + '#/?tiers=bogus', { waitUntil: 'load' });
  await page2.waitForSelector('table tbody tr', { timeout: 30000 });
  await page2.waitForTimeout(1500);
  const url2 = page2.url();
  if (!/tiers=bogus/.test(url2)) ok('unknown ?tiers= value dropped from the URL');
  else fail(`bogus param survived: ${url2}`);
  const chips2 = await page2.locator('table tbody tr .grade-chip').count();
  if (chips2 >= 10) ok('default Overall chips after a bogus param');
  else fail(`expected default chips after bogus param, got ${chips2}`);
  await page2.close();
  await ctx2.close();

  await page.screenshot({ path: path.join(SHOTS, 'tiers-axis.png'), fullPage: false }).catch(() => {});
  await browser.close();

  if (errors.length) fail(`console errors: ${errors.slice(0, 3).join(' | ')}`);
  else ok('zero console errors');

  console.log(process.exitCode ? 'tiers.e2e: FAILED' : 'tiers.e2e: PASSED');
})();
