// Playground e2e: the chat journey against a mocked OpenAI-compatible
// provider (page.route — no network, no real key). Covers: navbar item,
// empty state without providers, model picker fed by two My Providers
// listings with the arena join on the card, ONE-CLICK picks on the
// hand-rolled picker (regression: the old b-autocomplete sometimes
// dropped the first click), the full provider CATALOG (routed providers.json
// fixture) with the setup modal (base URL + key + strip-prefix checkbox +
// Test connection → linked My Providers entry → real request), the
// strip-prefix default for labs (org/fix-mini → fix-mini, "for all models"),
// free-text model ids sent exactly as typed, request shape (URL, bearer
// key, system prompt, model), streamed markdown with raw HTML escaped,
// reported-usage metrics, IndexedDB persistence across reload, a 401
// rendered inline + Retry, the CORS/network explanation, deep links (fresh
// pre-bound chat), history switch/rename/delete, the type-to-filter
// provider autocomplete (flat list), the collapsible rail, in-place reply
// edit, message delete, and a clean console. Runs under tests/run-e2e.mjs
// (vite preview on 4173, base /benchmark_arena/).
import { chromium } from 'playwright';
import { parseModelListing } from '../../src/lib/myProviders.js';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173/benchmark_arena/';
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok:', m);

const GW = 'https://gw.playground.test/v1';
const models = parseModelListing(JSON.stringify({ data: [
  { id: 'claude-opus-4.6', pricing: { prompt: '0.000002', completion: '0.00001' } },
  { id: 'my-private-model' },
] })).models;
const STORE = JSON.stringify({ version: 1, providers: [{
  id: 'pgtest', label: 'Test Gateway', baseUrl: GW, key: 'sk-e2e-test', mode: 'fetch', intent: '',
  priceKeys: null, addedAt: '2026-01-01T00:00:00Z', lastSyncAt: '2026-01-01T00:00:00Z', lastError: null, models,
}, {
  id: 'pgtest2', label: 'Second Hub', baseUrl: 'https://hub.playground.test/v1', key: 'sk-e2e-2', mode: 'fetch', intent: '',
  priceKeys: null, addedAt: '2026-01-01T00:00:00Z', lastSyncAt: '2026-01-01T00:00:00Z', lastError: null,
  models: parseModelListing(JSON.stringify({ data: [{ id: 'hub-mini' }] })).models,
}] });

const REPLY = [
  'Here is **bold** and code:',
  '',
  '```py',
  'print("hi")',
  '```',
  '<img src=x onerror="window.__xss=1">',
];
const sse = (chunks, usage) => chunks
  .map(c => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('')
  + (usage ? `data: ${JSON.stringify({ choices: [], usage })}\n\n` : '')
  + 'data: [DONE]\n\n';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };

// The catalog fixture: served for public/providers.json so the catalog
// groups are deterministic (the real file churns with every scrape).
let CATALOG = []; // empty during the no-providers empty-state check
const FIXLAB = {
  id: 'fixlab', name: 'Fixlab', kind: 'first-party',
  models: [
    { id: 'org/fix-mini', in: 0.5, out: 1.5, ctx: 8192, name: 'Fixlab: Fix Mini' },
    { id: 'fix-free', in: 0, out: 0, ctx: 4096 },
  ],
};
const FIXBASE = 'https://api.fixlab.test/v1';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultNavigationTimeout(60000);
  page.on('dialog', (d) => d.accept()); // history delete confirms
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    // the deliberate 401 / aborted request below log network errors by design
    if (m.type() === 'error' && !/401|Failed to load resource|ERR_FAILED|CORS/i.test(m.text())) errors.push('console: ' + m.text());
  });

  // Full local-store reset (localStorage + the Playground IndexedDB).
  const resetStores = () => page.evaluate(async () => {
    localStorage.clear();
    await new Promise((resolve) => {
      const r = indexedDB.deleteDatabase('ba.playground');
      r.onsuccess = r.onerror = r.onblocked = () => resolve();
    });
  });
  // Read the persisted conversations straight from IndexedDB.
  const readConvs = () => page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('ba.playground');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const out = await new Promise((resolve) => {
      const q = db.transaction('conversations', 'readonly').objectStore('conversations').getAll();
      q.onsuccess = () => resolve(q.result);
    });
    db.close();
    return out;
  });

  try {
    // Deterministic catalog: every spec page fetch of providers.json gets
    // the fixture (swapped between sections via the CATALOG variable).
    await page.route('**/providers.json', (route) => route.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ as_of: '2026-11-01', kinds: ['first-party'], sources: {}, providers: CATALOG }) }));

    // ── 1. navbar + empty state ─────────────────────────────────────
    await page.goto(BASE + '#/');
    await resetStores();
    const nav = page.locator('.navbar-start .navbar-item', { hasText: 'Playground' });
    await nav.click();
    await page.waitForURL(/#\/playground/);
    await page.locator('[data-test="pg-empty"]').waitFor({ timeout: 15000 });
    const href = await page.locator('[data-test="pg-empty"] a.button').getAttribute('href');
    if (/view=mine/.test(href || '')) ok('no providers → empty state links to My Providers');
    else fail('empty-state CTA should link to ?view=mine, got ' + href);

    // ── 2. picker + arena card ──────────────────────────────────────
    CATALOG = [FIXLAB]; // catalog goes live for the rest of the spec
    await page.evaluate((s) => localStorage.setItem('ba.myproviders.v1', s), STORE);
    let lastReq = null;
    let mode = 'ok';
    await page.route(GW + '/chat/completions', async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      lastReq = { headers: req.headers(), body: JSON.parse(req.postData() || '{}') };
      if (mode === '401') return route.fulfill({ status: 401, headers: { ...CORS, 'content-type': 'application/json' }, body: '{"error":{"message":"invalid api key"}}' });
      if (mode === 'abort') return route.abort('failed');
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: sse(REPLY.map(l => l + '\n'), { prompt_tokens: 21, completion_tokens: 34 }) });
    });
    await page.reload();
    const card = page.locator('[data-test="pg-model-card"]');
    await card.waitFor({ timeout: 15000 });
    const cardName = (await card.locator('.pg-card-name').innerText()).trim();
    const cardScore = (await card.locator('.pg-card-score').innerText()).trim();
    if (cardName === 'Claude Opus 4.6' && /^\d+(\.\d)?$/.test(cardScore)) ok(`default pick = best-rated listing, joined to the arena (${cardName}, score ${cardScore})`);
    else fail(`model card should show Claude Opus 4.6 with a score, got "${cardName}" / "${cardScore}"`);
    const price = (await card.locator('.tag-lab').first().innerText()).trim();
    if (price.includes('$2') && price.includes('$10')) ok('card shows the provider-published price ($2 / $10)');
    else fail('card price should be the provider listing price, got ' + price);

    // ── 2b. ONE-CLICK picks (regression: b-autocomplete dropped clicks) ─
    const pickInput = page.locator('[data-test="pg-model-input"]');
    const pickViaPicker = async (want) => {
      await pickInput.click();
      await page.locator('[data-test="pg-picklist"] .pg-pick-item', { hasText: want }).first().click();
      await page.locator('[data-test="pg-picklist"]').waitFor({ state: 'hidden', timeout: 3000 });
    };
    for (const [label, cardText] of [
      ['hub-mini', 'hub-mini'],
      ['claude-opus-4.6', 'Claude Opus 4.6'], // joined models show the arena name
      ['hub-mini', 'hub-mini'],
      ['claude-opus-4.6', 'Claude Opus 4.6'], // leave the default model bound for section 3
    ]) {
      await pickViaPicker(label);
      const nm = (await card.locator('.pg-card-name').innerText()).trim();
      if (nm === cardText) ok(`one click picked ${label} — card updated without a second click`);
      else fail(`single pick should show "${cardText}" on the card, got "${nm}"`);
    }

    // ── 3. send + stream + request shape ────────────────────────────
    await page.locator('#pg-system').fill('Answer briefly.');
    await page.locator('#pg-system').blur();
    await page.locator('textarea[aria-label="Message"]').fill('Say hi');
    await page.keyboard.press('Enter');
    const bot = page.locator('.pg-msg.assistant').last();
    await bot.locator('.pg-meta').waitFor({ timeout: 15000 });
    const b = lastReq?.body || {};
    if (lastReq?.headers.authorization === 'Bearer sk-e2e-test' && b.model === 'claude-opus-4.6' && b.stream === true
      && b.messages?.[0]?.role === 'system' && b.messages[0].content === 'Answer briefly.' && b.messages[1]?.content === 'Say hi') {
      ok('request: bearer key from My Providers, model id, system prompt, user turn, stream=true');
    } else fail('unexpected request: ' + JSON.stringify(lastReq));
    const strong = await bot.locator('.md strong').count();
    const pre = await bot.locator('.md pre code').innerText().catch(() => '');
    const img = await bot.locator('img').count();
    const xss = await page.evaluate(() => window.__xss);
    if (strong === 1 && pre.trim() === 'print("hi")' && img === 0 && !xss) ok('markdown rendered (bold + code fence); raw <img onerror> escaped, not executed');
    else fail(`markdown/escape check: strong=${strong} pre=${JSON.stringify(pre)} img=${img} xss=${xss}`);
    const meta = await bot.locator('.pg-meta').innerText();
    if (/21 in · 34 out/.test(meta) && /TTFT/.test(meta) && /≈ \$/.test(meta)) ok('metrics: provider-reported usage (no ≈ on tokens), TTFT, cost estimate');
    else fail('metrics line unexpected: ' + meta);

    // ── 4. persistence ──────────────────────────────────────────────
    // Send button back = the write queue drained (busy cleared after flush).
    await page.locator('[data-test="pg-send"]').waitFor({ timeout: 5000 });
    await page.reload();
    await page.locator('.pg-msg.assistant .md').first().waitFor({ timeout: 15000 });
    const n = await page.locator('.pg-msg').count();
    const convs = await readConvs();
    const dumped = JSON.stringify(convs);
    if (n === 2 && convs.length >= 1 && !dumped.includes('sk-e2e-test')) ok('conversation survives reload in IndexedDB; the key is not copied into Playground storage');
    else fail(`after reload: ${n} messages, ${convs.length} convs in IDB, key in storage: ${dumped.includes('sk-e2e-test')}`);

    // ── 5. 401 inline + Retry ───────────────────────────────────────
    mode = '401';
    await page.locator('textarea[aria-label="Message"]').fill('again');
    await page.locator('[data-test="pg-send"]').click();
    const err = page.locator('[data-test="pg-error"]').last();
    await err.waitFor({ timeout: 15000 });
    const errText = await err.innerText();
    if (/rejected the key \(HTTP 401\) — invalid api key/.test(errText)) ok('401 shows the provider message inline');
    else fail('401 error text: ' + errText);
    mode = 'ok';
    await page.locator('[data-test="pg-regen"]').last().click();
    await page.locator('.pg-msg.assistant').last().locator('.pg-meta').waitFor({ timeout: 15000 });
    const sentMsgs = lastReq.body.messages.map(m => m.role + ':' + m.content.slice(0, 7)).join('|');
    if (await page.locator('[data-test="pg-error"]').count() === 0 && /user:again$/.test(sentMsgs)) ok('Retry replaces the failed reply; failed turns are not re-sent');
    else fail('retry: ' + sentMsgs);

    // ── 6. network/CORS failure ─────────────────────────────────────
    mode = 'abort';
    await page.locator('textarea[aria-label="Message"]').fill('third');
    await page.locator('[data-test="pg-send"]').click();
    await page.locator('[data-test="pg-error"]').last().waitFor({ timeout: 15000 });
    const corsText = await page.locator('[data-test="pg-error"]').last().innerText();
    if (/CORS/.test(corsText)) ok('blocked request explains CORS instead of failing silently');
    else fail('CORS message: ' + corsText);
    mode = 'ok';

    // ── 7. deep link + New chat ─────────────────────────────────────
    // Send button back = the stream's finally ran (busy false) — the deep
    // link below must never race an in-flight reply.
    await page.locator('[data-test="pg-send"]').waitFor({ timeout: 5000 });
    await page.goto(BASE + '#/playground?p=pgtest&m=my-private-model');
    await page.locator('[data-test="pg-model-card"] .pg-card-name.plain').waitFor({ timeout: 15000 });
    const dl = (await page.locator('[data-test="pg-model-card"] .pg-card-name').innerText()).trim();
    const dlScore = (await page.locator('[data-test="pg-model-card"] .pg-card-score').innerText()).trim();
    if (dl === 'my-private-model' && dlScore === '—') ok('deep link selects the listing; off-arena model shows a dash, no invented score');
    else fail(`deep link: "${dl}" score "${dlScore}"`);
    const dlHist = await page.locator('.pg-hist-item').count();
    const dlMsgs = await page.locator('.pg-msg').count();
    if (dlHist === 2 && dlMsgs === 0) ok('deep link opened a FRESH pre-bound conversation (2 chats in history, none of the old thread)');
    else fail(`deep link should start a fresh chat: ${dlHist} history items, ${dlMsgs} messages`);
    await page.locator('.pg-chat-head [data-test="pg-new-chat"]').click();
    if (await page.locator('.pg-msg').count() === 0 && await page.locator('.pg-starter').count() > 0) ok('New chat opens a fresh empty conversation with starters');
    else fail('New chat did not start empty');
    if (await page.locator('.pg-hist-item').count() === 3) ok('previous chats stay in history (3 chats now)');
    else fail('history should hold 3 chats, got ' + await page.locator('.pg-hist-item').count());

    // ── 7b. history: rename, switch back, delete ────────────────────
    await page.locator('[data-test="pg-hist-active"] .pg-act[title="Rename chat"]').click();
    await page.locator('[data-test="pg-hist-active"] input.pg-rename').fill('Project notes');
    await page.keyboard.press('Enter');
    await page.locator('[data-test="pg-hist-active"]').filter({ hasText: 'Project notes' }).waitFor({ timeout: 5000 });
    ok('history: rename updates the list');
    await page.locator('.pg-hist-item .pg-hist-open', { hasText: 'Say hi' }).click();
    await page.locator('.pg-msg.assistant .md').first().waitFor({ timeout: 15000 });
    if (await page.locator('.pg-msg').count() === 6) ok('history: switching back restores the conversation (all 3 turns intact)');
    else fail('switching back did not restore the 6-message thread, got ' + await page.locator('.pg-msg').count());
    const beforeDel = await page.locator('.pg-hist-item').count();
    await page.locator('[data-test="pg-hist-item"]').first().locator('.pg-act[title="Delete chat"]').click();
    await page.waitForFunction((b) => document.querySelectorAll('.pg-hist-item').length === b - 1, beforeDel, { timeout: 5000 }).catch(() => {});
    if (await page.locator('.pg-hist-item').count() === beforeDel - 1) ok('history: delete removes a chat (confirm auto-accepted)');
    else fail('delete chat did not remove an item');

    // ── 7c. provider filter: type-to-filter autocomplete, flat list ───
    const countAll = await page.locator('[data-test="pg-count"]').innerText();
    const provSel = page.locator('[data-test="pg-prov-filter"]');
    await provSel.click();
    await provSel.fill('Test');
    await page.locator('[data-test="pg-prov-option"]', { hasText: 'Test Gateway' }).first().click();
    const countFiltered = await page.locator('[data-test="pg-count"]').innerText();
    if (/across 1 provider/.test(countFiltered) && /across 3 providers/.test(countAll)) ok('provider autocomplete narrows the picker (2 own + 1 catalog → 1)');
    else fail(`filter counts: all="${countAll.trim()}" filtered="${countFiltered.trim()}"`);
    await provSel.click();
    await provSel.fill('Fix');
    const fixOpt = page.locator('[data-test="pg-prov-option"]', { hasText: 'Fixlab' }).first();
    await fixOpt.waitFor({ timeout: 3000 });
    ok('typing filters the flat provider list (catalog lab found by "Fix")');
    await fixOpt.click();
    if (/across 1 provider/.test(await page.locator('[data-test="pg-count"]').innerText())) ok('catalog provider is selectable the same way');
    else fail('selecting the catalog provider did not narrow the picker');
    await provSel.click();
    await provSel.fill('');
    if (/across 3 providers/.test(await page.locator('[data-test="pg-count"]').innerText())) ok('clearing the filter restores all providers');
    else fail('clearing the filter did not reset to All providers');
    await provSel.press('Escape'); // dismiss the open dropdown before touching the model picker below
    await page.locator('[data-test="pg-prov-option"]').first().waitFor({ state: 'hidden', timeout: 3000 });

    // ── 7f. catalog pick → setup modal → linked entry → real request ──
    let fixReq = null;
    await page.route(FIXBASE + '/models', (route) => route.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ data: [{ id: 'fix-mini' }, { id: 'fix-large' }] }) }));
    await page.route(FIXBASE + '/chat/completions', async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      fixReq = { headers: req.headers(), body: JSON.parse(req.postData() || '{}') };
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: sse(['Fixlab says hi.\n']) });
    });
    await pickViaPicker('org/fix-mini');
    const modal = page.locator('[data-test="pg-setup-modal"]');
    await modal.waitFor({ timeout: 5000 });
    if ((await modal.locator('.pg-modal-title').innerText()).includes('Fixlab')) ok('picking a catalog model opens the setup modal right away');
    else fail('setup modal title wrong');
    await page.locator('[data-test="pg-setup-cancel"]').click();
    await modal.waitFor({ state: 'hidden', timeout: 5000 });
    if (await page.locator('[data-test="pg-setup-hint"]').count() === 1) ok('"Not now" keeps the pick; the card shows the not-connected hint');
    else fail('catalog pick should show the setup hint after dismissing the modal');
    // Dismissal memory, for real: fixlab has NO linked entry yet, so another
    // catalog pick must NOT re-pop the modal (content is v-if-gated; the
    // hidden b-modal shell stays in the DOM with destroy-on-hide=false).
    await pickViaPicker('fix-free');
    if (await modal.count() === 0 && !(await modal.isVisible().catch(() => false))) ok('dismissed setup does not re-pop on further catalog picks in the same session');
    else fail('setup modal re-opened after "Not now" — browsing feels like whack-a-mole');
    await pickViaPicker('org/fix-mini'); // re-bind the target model (no modal: dismissed)
    await page.locator('[data-test="pg-setup-open"]').click();
    await modal.waitFor({ timeout: 5000 });
    // (the auto-open already fired once for fixlab; "Not now" recorded the
    // dismissal, so picking another catalog model must stay modal-free)
    await page.locator('[data-test="pg-setup-url"]').fill(FIXBASE);
    await page.locator('[data-test="pg-setup-key"]').fill('sk-fixlab-1');
    // Labs ship prefixed catalog ids; strip defaults ON and the "Model
    // sent" line previews the id the API will actually get.
    const sendCode = (await page.locator('[data-test="pg-setup-send"] code').innerText()).trim();
    const sendHint = await page.locator('[data-test="pg-setup-send"]').innerText();
    if (sendCode === 'fix-mini' && /catalog: org\/fix-mini/.test(sendHint)) ok('modal previews the stripped model id (org/fix-mini → fix-mini, catalog id shown beside)');
    else fail('model preview wrong: ' + sendHint);
    if (await page.locator('[data-test="pg-setup-strip"] input').isChecked()) ok('strip-prefix defaults ON for a first-party catalog provider');
    else fail('strip-prefix should default ON for first-party catalogs');
    await page.locator('[data-test="pg-setup-test-btn"]').click();
    const testLine = page.locator('[data-test="pg-setup-test"]');
    await testLine.waitFor({ timeout: 5000 });
    const testText = await testLine.innerText();
    if (/Connected — 2 models/.test(testText) && /fix-mini is listed/.test(testText)) ok('Test connection verifies base URL + key and confirms the model id against the live list');
    else fail('test result unexpected: ' + testText);
    await page.locator('[data-test="pg-setup-save"]').click();
    await modal.waitFor({ state: 'hidden', timeout: 5000 });
    const nm = (await card.locator('.pg-card-name').innerText()).trim();
    if (nm === 'fix-mini') ok('after setup the card shows the stripped model id');
    else fail('card after setup: ' + nm);
    const mine = JSON.parse(await page.evaluate(() => localStorage.getItem('ba.myproviders.v1')));
    const entry = (mine.providers || []).find(p => p.catalogId === 'fixlab');
    const entryIds = (entry?.models || []).map(m => m.id);
    if (entry && entry.mode === 'catalog' && entry.key === 'sk-fixlab-1' && entry.baseUrl === FIXBASE
      && entryIds.includes('fix-mini') && entryIds.includes('fix-free') && !entryIds.some(i => i.startsWith('org/'))) {
      ok('setup links a My Providers entry; the WHOLE seeded listing is prefix-stripped ("for all models")');
    } else fail('catalog entry not stored correctly: ' + JSON.stringify({ mode: entry?.mode, baseUrl: entry?.baseUrl, ids: entryIds }));
    const optText = await page.locator('[data-test="pg-prov-option"]').allInnerTexts();
    const at = (s) => optText.findIndex(t => t.includes(s));
    if (at('Test Gateway') === 0 && at('Second Hub') === 1 && at('Fixlab') === 2) ok('linked provider joins My providers at the top of the flat filter list (catalog group replaced)');
    else fail('filter order after linking: ' + JSON.stringify(optText));
    await page.locator('textarea[aria-label="Message"]').fill('hello');
    await page.keyboard.press('Enter');
    const fixMsg = page.locator('.pg-msg.assistant').last();
    await fixMsg.locator('.pg-meta').waitFor({ timeout: 15000 });
    if (fixReq?.headers.authorization === 'Bearer sk-fixlab-1' && fixReq?.body.model === 'fix-mini'
      && fixReq?.body.messages?.at(-1)?.content === 'hello') ok('catalog chat request: mocked base URL, bearer key from the linked entry, stripped model id');
    else fail('catalog request unexpected: ' + JSON.stringify(fixReq));
    // Free text (Ibrahim): a model id no listing carries can be typed and
    // sent as-is — no catalog update, no modal, exact bytes on the wire.
    await pickInput.click();
    await pickInput.fill('brand-new-model');
    const customRow = page.locator('[data-test="pg-pick-custom"]');
    await customRow.waitFor({ timeout: 3000 });
    await customRow.click();
    await page.locator('[data-test="pg-picklist"]').waitFor({ state: 'hidden', timeout: 3000 });
    const customNm = (await card.locator('.pg-card-name').innerText()).trim();
    if (customNm === 'brand-new-model') ok('free text: the typed id becomes the model (plain card, no invented score)');
    else fail('free-text pick: ' + customNm);
    await page.locator('textarea[aria-label="Message"]').fill('ping');
    await page.keyboard.press('Enter');
    await page.locator('.pg-msg.assistant').last().locator('.pg-meta').waitFor({ timeout: 15000 });
    if (fixReq?.body.model === 'brand-new-model' && fixReq?.headers.authorization === 'Bearer sk-fixlab-1') ok('free-text model id is sent exactly as typed to the linked provider');
    else fail('free-text request: ' + JSON.stringify(fixReq?.body));
    await pickViaPicker('fix-free'); // second catalog model of the same provider
    if (await modal.count() === 0) ok('dismissed setup does not re-pop on further catalog picks in the same session');
    else fail('setup modal re-opened after "Not now" — browsing feels like whack-a-mole');
    const idbDump = JSON.stringify(await readConvs());
    if (!idbDump.includes('sk-fixlab-1') && !idbDump.includes('sk-e2e-test')) ok('no key from either path leaks into the Playground IndexedDB store');
    else fail('key leaked into playground storage');

    // ── 7d. collapsible rail ────────────────────────────────────────
    await page.locator('[data-test="pg-rail-toggle"]').click();
    const closed = await page.locator('.pg-grid').evaluate(el => el.classList.contains('rail-closed'))
      && !(await page.locator('.pg-rail').isVisible().catch(() => false));
    if (closed) ok('rail collapses; the chat area takes the full width');
    else fail('rail did not collapse');
    await page.locator('[data-test="pg-rail-toggle"]').click();
    await page.locator('.pg-rail').waitFor({ state: 'visible', timeout: 5000 });
    ok('rail expands again');

    // ── 7e. edit reply in place + delete a message ──────────────────
    const botMsg = page.locator('.pg-msg.assistant').filter({ has: page.locator('.md') }).first();
    await botMsg.locator('.pg-act[title="Edit reply"]').click();
    const editBox = page.locator('[data-test="pg-edit-box"] textarea');
    await editBox.waitFor({ timeout: 5000 });
    await editBox.fill('Edited in place.');
    await page.locator('[data-test="pg-edit-save"]').click();
    await page.locator('.pg-msg.assistant .md', { hasText: 'Edited in place.' }).waitFor({ timeout: 5000 });
    ok('assistant reply edited in place');
    await page.locator('.pg-msg.user').first().hover();
    await page.locator('.pg-msg.user').first().locator('.pg-act[title^="Delete this message"]').click();
    await page.locator('.pg-starter').first().waitFor({ timeout: 5000 });
    if (await page.locator('.pg-msg').count() === 0) ok('deleting the first user turn removes the whole thread (message + replies)');
    else fail('delete message left messages behind');

    // ── 8. mobile layout ────────────────────────────────────────────
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow <= 1) ok('mobile (390px): no horizontal overflow');
    else fail('mobile horizontal overflow: ' + overflow + 'px');

    if (errors.length) fail('console errors:\n  ' + errors.join('\n  '));
    else ok('clean console');
  } catch (e) {
    fail(e.stack || String(e));
  } finally {
    await browser.close();
  }
  console.log(process.exitCode ? 'PLAYGROUND E2E FAILED' : 'PLAYGROUND E2E PASSED');
})();
