// verify_prod_stats94.mjs — live verification of the stats-94 runtime HF
// lane on the deployed Pages site (REAL Hugging Face API — no mocks):
//   · the Side-by-side picker offers "Add Hugging Face repo" for a
//     repo-shaped query
//   · adding a real repo lands a census column: HF-only chip, honest dash
//     Global Score, URL sync, localStorage lane entry (bl_runtime_hf_v1)
//   · the column survives a reload (slug index includes runtime rows)
//   · the model page discloses the runtime provenance (repo id, params,
//     added date) and offers Remove
//   · the home board carries the runtime row inline (census chip) while
//     ranked #1 keeps its rank number — no leak into the ranking
//   · a dead repo surfaces an inline error; Remove clears the lane and the
//     board returns to the baked census baseline
//   · Methodology carries the HF-only census passage
// Run after deploy: node tests/verify_prod_stats94.mjs (repo root).
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
await page.addInitScript(() => window.localStorage.setItem('arena.pagesize', '0'));
const errors = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

const doc = await (await fetch(BASE + 'benchmark_results.json')).json();
const CARDS = doc.card_models || [];
const REPO_KEY = 'bl_runtime_hf_v1';
// a real, public, non-quantized HF repo whose basename is NOT on the board
const ADD_REPO = 'HuggingFaceTB/SmolLM3-3B';
const ADD_NAME = 'SmolLM3-3B';
const ADD_SLUG = 'smollm3-3b';
const DEAD_REPO = 'no-such-org-zz94/no-such-repo-94';

try {
  // ── A. baseline: home board ranked top + census count (pre-add) ──
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.b-table .table tbody tr');
  await page.waitForTimeout(500);
  const topRank = (await page.locator('.b-table .table tbody tr').first().locator('.rank').innerText()).trim();
  check('baseline: ranked #1 keeps its rank number', topRank === '1', `top rank="${topRank}"`);
  await page.evaluate((k) => window.localStorage.removeItem(k), REPO_KEY);

  // ── B. the picker offers the runtime add ──
  await page.goto(BASE + '#/compare', { waitUntil: 'networkidle' });
  await page.waitForSelector('.panel-lab .autocomplete input.input', { timeout: 20000 });
  const picker = page.locator('.panel-lab .autocomplete input.input').first();
  await picker.click();
  await picker.fill(ADD_REPO);
  await page.waitForTimeout(400);
  const opt = page.locator('.panel-lab .autocomplete .dropdown-item:has-text("Add Hugging Face repo")');
  check('picker offers "Add Hugging Face repo" for a repo-shaped query',
    (await opt.count()) > 0, `query="${ADD_REPO}"`);
  await page.screenshot({ path: `${SHOTS}/stats94-prod-option.png` });

  // ── C. the add lands a census column (real HF fetch) ──
  await opt.first().click();
  await page.waitForSelector(`.cmp-headcell:has-text("${ADD_NAME}")`, { timeout: 20000 });
  const head = page.locator(`.cmp-headcell:has-text("${ADD_NAME}")`);
  check('runtime column lands in the compare grid', (await head.count()) === 1);
  check('column carries the HF-only census chip',
    (await head.locator('.tag-lab:has-text("HF-only")').count()) > 0);
  const scoreCell = (await head.locator('.num').first().innerText()).trim();
  check('Global Score is an honest dash (no rating by contract)', scoreCell === '—', `cell="${scoreCell}"`);
  check('selection syncs into the shareable URL', page.url().includes(`models=${ADD_SLUG}`), page.url());
  const stored = JSON.parse(await page.evaluate(k => localStorage.getItem(k), REPO_KEY) || 'null');
  check('entry persisted under bl_runtime_hf_v1 (version 1)',
    stored?.version === 1 && stored?.repos?.[0]?.hf_id === ADD_REPO, JSON.stringify(stored)?.slice(0, 140));
  await page.screenshot({ path: `${SHOTS}/stats94-prod-compare.png` });

  // ── D. persistence: reload keeps the column ──
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.cmp-headcell', { timeout: 20000 });
  check('runtime column survives a reload (localStorage lane)',
    (await page.locator(`.cmp-headcell:has-text("${ADD_NAME}")`).count()) === 1);

  // ── E. model page: provenance + Remove ──
  await page.goto(BASE + `#/model/${ADD_SLUG}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.model-head', { timeout: 20000 });
  const notice = page.locator('.notice:has-text("Runtime addition")');
  check('runtime provenance notice renders on the model page', (await notice.count()) === 1);
  const noticeText = (await notice.innerText()).replace(/\s+/g, ' ');
  check('notice discloses the HF repo id', noticeText.includes(ADD_REPO), noticeText.slice(0, 120));
  check('notice surfaces the safetensors param count', /\d+(\.\d+)?B params/.test(noticeText), noticeText.slice(0, 160));
  check('Remove affordance present', (await notice.locator('button:has-text("Remove")').count()) === 1);
  await page.screenshot({ path: `${SHOTS}/stats94-prod-model-page.png` });

  // ── F. home board: inline census row, ranking untouched ──
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.b-table .table tbody tr');
  await page.waitForTimeout(500);
  const chipRows = await page.locator('.b-table .table tbody tr:has(.oronly-chip)').count();
  check(`home board carries ${CARDS.length} baked + 1 runtime census rows`, chipRows === CARDS.length + 1,
    `got ${chipRows}`);
  const topRank2 = (await page.locator('.b-table .table tbody tr').first().locator('.rank').innerText()).trim();
  check('ranked #1 still keeps its rank number (no leak)', topRank2 === '1', `top rank="${topRank2}"`);
  const rtRow = page.locator('.b-table .table tbody tr:has-text("' + ADD_NAME + '")').first();
  const rtRank = (await rtRow.locator('.rank').innerText()).trim();
  check('runtime row shows no rank (—)', rtRank === '—', `rank="${rtRank}"`);
  const rtScore = (await rtRow.locator('td:nth-child(3)').innerText()).trim();
  check('runtime row shows no computed Score', rtScore.includes('—'), `score="${rtScore}"`);

  // ── G. error path: dead repo (real 404) ──
  await page.goto(BASE + '#/compare', { waitUntil: 'networkidle' });
  await page.waitForSelector('.panel-lab .autocomplete input.input', { timeout: 20000 });
  const picker2 = page.locator('.panel-lab .autocomplete input.input').first();
  await picker2.click();
  await picker2.fill(DEAD_REPO);
  await page.waitForTimeout(400);
  await page.locator('.panel-lab .autocomplete .dropdown-item:has-text("Add Hugging Face repo")').first().click();
  const errTag = page.locator('.tag-lab.rose');
  let errText = '';
  for (let i = 0; i < 30 && !errText; i++) {
    if (await errTag.count()) errText = (await errTag.first().innerText()).trim();
    else await page.waitForTimeout(200);
  }
  check('dead repo (real 404) surfaces an inline error', errText.includes('not a public Hugging Face repo'), errText.slice(0, 120));

  // ── H. removal: model page Remove → baseline restored ──
  await page.goto(BASE + `#/model/${ADD_SLUG}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.notice:has-text("Runtime addition")', { timeout: 20000 });
  await page.locator('.notice:has-text("Runtime addition") button:has-text("Remove")').click();
  await page.waitForTimeout(1000);
  const cleared = await page.evaluate(k => localStorage.getItem(k), REPO_KEY);
  check('removal clears the localStorage lane', cleared === null, `storage="${cleared}"`);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.b-table .table tbody tr');
  await page.waitForTimeout(500);
  const chipRows2 = await page.locator('.b-table .table tbody tr:has(.oronly-chip)').count();
  check('after Remove the board is back to the baked census baseline', chipRows2 === CARDS.length,
    `got ${chipRows2}, expected ${CARDS.length}`);

  // ── I. methodology discloses the lane ──
  await page.goto(BASE + '#/methodology', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const meth = await page.evaluate(() => document.body.innerText.includes('The HF-only census'));
  check('methodology carries the HF-only census passage', meth);

  // leave the verify browser clean
  await page.evaluate((k) => window.localStorage.removeItem(k), REPO_KEY);
} catch (e) {
  check('verify run completed without an uncaught exception', false, String(e).slice(0, 200));
}

const hard = errors.filter(e => !e.includes('Failed to load resource'));
check('no page errors', hard.length === 0, hard.slice(0, 3).join(' | '));

const passed = results.filter(r => r.ok).length;
console.log(`\nverify_prod_stats94: ${passed}/${results.length} checks passed`);
if (passed !== results.length) process.exitCode = 1;
await browser.close();
