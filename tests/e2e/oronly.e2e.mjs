// stats-87/89 e2e: the "OpenRouter-only" card-model census — open-weight
// models the OpenRouter catalog lists that no tracked benchmark scores.
// stats-89: the census no longer renders as a separate section — the rows
// merge INLINE into the ranked table (default ON, toggle hides/shows),
// parked under the ranking by the default score sort.
// Runs under tests/run-e2e.mjs (vite preview on 4173, base /benchmark_arena/).
// Expectations derive from the committed snapshot's card_models section, so
// a data refresh cannot silently invalidate the suite.
//
// Contract under test:
//   · merged rows visible by default in the MAIN table (count tag, clean URL)
//   · each card row renders display-only: OR-only chip, no rank, no Score
//   · the ranked top of the table is untouched (#1 keeps its rank number)
//   · toggle off removes the rows, syncs ?card=0 and persists (localStorage)
//   · deep links win on load: ?card=0 hides, ?card=1 forces on (clears OFF)
//   · the Closed tab never shows card rows (card models are open-weight)
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
// poll briefly for the expected final count (hash navigations re-render
// without a reload — same helper shape as avail.e2e)
const expectCount = async (page, loc, expected, label) => {
  let n = -1;
  for (let i = 0; i < 40; i++) {
    n = await loc.count();
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
  page.setDefaultNavigationTimeout(60000);
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  // exact row counts need the whole table on one page ("All")
  await page.addInitScript(() => window.localStorage.setItem('arena.pagesize', '0'));

  if (CARDS.length === 0) {
    // churn guard: the census must exist in any healthy snapshot, but the
    // assertions stay degradable (stats-29 lesson) if upstream empties it
    fail('snapshot card_models is empty — census pipeline broke?');
    await browser.close();
    return;
  }

  const cardRowsInTable = () => page.locator('.b-table .table tbody tr:has(.oronly-chip)');

  // ── default state: merged inline rows visible, clean URL, live count ──
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.b-table .table tbody tr');
  await page.waitForTimeout(400);
  if (page.url().includes('card=')) fail('default URL must be clean (no ?card), got ' + page.url());
  else ok('default URL stays clean (ON is the shipped default)');
  await expectCount(page, cardRowsInTable(), CARDS.length,
    `main table carries all ${CARDS.length} card rows inline`);

  // display-only contract on the first card row: OR-only chip, no rank, no score
  const firstCard = cardRowsInTable().first();
  const rankText = (await firstCard.locator('.rank').innerText()).trim();
  if (rankText !== '—') fail(`card row rank must be an honest dash, got "${rankText}"`);
  else ok('card rows show no rank (—)');
  const scoreText = (await firstCard.locator('td:nth-child(3)').innerText()).trim();
  if (!scoreText.includes('—')) fail(`card row Score must be a dash, got "${scoreText}"`);
  else ok('card rows show no computed Score');
  // ranked top untouched: the table's first row is still ranked #1
  const topRank = (await page.locator('.b-table .table tbody tr').first().locator('.rank').innerText()).trim();
  if (topRank !== '1') fail(`ranked #1 must keep its rank number, got "${topRank}"`);
  else ok('ranked #1 keeps its rank number above the merged card rows');
  const reveal = page.locator('label.switch:has-text("Show OpenRouter-only")');
  const tag = (await reveal.locator('.tag').innerText()).trim();
  if (tag !== String(CARDS.length)) fail(`reveal count tag: expected ${CARDS.length}, got "${tag}"`);
  else ok(`reveal toggle carries the live census count (${tag})`);
  await page.screenshot({ path: path.join(SHOTS, 'oronly-inline-merge.png') });

  // ── Closed tab: never (card models are open-weight), while toggle is ON ──
  await page.goto(BASE + '#/?tier=closed', { waitUntil: 'networkidle' });
  await page.waitForSelector('.b-table .table tbody tr');
  await page.waitForTimeout(400);
  await expectCount(page, cardRowsInTable(), 0, 'Closed tab shows zero card rows (toggle ON)');

  // back to the open board, still ON
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.b-table .table tbody tr');
  await page.waitForTimeout(400);

  // ── toggle off: rows vanish, ?card=0 syncs, choice persists ──
  await reveal.click();
  await page.waitForTimeout(400);
  await expectCount(page, cardRowsInTable(), 0, 'toggling off removes every card row from the table');
  if (!page.url().includes('card=0')) fail('hiding should sync ?card=0 into the URL, got ' + page.url());
  else ok('hidden state syncs to ?card=0 in the URL');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.b-table .table tbody tr');
  await page.waitForTimeout(400);
  await expectCount(page, cardRowsInTable(), 0, 'hidden choice survives a reload (localStorage)');

  // ── deep links win on load ──
  await page.goto(BASE + '#/?card=1', { waitUntil: 'networkidle' });
  await page.waitForSelector('.b-table .table tbody tr');
  await page.waitForTimeout(400);
  await expectCount(page, cardRowsInTable(), CARDS.length, '?card=1 forces the rows on (clears a stored OFF)');
  // ?card=1 must clear the stored OFF choice: a fresh load without params stays ON
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.b-table .table tbody tr');
  await page.waitForTimeout(400);
  await expectCount(page, cardRowsInTable(), CARDS.length, 'after ?card=1, the stored default is ON again');

  await page.goto(BASE + '#/?card=0', { waitUntil: 'networkidle' });
  await page.waitForSelector('.b-table .table tbody tr');
  await page.waitForTimeout(400);
  await expectCount(page, cardRowsInTable(), 0, '?card=0 deep link forces the rows off');

  // ── model page: every card model resolves a score card ──
  const card = CARDS[0];
  await page.goto(BASE + '#/model/' + slugify(card.name), { waitUntil: 'networkidle' });
  await page.waitForSelector('.model-head', { timeout: 10000 });
  const headName = (await page.locator('.model-head h1, .model-head .title').first().innerText().catch(() => '')).trim();
  if (!headName.includes(card.name)) fail(`card model page must resolve "${card.name}", got "${headName}"`);
  else ok(`card model page resolves for "${card.name}"`);
  await page.screenshot({ path: path.join(SHOTS, 'oronly-model-page.png') });

  // ── stats-91: the creator-reported (vendor) lane ──
  // Count-only row links in the table (never vendor numbers inside the
  // table), and the full provenance panel on the model page behind them.
  {
    const withVendor = CARDS.filter(c => (c.vendor_scores || []).length);
    const totalVendor = withVendor.reduce((a, c) => a + c.vendor_scores.length, 0);
    console.log(`  vendor lane in snapshot: ${totalVendor} scores on ${withVendor.length} card models`);
    // back on the board with the census forced ON (the ?card=0 deep-link
    // test above stored an OFF choice; ?card=1 clears it per contract)
    await page.goto(BASE + '#/?card=1', { waitUntil: 'networkidle' });
    await page.waitForSelector('.b-table .table tbody tr');
    await page.waitForTimeout(400);
    await expectCount(page, page.locator('.b-table .table tbody tr:has(.oronly-chip) .vendor-link'),
      withVendor.length, 'main table shows a count-only creator-scores link on exactly the scored card rows');
    const linkText = (await page.locator('.vendor-link').first().innerText().catch(() => '')).trim();
    if (!/\d+ creator scores/.test(linkText)) fail(`row link must be count-only, got "${linkText}"`);
    else ok('row link carries a count, not vendor numbers');

    // model page WITH scores: LongCat 2.0 (Ibrahim's example when he
    // proposed the lane) — panel, count, disclaimer, qualifier chip, link
    const lc = withVendor.find(c => c.name === 'LongCat 2.0') || withVendor[0];
    await page.goto(BASE + '#/model/' + slugify(lc.name), { waitUntil: 'networkidle' });
    await page.waitForSelector('.model-head', { timeout: 10000 });
    const panel = page.locator('.panel-lab:has(h3:has-text("Creator-reported benchmarks"))');
    if (!(await panel.count())) fail(`creator-reported panel missing on "${lc.name}"`);
    else ok(`creator-reported panel renders on "${lc.name}"`);
    const rowsShown = await panel.locator('.vendor-row').count();
    if (rowsShown !== lc.vendor_scores.length) fail(`panel rows: expected ${lc.vendor_scores.length}, got ${rowsShown}`);
    else ok(`panel lists all ${rowsShown} creator-reported benchmarks`);
    const disc = await panel.locator('.notice').innerText().catch(() => '');
    if (!disc.includes('not measured by us')) fail('disclaimer must state the numbers are not measured by us');
    else ok('disclaimer present (self-reported, not measured by us)');
    if (!(await panel.locator('.vendor-row .tag-lab').count())) fail('qualifier chip missing on vendor rows');
    else ok('qualifier chips render (in-house / cited / reported)');
    if (!(await panel.locator('a:has-text("view the model card")').count())) fail('panel must link the model card');
    else ok('panel links the model card (provenance)');
    if (lc.vendor_scores.some(s => s.source === 'hf-eval')) {
      // structured records carry their report date — shown in the panel
      const dated = await panel.locator('.vendor-row .cell-sub').count();
      if (!dated) fail('hf-eval rows should surface their report date');
      else ok('structured (hf-eval) rows surface their report date');
    }
    await page.screenshot({ path: path.join(SHOTS, 'vendor-panel.png') });

    // model page WITHOUT scores: the panel must be absent (honest gap, no
    // empty section) — pick a census model with no vendor_scores
    const bare = CARDS.find(c => !(c.vendor_scores || []).length);
    if (bare) {
      await page.goto(BASE + '#/model/' + slugify(bare.name), { waitUntil: 'networkidle' });
      await page.waitForSelector('.model-head', { timeout: 10000 });
      if (await page.locator('h3:has-text("Creator-reported benchmarks")').count())
        fail(`"${bare.name}" has no vendor scores — panel must not render`);
      else ok(`"${bare.name}" shows no vendor panel (honest gap)`);
    }
  }

  // ── leave defaults for the rest of the suite (ON, no stored key) ──
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => window.localStorage.removeItem('bl_card_v1'));
  await page.waitForTimeout(200);

  if (errors.length) {
    fail(`page errors: ${errors.slice(0, 4).join(' | ')}`);
  } else ok('no page errors');
  await browser.close();
})();
