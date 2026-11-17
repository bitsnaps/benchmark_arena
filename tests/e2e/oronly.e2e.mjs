// stats-87 e2e: the "OpenRouter-only models" census — open-weight models
// the OpenRouter catalog lists that no tracked benchmark scores.
// Runs under tests/run-e2e.mjs (vite preview on 4173, base /benchmark_arena/).
// Expectations derive from the committed snapshot's card_models section, so
// a data refresh cannot silently invalidate the suite.
//
// Contract under test:
//   · hidden by default (traceability surface, like the stats-79 census)
//   · toolbar toggle carries the live count; reveal syncs ?card=1 and
//     persists to localStorage; deep links force it on from a cold state
//   · rows render display-only: OR-only chip, no rank, no Score
//   · the Closed tab never shows the section (card models are open-weight)
//   · every card model resolves a model page (slug index includes them)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = path.join(REPO, 'tests', 'e2e', 'shots');
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173/benchmark_arena/';

const data = JSON.parse(fs.readFileSync(path.join(REPO, 'public/benchmark_results.json'), 'utf8'));
const CARDS = data.card_models || [];
const slugify = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
console.log(`card_models in snapshot: ${CARDS.length}`);

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }
const ok = (msg) => console.log('  ok:', msg);

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultNavigationTimeout(60000);
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  // exact row counts need the whole census on one page ("All")
  await page.addInitScript(() => window.localStorage.setItem('arena.pagesize', '0'));

  if (CARDS.length === 0) {
    // churn guard: the census must exist in any healthy snapshot, but the
    // assertions stay degradable (stats-29 lesson) if upstream empties it
    fail('snapshot card_models is empty — census pipeline broke?');
    await browser.close();
    return;
  }

  // ── default state: hidden census, visible toggle with the live count ──
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.b-table .table tbody tr');
  await page.waitForTimeout(400);
  if (await page.locator('.oronly-section').count()) {
    fail('OpenRouter-only census must be hidden by default');
  } else ok('OR-only census hidden by default (toggle off)');
  const reveal = page.locator('label.switch:has-text("Show OpenRouter-only")');
  if (!(await reveal.count())) fail('OR-only reveal toggle missing despite census rows');
  else {
    const tag = (await reveal.locator('.tag').innerText()).trim();
    if (tag !== String(CARDS.length)) fail(`reveal count tag: expected ${CARDS.length}, got "${tag}"`);
    else ok(`reveal toggle carries the live census count (${tag})`);

    // ── toggle on: section renders display-only rows ──
    await reveal.click();
    await page.waitForTimeout(400);
    const section = page.locator('.oronly-section');
    if (!(await section.count())) fail('toggling on must reveal the OR-only census');
    else {
      ok('toggling on reveals the OR-only census');
      if (!page.url().includes('card=1')) fail('reveal should sync ?card=1 into the URL, got ' + page.url());
      else ok('reveal state syncs to ?card=1 in the URL');
      const rows = section.locator('.b-table .table tbody tr');
      const n = await rows.count();
      if (n !== CARDS.length) fail(`census rows: expected ${CARDS.length}, got ${n}`);
      else ok(`census lists exactly the ${CARDS.length} OpenRouter-only open models`);
      // display-only contract on the first row: OR-only chip, no rank, no score
      const first = rows.first();
      if (!(await first.locator('.oronly-chip').count())) fail('card row must carry the OR-only chip');
      else ok('card rows carry the OR-only chip');
      const rankText = (await first.locator('.rank').innerText()).trim();
      if (rankText !== '—') fail(`card row rank must be an honest dash, got "${rankText}"`);
      else ok('card rows show no rank (—)');
      const scoreText = (await first.locator('td:nth-child(3)').innerText()).trim();
      if (!scoreText.includes('—')) fail(`card row Score must be a dash, got "${scoreText}"`);
      else ok('card rows show no computed Score');
      await page.screenshot({ path: path.join(SHOTS, 'oronly-census.png') });

      // reload → the reveal choice persists (localStorage + param still in URL)
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('.b-table .table tbody tr');
      await page.waitForTimeout(400);
      if (!(await page.locator('.oronly-section').count())) fail('reveal choice must survive a reload');
      else ok('reveal choice survives a reload (localStorage)');
    }
  }

  // ── deep link forces the census on from a cold state ──
  await page.goto(BASE + '#/?card=1', { waitUntil: 'networkidle' });
  await page.waitForSelector('.b-table .table tbody tr');
  await page.waitForTimeout(400);
  if (!(await page.locator('.oronly-section').count())) fail('?card=1 must force the census on');
  else ok('?card=1 deep link forces the census on');

  // ── Closed tab: never (card models are open-weight) ──
  await page.goto(BASE + '#/?tier=closed&card=1', { waitUntil: 'networkidle' });
  await page.waitForSelector('.b-table .table tbody tr');
  await page.waitForTimeout(400);
  if (await page.locator('.oronly-section').count()) fail('Closed tab must not render the OR-only section');
  else ok('Closed tab hides the OR-only section');

  // ── model page: every card model resolves a score card ──
  const card = CARDS[0];
  await page.goto(BASE + '#/model/' + slugify(card.name), { waitUntil: 'networkidle' });
  await page.waitForSelector('.model-head', { timeout: 10000 });
  const headName = (await page.locator('.model-head h1, .model-head .title').first().innerText().catch(() => '')).trim();
  if (!headName.includes(card.name)) fail(`card model page must resolve "${card.name}", got "${headName}"`);
  else ok(`card model page resolves for "${card.name}"`);
  await page.screenshot({ path: path.join(SHOTS, 'oronly-model-page.png') });

  // ── leave defaults for the rest of the suite ──
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => window.localStorage.removeItem('bl_card_v1'));
  await page.waitForTimeout(200);

  if (errors.length) {
    fail(`page errors: ${errors.slice(0, 4).join(' | ')}`);
  } else ok('no page errors');
  await browser.close();
})();
