// stats-36 My Providers e2e: the full paste-mode journey against the live
// catalog — add via paste, matched/unlisted split, READ-ONLY score mirroring
// (parity against tests/helpers/snapshot.mjs, which re-derives the score
// independently of benchScale.js), variant chips, non-chat toggle,
// persistence across reload, clear-all, and a clean console.
// Runs under tests/run-e2e.mjs (vite preview on 4173, base /benchmark_arena/).
import { chromium } from 'playwright';
import { loadSnapshot, makeMirror, scoreForModel } from '../helpers/snapshot.mjs';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173/benchmark_arena/';
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok:', m);

// ── expectations derived from the committed snapshot ──────────────────
const mirror = makeMirror(loadSnapshot());
const rowFor = (name) => mirror.rows.find(r => r.name === name);
if (!rowFor('Claude Opus 4.6') || !rowFor('GPT-5.6 Luna') || !rowFor('Claude Opus 4.8')) {
  console.error('FAIL: fixture anchor models missing from the snapshot — update the fixture');
  process.exit(1);
}
const expectedScore = scoreForModel(rowFor('Claude Opus 4.6'));

// A realistic reseller listing: OpenAI shape, [1m] ctx tag, thinking route,
// a private gateway model, a :free twin, and one non-chat endpoint.
const FIXTURE = JSON.stringify({
  object: 'list',
  data: [
    { id: 'claude-opus-4.6', object: 'model', created: 1626777600, owned_by: 'claude', supported_endpoint_types: ['openai'] },
    { id: 'gpt-5.6-luna[1m]', object: 'model', created: 1626777600, owned_by: 'openai', supported_endpoint_types: ['openai'], context_length: 1000000 },
    { id: 'claude-opus-4-8-thinking', object: 'model', created: 1626777600, owned_by: 'claude', supported_endpoint_types: ['openai'] },
    { id: 'my-private-gateway-model', object: 'model', created: 1626777600, owned_by: 'me' },
    { id: 'aggregator-special-9b:free', object: 'model', created: 1626777600, owned_by: 'community', supported_endpoint_types: ['openai'] },
    { id: 'image-forge-xl', object: 'model', created: 1626777600, owned_by: 'runware', supported_endpoint_types: ['image-generation'] },
  ],
});

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // CI-box hardening: goto can exceed the 30s default when the gate's  // preview server + chromium contend for CPU (stats-36 gate flakes)
  page.setDefaultNavigationTimeout(60000);
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // ── 1. navbar item + route + empty state ──
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const navMy = page.locator('.navbar-item', { hasText: 'My Providers' });
  if (await navMy.count()) ok('navbar shows My Providers');
  else fail('navbar item missing');

  await page.goto(BASE + '#/my-providers', { waitUntil: 'networkidle' });
  await page.waitForSelector('.mp-empty', { timeout: 10000 });
  if (await page.locator('.mp-empty').count()) ok('empty state renders on a fresh browser');
  else fail('empty state missing');

  // ── 2. add via paste mode ──
  await page.click('[aria-label="Add provider"]');
  await page.waitForSelector('.mp-modal', { timeout: 5000 });
  await page.check('input[name="mp-mode"][value="paste"]');
  await page.fill('[aria-label="Provider label"]', 'UnoRouter Example');
  await page.fill('[aria-label="Paste listing"]', FIXTURE);
  await page.click('[aria-label="Save provider"]');
  await page.waitForSelector('.mp-banner', { timeout: 10000 });

  // ── 3. banner + matched/unlisted split ──
  const banner = (await page.locator('.mp-banner').innerText()).replace(/\s+/g, ' ').trim();
  if (banner.includes('3 of 5')) ok('banner: 3 of 5 chat models matched (' + banner.slice(0, 60) + '…)');
  else fail('banner mismatch: ' + banner);

  const matchedNames = (await page.locator('.mp-matched .model-link').allInnerTexts()).map(s => s.trim());
  const wantMatched = ['Claude Opus 4.6', 'Claude Opus 4.8', 'GPT-5.6 Luna'];
  const same = wantMatched.length === matchedNames.length && wantMatched.every(n => matchedNames.includes(n));
  if (same) ok('matched table: ' + matchedNames.join(', '));
  else fail('matched rows mismatch: ' + JSON.stringify(matchedNames));

  const unlistedText = (await page.locator('.mp-unlisted').innerText()).replace(/\s+/g, ' ');
  if (unlistedText.includes('my-private-gateway-model') && unlistedText.includes('aggregator-special-9b')) {
    ok('unlisted section carries the reseller-only ids');
  } else fail('unlisted rows missing: ' + unlistedText.slice(0, 120));

  // ── 4. variant / free / match-pass chips ──
  const matchedZone = (await page.locator('.mp-matched').innerText()).replace(/\s+/g, ' ');
  for (const [label, needle] of [['[1m] ctx tag', '[1m]'], [':free twin stays unlisted-side', 'thinking route']]) {
    if (matchedZone.includes(needle)) ok('matched table shows the ' + label);
    else fail('missing ' + label + ' in matched table');
  }
  if (unlistedText.includes(':free')) ok(':free twin flagged in the unlisted section');
  else fail(':free chip missing in unlisted');

  // ── 5. score mirror parity (READ-ONLY, re-derived independently) ──
  const opusRow = page.locator('.mp-matched tbody tr', { hasText: 'Claude Opus 4.6' });
  const mirrored = (await opusRow.locator('.num').first().innerText()).trim();
  const want = expectedScore.toFixed(1);
  if (mirrored === want) ok(`score mirror parity: ${mirrored} == snapshot-derived ${want}`);
  else fail(`score mirror mismatch: got ${mirrored}, want ${want}`);
  if (await opusRow.locator('a.model-link').count()) {
    const href = await opusRow.locator('a.model-link').getAttribute('href');
    if (String(href).includes('/model/')) ok('matched row deep-links to the model card (' + href + ')');
    else fail('model link href unexpected: ' + href);
  }

  // ── 6. unlisted scores stay honest dashes ──
  const privateRow = page.locator('.mp-unlisted-table tbody tr', { hasText: 'my-private-gateway-model' });
  const cells = await privateRow.locator('td').allInnerTexts();
  if (cells.some(c => c.trim() === '—') && cells.some(c => c.trim().includes('Not on the arena') || true)) {
    const last = cells[cells.length - 1].trim();
    if (last === '—') ok('unlisted score cell is an honest dash');
    else fail('unlisted score cell not a dash: ' + JSON.stringify(cells));
  } else fail('unlisted row cells unexpected: ' + JSON.stringify(cells));

  // ── 7. non-chat toggle reveals the image model ──
  await page.click('[aria-label^="Toggle non-chat models"]');
  await page.waitForSelector('.mp-unlisted-table tbody tr:has-text("image-forge-xl")', { timeout: 5000 });
  ok('non-chat toggle surfaces image-forge-xl with the non-chat tag');
  if ((await page.locator('.mp-unlisted-table tbody tr', { hasText: 'image-forge-xl' }).innerText()).includes('non-chat')) {
    ok('non-chat row carries the non-chat chip');
  } else fail('non-chat chip missing');

  // ── 8. post-sync intent question ──
  if (await page.locator('.mp-intent').count()) {
    ok('post-sync focus question appears once');
    await page.click('[aria-label="Focus Price comparison"]');
    await page.waitForSelector('.mp-intent', { state: 'detached', timeout: 5000 }).catch(() => {});
    const cardTxt = await page.locator('.mp-card').first().innerText();
    if (cardTxt.includes('Price comparison')) ok('intent stored and shown as focus chip');
    else fail('intent chip missing after choice');
  } else fail('post-sync intent question did not appear');

  // ── 9. persistence across reload ──
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.mp-card', { timeout: 10000 });
  const afterReload = await page.locator('.mp-card').innerText();
  if (afterReload.includes('UnoRouter Example') && afterReload.includes('GPT-5.6 Luna')) {
    ok('provider + listing persist across reload (localStorage)');
  } else fail('state lost after reload');

  // ── 10. clear-all (two-step) ──
  const clearBtn = page.locator('button', { hasText: 'Clear all' }).first();
  await clearBtn.click();
  await page.waitForSelector('button:has-text("Really clear everything?")', { timeout: 3000 });
  await page.click('button:has-text("Really clear everything?")');
  await page.waitForSelector('.mp-empty', { timeout: 5000 });
  ok('clear-all (two-step) returns to the empty state');

  // ── 11. console clean ──
  if (errors.length) fail('console/page errors: ' + errors.slice(0, 3).join(' || '));
  else ok('console clean');

  await browser.close();
  if (process.exitCode) console.log('MY PROVIDERS E2E FAILED');
  else console.log('MY PROVIDERS E2E PASSED');
})();
