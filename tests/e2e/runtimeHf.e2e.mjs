// stats-94 e2e: the runtime HF lane — "add any Hugging Face model".
// Contract under test (picker → census, red lines everywhere):
//   · a repo-shaped picker query offers "Add Hugging Face repo: org/repo"
//   · selecting it fetches the HF identity (MOCKED here via page.route —
//     no network in e2e), drops a census row into the compare grid
//   · the column is census-honest: HF-only chip, dash Global Score, no rank
//   · the entry persists in localStorage (bl_runtime_hf_v1) and survives a
//     reload; the home board carries it inline with the HF-only chip while
//     ranked #1 keeps its rank number (no leak into the ranking)
//   · the model page resolves, discloses the runtime provenance and offers
//     Remove — removal clears the lane and the board returns to baseline
//   · error paths: dead repo (404) surfaces the error inline; a repo whose
//     name is already on the board is refused (no duplicate rows)
// Runs under tests/run-e2e.mjs (vite preview on 4173, base /benchmark_arena/).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = path.join(REPO, 'tests', 'e2e', 'shots');
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173/benchmark_arena/';
const REPO_KEY = 'bl_runtime_hf_v1';

const data = JSON.parse(fs.readFileSync(path.join(REPO, 'public/benchmark_results.json'), 'utf8'));
const CARDS = data.card_models || [];
const slugify = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }
const ok = (msg) => console.log('  ok:', msg);
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

// HF API mocks — same shapes the real /api/models/<id> returns
const HF_PAYLOAD = {
  createdAt: '2026-11-01T10:20:30.000Z',
  downloads: 12340,
  likes: 56,
  pipeline_tag: 'text-generation',
  safetensors: { total: 27300000000 },
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultNavigationTimeout(60000);
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.addInitScript(() => window.localStorage.setItem('arena.pagesize', '0'));

  // mock the HF API (Playwright matches routes LAST-registered FIRST, so the
  // catch-all 404 goes first and the specific overrides register after it)
  await page.route('**/api/models/**', route =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Repository not found"}' }));
  await page.route('**/api/models/bad-org/dead-repo*', route =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Repository not found"}' }));
  await page.route('**/api/models/demo-org/Test-94*', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(HF_PAYLOAD) }));

  const picker = () => page.locator('.panel-lab .autocomplete input.input').first();
  const hfOption = () => page.locator('.panel-lab .autocomplete .dropdown-item:has-text("Add Hugging Face repo")');

  const typeQuery = async (q) => {
    await picker().click();
    await picker().fill(q);
    await page.waitForTimeout(300);
  };

  // ── 1. add from the empty-state picker ─────────────────────────────────
  await page.goto(BASE + '#/compare', { waitUntil: 'networkidle' });
  await page.waitForSelector('.panel-lab .autocomplete input.input', { timeout: 15000 });
  await typeQuery('demo-org/Test-94');
  if (!(await hfOption().count())) fail('repo-shaped query must offer the "Add Hugging Face repo" option');
  else ok('repo-shaped query offers the runtime add option');
  await page.screenshot({ path: path.join(SHOTS, 'runtime-hf-option.png') });

  await hfOption().first().click();
  await page.waitForSelector('.cmp-headcell:has-text("Test-94")', { timeout: 10000 });
  ok('added column lands in the compare grid');
  const chip = page.locator('.cmp-headcell:has-text("Test-94") .tag-lab:has-text("HF-only")');
  if (!(await chip.count())) fail('runtime column must carry the HF-only chip');
  else ok('column carries the HF-only census chip');
  const headNum = (await page.locator('.cmp-headcell:has-text("Test-94") .num').first().innerText()).trim();
  if (headNum !== '—') fail(`runtime Global Score must be an honest dash, got "${headNum}"`);
  else ok('Global Score is an honest dash (no rating by contract)');
  if (!page.url().includes('models=test-94')) fail('selection must sync into ?models=, got ' + page.url());
  else ok('selection syncs into the shareable URL');
  const stored = JSON.parse(await page.evaluate(k => localStorage.getItem(k), REPO_KEY));
  if (stored?.repos?.[0]?.hf_id !== 'demo-org/Test-94') fail('localStorage lane entry missing, got ' + JSON.stringify(stored));
  else ok('entry persisted under bl_runtime_hf_v1');
  await page.screenshot({ path: path.join(SHOTS, 'runtime-hf-compare.png') });

  // ── 2. persistence: reload keeps the column (slug index includes it) ──
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.cmp-headcell', { timeout: 15000 });
  await expectCount(page, page.locator('.cmp-headcell:has-text("Test-94")'), 1,
    'runtime column survives a reload (localStorage lane)');

  // ── 3. model page: provenance panel + Remove affordance ────────────────
  await page.goto(BASE + '#/model/test-94', { waitUntil: 'networkidle' });
  await page.waitForSelector('.model-head', { timeout: 15000 });
  const headName = (await page.locator('.model-head h1').first().innerText()).trim();
  if (!headName.includes('Test-94')) fail(`runtime model page must resolve, got "${headName}"`);
  else ok('runtime model page resolves for the added repo');
  const notice = page.locator('.notice:has-text("Runtime addition")');
  if (!(await notice.count())) fail('runtime provenance notice missing on the model page');
  else ok('runtime provenance notice renders');
  const noticeText = (await notice.innerText());
  if (!noticeText.includes('demo-org/Test-94')) fail('notice must disclose the HF repo id');
  else ok('notice discloses the HF repo id');
  if (!noticeText.includes('27.3')) fail('notice should surface the params count from safetensors');
  else ok('notice surfaces the safetensors param count');
  if (!(await notice.locator('button:has-text("Remove")').count())) fail('Remove button missing');
  else ok('Remove affordance present');
  await page.screenshot({ path: path.join(SHOTS, 'runtime-hf-model-page.png') });

  // ── 4. home board: inline census row, ranked top untouched ─────────────
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.b-table .table tbody tr');
  await page.waitForTimeout(400);
  await expectCount(page, page.locator('.b-table .table tbody tr:has(.oronly-chip)'), CARDS.length + 1,
    `home board carries ${CARDS.length} baked + 1 runtime census rows`);
  const topRank = (await page.locator('.b-table .table tbody tr').first().locator('.rank').innerText()).trim();
  if (topRank !== '1') fail(`ranked #1 must keep its rank number, got "${topRank}"`);
  else ok('ranked #1 keeps its rank number (no leak)');
  const rtRow = page.locator('.b-table .table tbody tr:has-text("Test-94")').first();
  const rtRank = (await rtRow.locator('.rank').innerText()).trim();
  if (rtRank !== '—') fail(`runtime row rank must be a dash, got "${rtRank}"`);
  else ok('runtime row shows no rank');

  // ── 5. error paths ──────────────────────────────────────────────────────
  await page.goto(BASE + '#/compare', { waitUntil: 'networkidle' });
  await page.waitForSelector('.panel-lab .autocomplete input.input', { timeout: 15000 });
  await typeQuery('bad-org/dead-repo');
  await hfOption().first().click();
  const errTag = page.locator('.tag-lab.rose:has-text("404")');
  let found = false;
  for (let i = 0; i < 20 && !found; i++) { found = !!(await errTag.count()); if (!found) await page.waitForTimeout(100); }
  if (!found) fail('dead repo (404) must surface an inline error');
  else ok('dead repo surfaces an inline 404 error');
  await page.screenshot({ path: path.join(SHOTS, 'runtime-hf-error.png') });

  // already on the board (ranked row name) — refused, no fetch
  await page.evaluate(() => window.localStorage.removeItem('bl_runtime_hf_v1'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.panel-lab .autocomplete input.input', { timeout: 15000 });
  await typeQuery('nex-agi/Nex-N2.6');
  await hfOption().first().click();
  const dupTag = page.locator('.tag-lab.rose:has-text("already on the board")');
  found = false;
  for (let i = 0; i < 20 && !found; i++) { found = !!(await dupTag.count()); if (!found) await page.waitForTimeout(100); }
  if (!found) fail('a repo whose name is already ranked must be refused');
  else ok('board-name collision is refused with a clear message');

  // ── 6. removal: model page Remove → lane cleared, board back to baseline
  await page.evaluate((k) => window.localStorage.setItem(k, JSON.stringify({
    version: 1,
    repos: [{ hf_id: 'demo-org/Test-94', name: 'Test-94', org: 'demo-org', created: '2026-11-01',
      downloads: 12340, likes: 56, pipeline_tag: 'text-generation', total_params_b: 27.3, added: '2026-11-21' }],
  })), REPO_KEY);
  // the SPA reads the lane at module init — a full reload is required for
  // the seeded entry to register (hash-only navigation never re-reads it)
  await page.reload({ waitUntil: 'networkidle' });
  await page.goto(BASE + '#/model/test-94', { waitUntil: 'networkidle' });
  await page.waitForSelector('.notice:has-text("Runtime addition")', { timeout: 15000 });
  await page.locator('.notice:has-text("Runtime addition") button:has-text("Remove")').click();
  await page.waitForTimeout(600);
  if (!page.url().includes('#/')) fail('after Remove the app should navigate away from the deleted row');
  else ok('Remove navigates away from the deleted row');
  const cleared = await page.evaluate(k => localStorage.getItem(k), REPO_KEY);
  if (cleared !== null) fail(`lane key must be cleared after Remove, got "${cleared}"`);
  else ok('removal clears the localStorage lane');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.b-table .table tbody tr');
  await page.waitForTimeout(400);
  await expectCount(page, page.locator('.b-table .table tbody tr:has(.oronly-chip)'), CARDS.length,
    'after Remove the board is back to the baked census baseline');

  // leave a clean slate for the rest of the suite
  await page.evaluate((k) => window.localStorage.removeItem(k), REPO_KEY);

  if (errors.length) {
    // 404 fetches are expected behavior here; only page crashes matter
    const hard = errors.filter(e => !e.includes('Failed to load resource'));
    if (hard.length) fail(`page errors: ${hard.slice(0, 4).join(' | ')}`);
    else ok('no page errors (expected 404 resource noise only)');
  } else ok('no page errors');
  await browser.close();
})();
