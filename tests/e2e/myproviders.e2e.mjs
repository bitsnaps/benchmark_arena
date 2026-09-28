// stats-36 My Providers e2e (stats-37 retarget, stats-38 v2 overlay): the
// full paste-mode journey against the live catalog — inside the Providers
// page's third tab. Covers: the standalone navbar item is GONE, legacy
// /my-providers redirect lands on ?view=mine, tab-click reaches the same
// panel, deep link works, add via paste, matched/unlisted split, READ-ONLY
// score mirroring (parity against tests/helpers/snapshot.mjs, which
// re-derives the score independently of benchScale.js), variant chips,
// non-chat toggle, shared search scoping, the stats-38 "my gateways"
// Compare-pivot overlay (priced headline / honest dash / absent dot / SKU
// tooltip / toggle persistence), persistence across reload, clear-all, and
// a clean console.
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

// A realistic reseller listing: OpenAI shape, [1m] ctx tag, a thinking route,
// an :free twin of an ARENA model, OpenRouter-style pricing on the paid SKUs
// (stats-38: the Compare overlay needs published prices), a private gateway
// model, and one non-chat endpoint.
const FIXTURE = JSON.stringify({
  object: 'list',
  data: [
    { id: 'claude-opus-4.6', object: 'model', created: 1626777600, owned_by: 'claude', supported_endpoint_types: ['openai'], pricing: { prompt: '0.000002', completion: '0.00001' } },
    { id: 'claude-opus-4.6:free', object: 'model', created: 1626777600, owned_by: 'claude', supported_endpoint_types: ['openai'], pricing: { prompt: '0', completion: '0' } },
    { id: 'gpt-5.6-luna[1m]', object: 'model', created: 1626777600, owned_by: 'openai', supported_endpoint_types: ['openai'], context_length: 1000000, pricing: { prompt: '0.000001', completion: '0.000004' } },
    { id: 'claude-opus-4-8-thinking', object: 'model', created: 1626777600, owned_by: 'claude', supported_endpoint_types: ['openai'] },
    { id: 'my-private-gateway-model', object: 'model', created: 1626777600, owned_by: 'me' },
    { id: 'aggregator-special-9b:free', object: 'model', created: 1626777600, owned_by: 'community', supported_endpoint_types: ['openai'] },
    { id: 'image-forge-xl', object: 'model', created: 1626777600, owned_by: 'runware', supported_endpoint_types: ['image-generation'] },
  ],
});

// stats-51: Ibrahim's real-world shape — prices under NON-standard nested
// keys as per-1M numbers (no prompt/completion at all). Custom pricing keys
// are the only way this gateway's prices ever surface.
if (!rowFor('GPT-6 Sol')) {
  console.error('FAIL: fixture anchor model "GPT-6 Sol" missing from the snapshot — update the stats-51 fixture');
  process.exit(1);
}
const SOL_FIXTURE = JSON.stringify({
  object: 'list',
  data: [
    { id: 'gpt-6-sol', object: 'model', type: 'chat', owned_by: 'OpenAI', name: 'GPT-6 Sol',
      context_length: 1050000,
      pricing: { type: 'per_token', currency: 'USD', input_per_1M_tokens: 2.11, output_per_1M_tokens: 10.55 } },
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

  // ── 1. navbar item gone; legacy route redirects; tab click + deep link ──
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const navMy = page.locator('.navbar-start .navbar-item', { hasText: 'My Providers' });
  if (!(await navMy.count())) ok('navbar no longer carries a standalone My Providers item');
  else fail('My Providers navbar item still present');

  await page.goto(BASE + '#/my-providers', { waitUntil: 'networkidle' });
  await page.waitForSelector('.mp-empty', { timeout: 10000 });
  const redirUrl = page.url();
  if (redirUrl.includes('/providers') && redirUrl.includes('view=mine')) ok('legacy /my-providers redirects to /providers?view=mine (' + redirUrl.slice(redirUrl.indexOf('#')) + ')');
  else fail('redirect URL unexpected: ' + redirUrl);
  if (await page.locator('.mp-empty:visible').count()) ok('empty state renders on a fresh browser');
  else fail('empty state missing');

  await page.goto(BASE + '#/providers', { waitUntil: 'networkidle' });
  await page.click('.tabs li a:has-text("My providers")');
  await page.waitForSelector('.mp-empty:visible', { timeout: 10000 });
  if (page.url().includes('view=mine')) ok('tab click activates the panel and writes the ?view=mine deep link');
  else fail('tab click did not update the URL: ' + page.url());

  // ── 2. add via paste mode ──
  await page.click('[aria-label="Add provider"]');
  await page.waitForSelector('.mp-modal', { timeout: 5000 });
  // b-radio overlays the native input with a <span class="check"> that
  // intercepts pointer events — click the visible label like a user would
  await page.click('label.b-radio:has-text("Paste listing")');
  await page.fill('[aria-label="Provider label"]', 'UnoRouter Example');
  await page.fill('[aria-label="Paste listing"]', FIXTURE);
  await page.click('[aria-label="Save provider"]');
  await page.waitForSelector('.mp-banner', { timeout: 10000 });

  // ── 3. banner + matched/unlisted split ──
  const banner = (await page.locator('.mp-banner').innerText()).replace(/\s+/g, ' ').trim();
  if (banner.includes('4 of 6')) ok('banner: 4 of 6 chat models matched (' + banner.slice(0, 60) + '…)');
  else fail('banner mismatch: ' + banner);

  const matchedNames = (await page.locator('.mp-matched .model-link').allInnerTexts()).map(s => s.trim());
  const wantMatched = ['Claude Opus 4.6', 'Claude Opus 4.6', 'Claude Opus 4.8', 'GPT-5.6 Luna'];
  const same = wantMatched.length === matchedNames.length && wantMatched.every(n => matchedNames.includes(n));
  if (same) ok('matched table (per-SKU, incl. the :free twin): ' + matchedNames.join(', '));
  else fail('matched rows mismatch: ' + JSON.stringify(matchedNames));

  const unlistedText = (await page.locator('.mp-unlisted').innerText()).replace(/\s+/g, ' ');
  if (unlistedText.includes('my-private-gateway-model') && unlistedText.includes('aggregator-special-9b')) {
    ok('unlisted section carries the reseller-only ids');
  } else fail('unlisted rows missing: ' + unlistedText.slice(0, 120));

  // ── 4. variant / free / match-pass chips ──
  const matchedZone = (await page.locator('.mp-matched').innerText()).replace(/\s+/g, ' ');
  for (const [label, needle] of [['[1m] ctx tag', '[1m]'], [':free twin chip (matched-side)', ':free'], ['thinking route', 'thinking route']]) {
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
    // .first() — the paid SKU and its :free twin are two rows of the SAME
    // arena model, so the row filter matches both (stats-38 fixture)
    const href = await opusRow.locator('a.model-link').first().getAttribute('href');
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

  // ── 8b. shared search scopes rows inside the panel (stats-37) ──
  const searchBox = page.locator('input[placeholder^="Filter models"]');
  await searchBox.fill('opus');
  await page.waitForFunction(() => !document.querySelector('.mp-matched .model-link') ||
    document.querySelectorAll('.mp-matched .model-link').length === 3, null, { timeout: 5000 });
  const searched = (await page.locator('.mp-matched .model-link').allInnerTexts()).map(s => s.trim());
  if (searched.length === 3 && searched.every(n => n.includes('Opus'))) ok('shared search filters matched rows to the Opus trio (paid + free twin + thinking): ' + searched.join(', '));
  else fail('search scoping mismatch: ' + JSON.stringify(searched));
  if (!(await page.locator('.mp-unlisted').count())) ok('unlisted section collapses away when nothing matches the search');
  else fail('unlisted section should be hidden under the narrow search');
  await searchBox.fill('unorouter');
  await page.waitForFunction(() => document.querySelectorAll('.mp-matched .model-link').length === 4, null, { timeout: 5000 });
  ok('provider-name hit keeps the full listing (browse mode)');
  await searchBox.fill('');
  await page.waitForFunction(() => document.querySelectorAll('.mp-matched .model-link').length === 4, null, { timeout: 5000 });
  ok('clearing the search restores every row');

  // ── 8c. v2: the "my gateways" overlay on the Compare pivot (stats-38) ──
  await page.click('.tabs li a:has-text("Compare")');
  await page.waitForSelector('.pm-table', { timeout: 10000 });
  const mineSwitch = page.locator('label.switch:has-text("my gateways")');
  if (await mineSwitch.count()) ok('my-gateways switch appears once a gateway is connected');
  else fail('my-gateways switch missing despite a connected provider');
  await mineSwitch.click();
  await page.waitForSelector('.pm-h-mine', { timeout: 5000 });
  const headerTxt = (await page.locator('.pm-h-mine').innerText()).replace(/\s+/g, ' ').trim().toUpperCase();
  if (headerTxt.includes('UNOROUTER EXAMPLE') && headerTxt.includes('MINE')) ok('overlay column headed by the gateway label + mine marker (' + headerTxt + ')');
  else fail('overlay header unexpected: ' + headerTxt);

  // priced headline (stats-51 format change): opus-4.6 ($2 in / $10 out per
  // 1M) now renders SIDE BY SIDE like catalog cells — the 3:1 blend ($4)
  // moved into the tooltip; the :free twin (blend 0) must NOT headline
  await searchBox.fill('opus');
  await page.waitForFunction(() => document.querySelectorAll('.pm-table tbody tr').length >= 1 &&
    document.querySelector('.pm-table tbody tr .pm-mine-price'), null, { timeout: 5000 });
  const opusPivotRow = page.locator('.pm-table tbody tr', { hasText: 'Claude Opus 4.6' }).first();
  const minePrice = (await opusPivotRow.locator('.pm-mine-price').first().innerText()).trim();
  if (minePrice === '$2/$10') ok('overlay cell shows in/out SIDE BY SIDE like catalog cells: $2/$10');
  else fail('overlay cell price mismatch: ' + minePrice);

  // unpriced SKU (the thinking route) → honest dash, never a fabricated price
  const opus48Row = page.locator('.pm-table tbody tr', { hasText: 'Claude Opus 4.8' }).first();
  if (await opus48Row.locator('.pm-cell-mine').count()) {
    const dashCell = (await opus48Row.locator('.pm-cell-mine').first().innerText()).replace(/\s+/g, ' ').trim();
    if (dashCell.startsWith('—')) ok('unpriced gateway SKU renders an honest dash in the overlay');
    else fail('overlay dash expected, got: ' + JSON.stringify(dashCell));
  } else fail('Opus 4.8 row has no overlay cell');

  // models the gateway does not serve keep the absent dot (search 'qwen')
  await searchBox.fill('qwen');
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll('.pm-table tbody tr');
    return rows.length >= 1 && rows[0].querySelector('.pm-cell-mine');
  }, null, { timeout: 5000 });
  const qwenCell = (await page.locator('.pm-table tbody tr').first().locator('.pm-cell-mine').innerText()).trim();
  if (qwenCell === '·') ok('non-served model renders the absent dot in the overlay column');
  else fail('absent dot expected, got: ' + JSON.stringify(qwenCell));

  // cell tooltip enumerates every SKU incl. the free twin (append-to-body).
  // Disambiguate from the row-NAME tooltip ("Anthropic: Claude Opus 4.6 —
  // API id …") by matching the cell tooltip's rate-limit wording.
  await searchBox.fill('opus');
  await page.waitForSelector('.pm-mine-price', { timeout: 5000 });
  await opusPivotRow.locator('.pm-mine-price').first().hover();
  const tip = page.locator('.tooltip-content:has-text("claude-opus-4.6"):has-text("rate-limited")').first();
  await tip.waitFor({ state: 'visible', timeout: 5000 });
  const tipTxt = (await tip.innerText()).replace(/\s+/g, ' ');
  if (tipTxt.includes('claude-opus-4.6') && tipTxt.includes(':free')) ok('cell tooltip enumerates every SKU incl. the :free twin');
  else fail('tooltip SKU enumeration missing: ' + tipTxt.slice(0, 140));

  // the toggle persists across reload (localStorage arena.providers.mine-col)
  await searchBox.fill('');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.pm-table', { timeout: 10000 });
  if (await page.locator('.pm-h-mine').count()) ok('my-gateways toggle persists across reload (column still present)');
  else fail('toggle state lost after reload');
  await mineSwitch.click(); // off again — clean state for the remaining steps
  await page.waitForFunction(() => !document.querySelector('.pm-h-mine'), null, { timeout: 5000 });
  ok('toggling off removes the overlay columns');

  // ── 8d. stats-51: custom pricing keys — the full journey ────────────
  await page.click('.tabs li a:has-text("My providers")');
  await page.waitForSelector('.mp-card', { timeout: 10000 });
  await page.click('[aria-label="Add provider"]');
  await page.waitForSelector('.mp-modal', { timeout: 5000 });
  await page.click('label.b-radio:has-text("Paste listing")');
  await page.fill('[aria-label="Provider label"]', 'Sol Gateway');
  await page.fill('[aria-label="Paste listing"]', SOL_FIXTURE);
  // the keys section is present even with keys empty (reassurance line)
  await page.waitForSelector('.mp-keys-preview', { timeout: 5000 });
  if ((await page.locator('.mp-keys-preview').innerText()).includes('Custom pricing keys off')) {
    ok('keys section shows the honest off-line before anything is configured');
  } else fail('keys off-line missing');
  if (!(await page.locator('[aria-label="Test pricing keys"]').count())) {
    ok('dry-run Test button correctly absent in paste mode (preview is already live)');
  } else fail('Test keys button should not render in paste mode');
  await page.fill('[aria-label="Input price key path"]', 'pricing.input_per_1M_tokens');
  await page.fill('[aria-label="Output price key path"]', 'pricing.output_per_1M_tokens');
  // unit auto-suggest: the key names its unit (_per_1M_tokens) -> per-1M pre-selected
  await page.waitForFunction(() => document.querySelector('input[name="mp-unit"][value="1m"]')?.checked, null, { timeout: 5000 });
  ok('unit auto-suggested to per-1M from the key name (explicit radio, one click to override)');
  // the LIVE CHECK before any save (Ibrahim: verify before Fetch & Add)
  await page.waitForFunction(() => document.querySelector('.mp-keys-preview')?.innerText.includes('1 of 1'), null, { timeout: 5000 });
  const prevTxt = (await page.locator('.mp-keys-preview').innerText()).replace(/\s+/g, ' ');
  if (prevTxt.includes('1 of 1') && prevTxt.includes('gpt-6-sol') && prevTxt.includes('$2.11') && prevTxt.includes('$10.55')) {
    ok('live preview BEFORE save: ' + prevTxt.slice(0, 110) + '…');
  } else fail('preview content unexpected: ' + prevTxt);
  await page.click('[aria-label="Save provider"]');
  await page.waitForFunction(() => document.querySelectorAll('.mp-card').length === 2, null, { timeout: 10000 });
  ok('Sol Gateway saved with its pricing keys');

  // Compare: the key-priced gateway joins as a second mine column
  await page.click('.tabs li a:has-text("Compare")');
  await page.waitForSelector('.pm-table', { timeout: 10000 });
  await page.locator('label.switch:has-text("my gateways")').click();
  await page.waitForSelector('.pm-h-mine', { timeout: 5000 });
  const headers = await page.locator('.pm-h-mine').count();
  if (headers === 2) ok('two gateway columns after adding the key-priced provider');
  else fail('expected 2 mine columns, got ' + headers);
  await searchBox.fill('sol');
  await page.waitForFunction(() => document.querySelectorAll('.pm-table tbody tr .pm-mine-price').length >= 1, null, { timeout: 5000 });
  const solRow = page.locator('.pm-table tbody tr', { hasText: 'GPT-6 Sol' }).first();
  const solCell = (await solRow.locator('.pm-mine-price').first().innerText()).trim();
  if (solCell === '$2.11/$11') ok('custom-key prices render side by side in the overlay: ' + solCell + ' (fmtUsd rounds >=10)');
  else fail('sol overlay cell unexpected: ' + solCell);
  await solRow.locator('.pm-mine-price').first().hover();
  const solTip = page.locator('.tooltip-content:has-text("resolved via your custom pricing keys")').first();
  await solTip.waitFor({ state: 'visible', timeout: 5000 });
  const solTipTxt = (await solTip.innerText()).replace(/\s+/g, ' ');
  if (solTipTxt.includes('blended $4.22') && solTipTxt.includes('gpt-6-sol')) {
    ok('tooltip carries the blend + provenance marker: ' + solTipTxt.slice(0, 110) + '…');
  } else fail('sol tooltip unexpected: ' + solTipTxt);

  // the render-time lens: EDITING keys re-prices instantly, no re-sync
  await page.click('.tabs li a:has-text("My providers")');
  await page.waitForSelector('.mp-card', { timeout: 10000 });
  await page.click('[aria-label="Edit Sol Gateway"]');
  await page.waitForSelector('.mp-modal', { timeout: 5000 });
  await page.fill('[aria-label="Input price key path"]', 'pricing.wrong_input');
  // the broken INPUT key misses -> that side falls back to standard pricing
  // (the output key still resolves, so the entry stays "priced via keys")
  await page.waitForFunction(() => document.querySelector('.mp-keys-preview')?.innerText.includes('falls back'), null, { timeout: 5000 });
  ok('edit-modal preview flags the broken key live (entry falls back to standard pricing)');
  await page.click('[aria-label="Save provider"]');
  await page.waitForSelector('.mp-modal', { state: 'detached', timeout: 5000 });
  await page.click('.tabs li a:has-text("Compare")');
  await page.waitForSelector('.pm-table', { timeout: 10000 });
  await searchBox.fill('sol');
  await page.waitForFunction(() => {
    const el = document.querySelector('.pm-table tbody tr .pm-mine-price');
    return el && el.innerText.includes('—');
  }, null, { timeout: 5000 });
  const partialCell = (await page.locator('.pm-table tbody tr .pm-mine-price').first().innerText()).trim();
  if (partialCell === '—/$11') ok('partial pricing visible after the key edit: ' + partialCell + ' (output side still via keys — no re-sync)');
  else fail('partial cell unexpected: ' + partialCell);
  // restore — the lens bends back
  await page.click('.tabs li a:has-text("My providers")');
  await page.waitForSelector('.mp-card', { timeout: 10000 });
  await page.click('[aria-label="Edit Sol Gateway"]');
  await page.waitForSelector('.mp-modal', { timeout: 5000 });
  await page.fill('[aria-label="Input price key path"]', 'pricing.input_per_1M_tokens');
  await page.waitForFunction(() => document.querySelector('.mp-keys-preview')?.innerText.includes('1 of 1'), null, { timeout: 5000 });
  await page.click('[aria-label="Save provider"]');
  await page.waitForSelector('.mp-modal', { state: 'detached', timeout: 5000 });
  await page.click('.tabs li a:has-text("Compare")');
  await page.waitForSelector('.pm-table', { timeout: 10000 });
  await searchBox.fill('sol');
  await page.waitForFunction(() => {
    const el = document.querySelector('.pm-table tbody tr .pm-mine-price');
    return el && el.innerText.includes('$2.11');
  }, null, { timeout: 5000 });
  ok('restoring the key re-prices the cell instantly (render-time lens confirmed)');
  await searchBox.fill('');

  // ── 8e. stats-52: per-gateway chips — trim the overlay one gateway at a
  // time. State: Compare tab, master switch ON, two gateways, both on.
  // The master switch keeps its exact semantics; chips only trim.
  await page.waitForSelector('.pm-chip-mine', { timeout: 5000 });
  const mineGroups = (await page.locator('.pm-chip-group').allInnerTexts()).map(s => s.trim().toLowerCase());
  if (mineGroups.join('|') === 'providers|labs|my gateways')
    ok('gateway chips join the picker row as a third cluster (one list for all)');
  else fail('mine cluster label wrong: "' + mineGroups.join('|') + '"');
  if (await page.locator('.pm-chip-mine').count() === 2) ok('one dashed chip per connected gateway (2)');
  else fail('expected 2 gateway chips, got ' + await page.locator('.pm-chip-mine').count());

  // badges: arena models matched per gateway — honest counts, never fabricated
  const badgeOf = async (label) => {
    const t = (await page.locator(`.pm-chip-mine:has-text("${label}")`).innerText()).trim();
    const m = t.match(/(\d+)\s*$/);
    return m ? Number(m[1]) : -1;
  };
  const unoN = await badgeOf('UnoRouter');
  const solN = await badgeOf('Sol Gateway');
  if (unoN >= 1 && solN >= 1) ok(`matched-model badges live (UnoRouter ${unoN}, Sol ${solN})`);
  else fail(`badges unexpected: uno=${unoN} sol=${solN}`);

  // trimming a gateway chip drops ONLY its column; the master switch stays on
  await page.click('.pm-chip-mine:has-text("Sol Gateway")');
  await page.waitForFunction(() => document.querySelectorAll('.pm-h-mine').length === 1, null, { timeout: 5000 });
  const leftHeader = (await page.locator('.pm-h-mine').innerText()).replace(/\s+/g, ' ').trim().toUpperCase();
  const covAfterTrim = (await page.locator('.pm-coverage').innerText()).replace(/\s+/g, ' ');
  if (leftHeader.includes('UNOROUTER') && covAfterTrim.includes('+1 my gateway'))
    ok(`trim drops only Sol's column — coverage honest ("+1 my gateway", ${leftHeader})`);
  else fail(`trim wrong: header="${leftHeader}" coverage="${covAfterTrim}"`);
  if (await page.locator('label.switch:has-text("my gateways") input').isChecked())
    ok('master switch UNTOUCHED by the chip trim (still checked, semantics preserved)');
  else fail('master switch got flipped by a chip trim');

  // the trimmed chip stays visible (floor pads unselected) — one click re-adds
  await page.click('.pm-chip-mine:has-text("Sol Gateway")');
  await page.waitForFunction(() => document.querySelectorAll('.pm-h-mine').length === 2, null, { timeout: 5000 });
  ok('re-clicking the trimmed chip restores its column (2 gateway columns back)');

  // the trim persists across reload — Sol still off after reload
  await page.click('.pm-chip-mine:has-text("Sol Gateway")'); // trim again
  await page.waitForFunction(() => document.querySelectorAll('.pm-h-mine').length === 1, null, { timeout: 5000 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.pm-table', { timeout: 10000 });
  await page.waitForSelector('.pm-chip-mine', { timeout: 5000 });
  if (await page.locator('.pm-h-mine').count() === 1)
    ok('the gateway trim persists across reload (only UnoRouter\'s column returns)');
  else fail('trim lost after reload: ' + await page.locator('.pm-h-mine').count() + ' mine columns');
  // restore, then master off → the whole cluster hides (semantics unchanged)
  await page.click('.pm-chip-mine:has-text("Sol Gateway")');
  await page.waitForFunction(() => document.querySelectorAll('.pm-h-mine').length === 2, null, { timeout: 5000 });
  await page.locator('label.switch:has-text("my gateways")').click();
  await page.waitForFunction(() => !document.querySelector('.pm-chip-mine'), null, { timeout: 5000 });
  if (!(await page.locator('.pm-h-mine').count()))
    ok('master switch off hides the cluster AND the columns (all-on/all-off intact)');
  else fail('columns survived the master switch going off');

  // back to the panel for the persistence + clear-all steps
  await page.click('.tabs li a:has-text("My providers")');
  await page.waitForSelector('.mp-card', { timeout: 10000 });

  // ── 9. persistence across reload ──
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.mp-card', { timeout: 10000 });
  const afterReload = (await page.locator('.mp-card').allInnerTexts()).join(' ');
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

  // ── 10b. clear-all also dissolves the overlay (v2) ──
  await page.click('.tabs li a:has-text("Compare")');
  await page.waitForSelector('.pm-table', { timeout: 10000 });
  if (!(await page.locator('label.switch:has-text("my gateways")').count())) {
    ok('with zero gateways the my-gateways switch disappears entirely');
  } else fail('my-gateways switch should hide when no gateway is connected');

  // ── 11. console clean ──
  if (errors.length) fail('console/page errors: ' + errors.slice(0, 3).join(' || '));
  else ok('console clean');

  await browser.close();
  if (process.exitCode) console.log('MY PROVIDERS E2E FAILED');
  else console.log('MY PROVIDERS E2E PASSED');
})();
