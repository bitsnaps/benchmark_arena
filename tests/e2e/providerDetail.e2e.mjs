// stats-66 e2e: the per-provider full page (#/providers/mine/:id) + the
// stats-66 refresh affordances + card-table sorting.
// stats-67 revision: merged Model column (exact id as a tag), Status /
// Listed as / Endpoints columns gone, IN/OUT price split with $0-vs-dash
// honesty, non-chat rows always listed (no show/hide link), and the
// scores+CL checkbox.
// Covers: card "View all" navigation, deep link, not-found state, the merged
// arena/unlisted table (honest dashes), column sorting with nulls-last,
// paste-mode refresh dialog, fetch-mode refresh against a MOCKED provider
// endpoint (page.route — no network), shared page-size control, the catalog
// "Refresh prices" hard re-fetch, and a clean console.
// Runs under tests/run-e2e.mjs (vite preview on 4173, base /benchmark_arena/).
import { chromium } from 'playwright';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173/benchmark_arena/';
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok:', m);

// Same fixture shape as myproviders.e2e: arena hits (paid + :free twin), a
// thinking route, a reseller-only id, a private gateway model, one non-chat.
const FIXTURE_V1 = JSON.stringify({
  object: 'list',
  data: [
    { id: 'claude-opus-4.6', object: 'model', supported_endpoint_types: ['openai'], pricing: { prompt: '0.000002', completion: '0.00001' } },
    { id: 'claude-opus-4.6:free', object: 'model', supported_endpoint_types: ['openai'], pricing: { prompt: '0', completion: '0' } },
    { id: 'claude-opus-4-8-thinking', object: 'model', supported_endpoint_types: ['openai'] },
    { id: 'gpt-5.6-luna]', object: 'model', supported_endpoint_types: ['openai'], context_length: 1000000, pricing: { prompt: '0.000001', completion: '0.000004' } },
    { id: 'my-private-gateway-model', object: 'model', owned_by: 'me' },
    { id: 'aggregator-special-9b:free', object: 'model', supported_endpoint_types: ['openai'] },
    { id: 'image-forge-xl', object: 'model', owned_by: 'runware', supported_endpoint_types: ['image-generation'] },
  ],
});

// after the paste-refresh: the aggregator special is GONE, a new SKU arrived
const FIXTURE_V2 = JSON.stringify({
  object: 'list',
  data: [
    { id: 'claude-opus-4.6', object: 'model', supported_endpoint_types: ['openai'], pricing: { prompt: '0.000002', completion: '0.00001' } },
    { id: 'claude-opus-4.6:free', object: 'model', supported_endpoint_types: ['openai'], pricing: { prompt: '0', completion: '0' } },
    { id: 'gpt-5.6-luna]', object: 'model', supported_endpoint_types: ['openai'], context_length: 1000000, pricing: { prompt: '0.000001', completion: '0.000004' } },
    { id: 'brand-new-sku-9b', object: 'model', supported_endpoint_types: ['openai'], pricing: { prompt: '0.1', completion: '0.3' } },
  ],
});

// fetch-mode provider: the mock serves v1 on the add-fetch, v2 on refresh —
// proving the refresh re-reads the LIVE listing, not the stored one.
const MOCK_V1 = JSON.stringify({ object: 'list', data: [
  { id: 'gpt-5.6-luna]', object: 'model', supported_endpoint_types: ['openai'], pricing: { prompt: '0.000001', completion: '0.000004' } },
] });
const MOCK_V2 = JSON.stringify({ object: 'list', data: [
  { id: 'gpt-5.6-luna]', object: 'model', supported_endpoint_types: ['openai'], pricing: { prompt: '0.000001', completion: '0.000004' } },
  { id: 'claude-opus-4.6', object: 'model', supported_endpoint_types: ['openai'], pricing: { prompt: '0.000002', completion: '0.00001' } },
] });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultNavigationTimeout(60000);
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // ── 1. add a paste-mode provider on the My providers tab ──
  await page.goto(BASE + '#/providers?view=mine', { waitUntil: 'networkidle' });
  await page.waitForSelector('.mp-toolbar', { timeout: 15000 });
  await page.click('[aria-label="Add provider"]');
  await page.waitForSelector('.mp-modal', { timeout: 5000 });
  await page.click('label.b-radio:has-text("Paste listing")');
  await page.fill('[aria-label="Provider label"]', 'Detail Page Gateway');
  await page.fill('[aria-label="Paste listing"]', FIXTURE_V1);
  await page.click('[aria-label="Save provider"]');
  await page.waitForSelector('.mp-banner', { timeout: 10000 });
  ok('paste-mode provider added on the tab');

  // ── 2. card: tables are sortable now + View all button ──
  const viewAll = page.locator('.mp-actions-row .button', { hasText: 'View all' }).first();
  if (await viewAll.count()) ok('card carries the View all button');
  else fail('View all button missing on card');
  const before = (await page.locator('.mp-matched tbody tr').first().innerText()).replace(/\s+/g, ' ').trim();
  await page.locator('.mp-matched th', { hasText: 'Score' }).click();
  await page.waitForTimeout(300);
  const afterAsc = (await page.locator('.mp-matched tbody tr').first().innerText()).replace(/\s+/g, ' ').trim();
  if (afterAsc !== before) ok('card matched table sorts on Score click (order changed)');
  else fail('card Score sort click did not change the order');
  await page.locator('.mp-matched th', { hasText: 'Score' }).click(); // back to desc-ish for later steps
  await page.waitForTimeout(200);

  // ── 3. View all → per-provider page ──
  await viewAll.click();
  await page.waitForSelector('.mpd-table', { timeout: 10000 });
  const url = page.url();
  if (/#\/providers\/mine\//.test(url)) ok('View all lands on ' + url.slice(url.indexOf('#')));
  else fail('unexpected detail URL: ' + url);
  const headName = (await page.locator('.mpd-name').innerText()).trim();
  if (headName === 'Detail Page Gateway') ok('detail header shows the provider label');
  else fail('detail header mismatch: ' + headName);

  // ── 4. merged table: counts, statuses, honest dashes ──
  const banner = (await page.locator('.mp-banner').innerText()).replace(/\s+/g, ' ').trim();
  if (banner.includes('4 of 6')) ok('detail banner: 4 of 6 chat models matched');
  else fail('detail banner mismatch: ' + banner);

  const arenaLinks = (await page.locator('.mpd-table a.model-link').allInnerTexts()).map(s => s.trim());
  const wantArena = ['Claude Opus 4.6', 'Claude Opus 4.6', 'Claude Opus 4.8', 'GPT-5.6 Luna'];
  const arenaOk = wantArena.length === arenaLinks.length && wantArena.every(n => arenaLinks.includes(n));
  if (arenaOk) ok('arena rows: ' + arenaLinks.join(', '));
  else fail('arena rows mismatch: ' + JSON.stringify(arenaLinks));

  const tableText = (await page.locator('.mpd-table').innerText()).replace(/\s+/g, ' ');
  if (tableText.includes('my-private-gateway-model') && tableText.includes('aggregator-special-9b:free'))
    ok('unlisted rows share the same table (reseller-only ids present)');
  else fail('unlisted rows missing from the merged table');

  // stats-67: Status / Listed as / Endpoints columns are GONE; the merged
  // Model column carries the exact id as a tag under the arena name.
  const headers = (await page.locator('.mpd-table th').allInnerTexts()).map(s => s.trim());
  if (!headers.includes('Status') && !headers.includes('Listed as') && !headers.includes('Endpoints'))
    ok('useless columns gone (Status / Listed as / Endpoints)');
  else fail('old columns still present: ' + headers.join('|'));
  const skuTags = await page.locator('.mpd-table .model-sub .mpd-sku').count();
  if (skuTags >= 4) ok('exact-id tags ride under the arena names (' + skuTags + ')');
  else fail('exact-id tags missing under arena rows: ' + skuTags);

  // stats-67: non-chat rows are ALWAYS listed now — no show/hide link
  const toggleCount = await page.locator('[aria-label="Toggle non-chat models"]').count();
  if (!toggleCount) ok('show/hide non-chat link is gone');
  else fail('non-chat toggle link still present');
  const ncRow = page.locator('.mpd-table tbody tr', { hasText: 'image-forge-xl' });
  if (await ncRow.count()) {
    if ((await ncRow.first().innerText()).includes('non-chat')) ok('non-chat model listed by default with the non-chat chip');
    else fail('non-chat chip missing on the image row');
  } else fail('non-chat model missing from the default table');

  // stats-67 pricing semantics: the :free twin publishes 0/0 → literal $0
  // cells; the unpriced reseller ids stay honest dashes. Never conflated.
  const freeRow = page.locator('.mpd-table tbody tr', { hasText: 'claude-opus-4.6:free' });
  const freeCells = await freeRow.locator('td').allInnerTexts();
  const dollars = freeCells.filter(c => c.trim() === '$0').length;
  if (dollars >= 2) ok('free SKU shows literal $0 price cells (' + dollars + ')');
  else fail('free SKU missing $0 cells: ' + JSON.stringify(freeCells));
  const unpricedRow = page.locator('.mpd-table tbody tr', { hasText: 'my-private-gateway-model' });
  const unpricedCells = await unpricedRow.locator('td').allInnerTexts();
  const dashes = unpricedCells.filter(c => c.trim() === '—').length;
  const zeros = unpricedCells.filter(c => c.trim() === '$0').length;
  if (dashes >= 3 && zeros === 0) ok('unpriced row keeps dashes, never a fake $0 (' + dashes + ' dashes)');
  else fail('unpriced row dash/0 mix wrong: ' + JSON.stringify(unpricedCells));

  // ── 5. status filter chips ──
  await page.locator('.mpd-filters button', { hasText: 'On the arena' }).click();
  await page.waitForTimeout(200);
  const filteredText = (await page.locator('.mpd-table').innerText()).replace(/\s+/g, ' ');
  if (!filteredText.includes('my-private-gateway-model')) ok('On-the-arena chip filters out reseller rows');
  else fail('reseller row survived the arena filter');
  await page.locator('.mpd-filters button', { hasText: 'Unlisted' }).click();
  await page.waitForTimeout(200);
  const unlistedOnly = (await page.locator('.mpd-table').innerText()).replace(/\s+/g, ' ');
  if (unlistedOnly.includes('my-private-gateway-model') && !(await page.locator('.mpd-table a.model-link').count()))
    ok('Unlisted chip shows only reseller rows (zero arena links)');
  else fail('Unlisted filter wrong: ' + unlistedOnly.slice(0, 100));
  await page.locator('.mpd-filters button', { hasText: 'All (' }).click();
  await page.waitForTimeout(200);

  // ── 6. sorting on the merged table (nulls sink, both directions) ──
  const firstDefault = (await page.locator('.mpd-table tbody tr').first().innerText()).replace(/\s+/g, ' ').trim();
  await page.locator('.mpd-table th', { hasText: 'Score' }).click(); // asc
  await page.waitForTimeout(300);
  const firstAsc = (await page.locator('.mpd-table tbody tr').first().innerText()).replace(/\s+/g, ' ').trim();
  const rowsAll = await page.locator('.mpd-table tbody tr').count();
  if (firstAsc !== firstDefault) ok('Score sort flips the merged order (' + rowsAll + ' rows in view)');
  else fail('merged Score sort did not change the first row');
  // in ASC, nulls (unlisted) must still be LAST — check the Score CELL of the
  // first row is a number and the last row's is a dash (stats-67 order:
  // Model, Context, Provider IN/OUT, Score — Score is still td #5)
  const ascFirstScore = (await page.locator('.mpd-table tbody tr').first().locator('td').nth(4).innerText()).trim();
  const ascLastScore = (await page.locator('.mpd-table tbody tr').last().locator('td').nth(4).innerText()).trim();
  if (/^\d/.test(ascFirstScore) && ascLastScore === '—') ok('asc sort: numbers on top, unlisted (dash) rows sink');
  else fail(`nulls misplace on asc sort (first score cell '${ascFirstScore}', last '${ascLastScore}')`);
  await page.locator('.mpd-table th', { hasText: 'Score' }).click(); // desc
  await page.waitForTimeout(300);
  const firstDesc = (await page.locator('.mpd-table tbody tr').first().innerText()).replace(/\s+/g, ' ').trim();
  if (firstDesc === firstDefault) ok('second click returns to the desc default');
  else fail('desc click mismatch');

  // ── 6b. stats-67 checkbox: OUR Score + CL hide, provider data stays ──
  await page.locator('.mpd-filters label.checkbox').first().click();
  await page.waitForTimeout(200);
  const headersNoScores = (await page.locator('.mpd-table th').allInnerTexts()).map(s => s.trim());
  if (!headersNoScores.includes('Score') && !headersNoScores.includes('CL'))
    ok('checkbox hides Score + CL');
  else fail('Score/CL survived the checkbox: ' + headersNoScores.join('|'));
  const upper = headersNoScores.map(s => s.toUpperCase());
  if (upper.includes('PROVIDER IN $/1M') && upper.includes('ARENA IN $/1M'))
    ok('price columns unaffected by the checkbox');
  else fail('price columns lost with the checkbox: ' + headersNoScores.join('|'));
  const unlistedRowWhenHidden = page.locator('.mpd-table tbody tr', { hasText: 'my-private-gateway-model' });
  if (await unlistedRowWhenHidden.count()) ok('unlisted rows still listed while scores are hidden');
  else fail('unlisted rows vanished with the scores');
  await page.locator('.mpd-filters label.checkbox').first().click(); // back on
  await page.waitForTimeout(200);
  if ((await page.locator('.mpd-table th', { hasText: 'Score' }).count())) ok('checkbox back on: Score returns');
  else fail('Score did not return');

  // ── 7. refresh in PASTE mode opens the paste dialog and re-pours ──
  await page.click('[aria-label="Refresh listing for Detail Page Gateway"]');
  await page.waitForSelector('.mpd-modal', { timeout: 5000 });
  ok('paste-mode refresh opens the paste dialog');
  await page.fill('.mpd-modal [aria-label="Paste listing"]', FIXTURE_V2);
  await page.click('[aria-label="Import pasted listing"]');
  await page.waitForTimeout(400);
  const v2Text = (await page.locator('.mpd-table').innerText()).replace(/\s+/g, ' ');
  if (v2Text.includes('brand-new-sku-9b') && !v2Text.includes('aggregator-special-9b')) {
    ok('paste refresh re-poured the table (new SKU in, old special gone)');
  } else fail('paste refresh did not update the table');

  // ── 8. refresh in FETCH mode against a mocked provider endpoint ──
  let mockCalls = 0;
  await page.route('**/mock.example/v1/models', (route) => {
    mockCalls += 1;
    route.fulfill({ status: 200, contentType: 'application/json', body: mockCalls === 1 ? MOCK_V1 : MOCK_V2 });
  });
  await page.click('.crumbs .crumb:has-text("My providers")');
  await page.waitForSelector('.mp-toolbar', { timeout: 10000 });
  await page.click('[aria-label="Add provider"]');
  await page.waitForSelector('.mp-modal', { timeout: 5000 });
  await page.fill('[aria-label="Provider label"]', 'Mock Gateway');
  await page.fill('[aria-label="Provider base URL"]', 'https://mock.example/v1');
  await page.click('[aria-label="Save provider"]');
  await page.waitForSelector('.mp-banner', { timeout: 10000 });
  ok('fetch-mode provider added against the mock (call 1 = v1 listing)');

  const mockCard = page.locator('.mp-card', { hasText: 'Mock Gateway' });
  await mockCard.locator('.mp-actions-row .button', { hasText: 'View all' }).click();
  await page.waitForSelector('.mpd-table', { timeout: 10000 });
  if (!(await page.locator('.mpd-table').innerText()).includes('Claude Opus 4.6'))
    ok('mock v1: only the Luna row matched (no Opus yet)');
  else fail('mock v1 unexpectedly matched Opus');
  await page.click('[aria-label="Refresh listing for Mock Gateway"]');
  await page.waitForTimeout(600);
  if (mockCalls >= 2) ok('refresh re-read the live listing (mock call ' + mockCalls + ')');
  else fail('refresh did not hit the provider endpoint');
  if ((await page.locator('.mpd-table').innerText()).includes('Claude Opus 4.6'))
    ok('mock v2: refreshed table now matches the new arena model');
  else fail('refresh did not bring in the v2 model');

  // ── 9. shared rows-per-page control lives on the page ──
  if (await page.locator('.mpd-size select').count()) ok('rows-per-page select present (shared page size)');
  else fail('rows-per-page select missing');

  // ── 10. not-found state for a bogus id ──
  await page.goto(BASE + '#/providers/mine/does-not-exist', { waitUntil: 'networkidle' });
  await page.waitForSelector('.mpd-missing', { timeout: 10000 });
  const missing = (await page.locator('.mpd-missing').innerText()).replace(/\s+/g, ' ');
  if (missing.includes('Provider not found')) ok('bogus id lands on the not-found state');
  else fail('not-found state missing: ' + missing.slice(0, 80));

  // ── 11. catalog Refresh prices (hard re-fetch) ──
  const reqPromise = page.waitForRequest(/providers\.json\?cb=/, { timeout: 8000 }).catch(() => null);
  await page.goto(BASE + '#/providers', { waitUntil: 'networkidle' });
  await page.waitForSelector('.prov-card', { timeout: 15000 });
  const refreshBtn = page.locator('[aria-label="Refresh catalog prices"]');
  if (!(await refreshBtn.count())) fail('Refresh prices button missing');
  await refreshBtn.click();
  const req = await reqPromise;
  if (req) ok('Refresh prices fired a cache-busted re-fetch: ' + req.url().slice(req.url().lastIndexOf('/') + 1));
  else fail('no providers.json?cb= request observed');
  await page.waitForTimeout(800);
  if (await page.locator('.prov-card').count()) ok('catalog still renders after the refresh');
  else fail('catalog went blank after refresh');
  // hidden on the My providers tab (its data is the user's own listings)
  await page.click('.tabs li a:has-text("My providers")');
  await page.waitForTimeout(300);
  if (!(await page.locator('[aria-label="Refresh catalog prices"]').isVisible().catch(() => false)))
    ok('catalog refresh hidden on the My providers tab');
  else fail('catalog refresh should be hidden on My providers');

  // ── 12. console clean ──
  if (!errors.length) ok('console clean');
  else { fail(errors.length + ' console/page error(s):'); for (const e of errors.slice(0, 5)) console.error('   ', e.slice(0, 160)); }

  await browser.close();
})();
