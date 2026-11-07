// Playground e2e: the chat journey against a mocked OpenAI-compatible
// provider (page.route — no network, no real key). Covers: navbar item,
// empty state without providers, model picker fed by two My Providers
// listings with the arena join on the card, the PICKER MODAL (stats-75):
// snapshot frozen against late providers.json, local draft + explicit
// "Use this model" confirm, Cancel leaves the chat untouched, reopen
// shows the fresh listing, ONE click selects + ONE confirm commits
// (regression: the old b-autocomplete sometimes dropped the first
// click), the full provider CATALOG (routed providers.json fixture) with
// the setup modal (base URL + key + strip-prefix checkbox + Test
// connection → linked My Providers entry → real request), the
// strip-prefix default for labs (org/fix-mini → fix-mini, "for all
// models"), free-text model ids sent exactly as typed, request shape
// (URL, bearer key, system prompt, model), streamed markdown with raw
// HTML escaped, reported-usage metrics, IndexedDB persistence across
// reload, a 401 rendered inline + Retry, the CORS/network explanation,
// deep links (fresh pre-bound chat), history switch/rename/delete, the
// picker modal's provider column search, the collapsible rail, in-place
// reply edit, message delete, a clean console, and a touch-context
// mobile section (drawer default, confirm-through-modal taps). Runs
// under tests/run-e2e.mjs
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

    // ── 1b. picker modal: snapshot + explicit confirm ────────────────
    // Regression history: the inline picker fought reactivity twice
    // (dropped first clicks, then the late-data query hijack, stats-72).
    // The modal kills the whole class BY CONSTRUCTION: open freezes a
    // snapshot, the draft is local, only "Use this model" commits.
    // Here: a providers.json payload lands WHILE the modal is open — the
    // open list must not change, Cancel must not move the chat, and the
    // next open must serve the fresh listing (Ibrahim: "a clear
    // confirmation then we update the listing").
    await page.addInitScript((s) => localStorage.setItem('ba.myproviders.v1', s), STORE);
    let delayCatalog = true;
    await page.route('**/providers.json', async (route) => {
      if (delayCatalog) {
        // one-shot delayed payload so the catalog really changes while the
        // modal is open; later fetches get the CATALOG fixture again (this
        // handler shadows the plain one below — Playwright matches routes
        // last-registered-first).
        delayCatalog = false;
        await new Promise((r) => setTimeout(r, 2500));
        return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ as_of: '2026-11-01', kinds: ['first-party'], sources: {}, providers: [{ id: 'fixlab', name: 'Fixlab', kind: 'first-party', models: [{ id: 'org/fix-mini', in: 0.5, out: 1.5, ctx: 8192 }] }] }) });
      }
      await route.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ as_of: '2026-11-01', kinds: ['first-party'], sources: {}, providers: CATALOG }) });
    });
    // The SPA already sits on #/playground after section 1 — a goto to the
    // same URL would be a same-document hash navigation (no reload, init
    // script skipped), so force a real reload to boot with the seeded store.
    await page.reload();
    const openBtn = page.locator('[data-test="pg-model-open"]');
    await openBtn.waitFor({ timeout: 15000 });
    await openBtn.click();
    const sel = page.locator('[data-test="pg-picker-modal"]');
    await sel.waitFor({ timeout: 5000 });
    const provRows0 = await sel.locator('[data-test="pg-prov-row"]').count();
    await page.waitForTimeout(3300); // providers.json lands while the modal is open
    const provRows1 = await sel.locator('[data-test="pg-prov-row"]').count();
    const countLine = await sel.locator('[data-test="pg-picker-count"]').innerText();
    if (provRows0 === 2 && provRows1 === 2 && /across 2 providers/.test(countLine)) ok(`open modal is frozen against late data (${provRows1} providers before and after the late payload)`);
    else fail(`modal snapshot failed: provider rows ${provRows0} → ${provRows1}, "${countLine.trim()}"`);
    // Draft: pick a provider + model, then CANCEL — the chat must not move.
    await sel.locator('[data-test="pg-prov-row"]', { hasText: 'Second Hub' }).click();
    await sel.locator('[data-test="pg-model-row"]', { hasText: 'hub-mini' }).first().click();
    const draftTxt = (await page.locator('[data-test="pg-picker-draft"]').innerText()).trim();
    if (draftTxt === 'hub-mini · Second Hub') ok('draft selection shows in the modal footer before confirming');
    else fail('draft footer unexpected: ' + draftTxt);
    await page.locator('[data-test="pg-picker-cancel"]').click();
    await sel.waitFor({ state: 'hidden', timeout: 5000 });
    const headAfterCancel = (await page.locator('[data-test="pg-open-label"]').innerText()).trim();
    if (headAfterCancel === 'claude-opus-4.6') ok('Cancel discards the draft — the chat keeps its model');
    else fail('cancel leaked the draft: ' + headAfterCancel);
    // Reopen: FRESH snapshot — the late catalog provider is there now.
    await openBtn.click();
    await sel.waitFor({ timeout: 5000 });
    await sel.locator('[data-test="pg-prov-row"]', { hasText: 'Fixlab' }).waitFor({ timeout: 5000 });
    ok('reopen rebuilds the snapshot — the late-arriving catalog provider appears');
    await page.locator('[data-test="pg-picker-cancel"]').click();
    await sel.waitFor({ state: 'hidden', timeout: 5000 });

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

    // ── 2b. confirm-through-modal picks (regression: b-autocomplete
    //    dropped clicks — here ONE click selects, ONE confirm commits) ─
    const pickViaModal = async (provLabel, want) => {
      await page.locator('[data-test="pg-model-open"]').click();
      const mod = page.locator('[data-test="pg-picker-modal"]');
      await mod.waitFor({ timeout: 5000 });
      await mod.locator('[data-test="pg-prov-row"]', { hasText: provLabel }).first().click();
      await mod.locator('[data-test="pg-model-row"]', { hasText: want }).first().click();
      await page.locator('[data-test="pg-picker-confirm"]').click();
      await mod.waitFor({ state: 'hidden', timeout: 5000 });
    };
    for (const [prov, label, cardText] of [
      ['Second Hub', 'hub-mini', 'hub-mini'],
      ['Test Gateway', 'claude-opus-4.6', 'Claude Opus 4.6'], // joined models show the arena name
      ['Second Hub', 'hub-mini', 'hub-mini'],
      ['Test Gateway', 'claude-opus-4.6', 'Claude Opus 4.6'], // leave the default model bound for section 3
    ]) {
      await pickViaModal(prov, label);
      const nm = (await card.locator('.pg-card-name').innerText()).trim();
      if (nm === cardText) ok(`one confirm picked ${label} via ${prov} — card updated without a second try`);
      else fail(`single confirm should show "${cardText}" on the card, got "${nm}"`);
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

    // ── 7c. picker modal: provider column search, counts, model list ──
    await page.locator('[data-test="pg-model-open"]').click();
    const selC = page.locator('[data-test="pg-picker-modal"]');
    await selC.waitFor({ timeout: 5000 });
    const countAll = await selC.locator('[data-test="pg-picker-count"]').innerText();
    await page.locator('[data-test="pg-prov-search"]').fill('Test');
    const rowsT = await selC.locator('[data-test="pg-prov-row"]').count();
    if (rowsT === 1 && /across 3 providers/.test(countAll)) ok('provider search narrows the column (3 → 1); the header count stays global (2 own + 1 catalog)');
    else fail(`provider search: rows=${rowsT}, header="${countAll.trim()}"`);
    await page.locator('[data-test="pg-prov-search"]').fill('Fix');
    const fixOpt = selC.locator('[data-test="pg-prov-row"]', { hasText: 'Fixlab' }).first();
    await fixOpt.waitFor({ timeout: 3000 });
    ok('typing filters the provider column (catalog lab found by "Fix")');
    await fixOpt.click();
    const fixModels = await selC.locator('[data-test="pg-model-row"]').count();
    if (fixModels === 2) ok('choosing a provider lists its models (Fixlab: 2, fresh from the snapshot)');
    else fail('model rows after choosing Fixlab: ' + fixModels);
    await page.locator('[data-test="pg-prov-search"]').fill('');
    if ((await selC.locator('[data-test="pg-prov-row"]').count()) === 3) ok('clearing the search restores all providers');
    else fail('clearing the provider search did not restore the column');
    await page.locator('[data-test="pg-picker-cancel"]').click();
    await selC.waitFor({ state: 'hidden', timeout: 5000 });

    // ── 7f. catalog pick → setup modal → linked entry → real request ──
    let fixReq = null;
    await page.route(FIXBASE + '/models', (route) => route.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ data: [{ id: 'fix-mini' }, { id: 'fix-large' }] }) }));
    await page.route(FIXBASE + '/chat/completions', async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      fixReq = { headers: req.headers(), body: JSON.parse(req.postData() || '{}') };
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: sse(['Fixlab says hi.\n']) });
    });
    await pickViaModal('Fixlab', 'org/fix-mini');
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
    await pickViaModal('Fixlab', 'fix-free');
    if (await modal.count() === 0 && !(await modal.isVisible().catch(() => false))) ok('dismissed setup does not re-pop on further catalog picks in the same session');
    else fail('setup modal re-opened after "Not now" — browsing feels like whack-a-mole');
    await pickViaModal('Fixlab', 'org/fix-mini'); // re-bind the target model (no modal: dismissed)
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
    const optText = await (async () => {
      await page.locator('[data-test="pg-model-open"]').click();
      const mod = page.locator('[data-test="pg-picker-modal"]');
      await mod.waitFor({ timeout: 5000 });
      const t = await mod.locator('[data-test="pg-prov-row"]').allInnerTexts();
      await page.locator('[data-test="pg-picker-cancel"]').click();
      await mod.waitFor({ state: 'hidden', timeout: 5000 });
      return t;
    })();
    const at = (s) => optText.findIndex(t => t.includes(s));
    if (at('Test Gateway') === 0 && at('Second Hub') === 1 && at('Fixlab') === 2) ok('linked provider joins My providers at the top of the modal provider column (catalog group replaced)');
    else fail('provider column order after linking: ' + JSON.stringify(optText));
    await page.locator('textarea[aria-label="Message"]').fill('hello');
    await page.keyboard.press('Enter');
    const fixMsg = page.locator('.pg-msg.assistant').last();
    await fixMsg.locator('.pg-meta').waitFor({ timeout: 15000 });
    if (fixReq?.headers.authorization === 'Bearer sk-fixlab-1' && fixReq?.body.model === 'fix-mini'
      && fixReq?.body.messages?.at(-1)?.content === 'hello') ok('catalog chat request: mocked base URL, bearer key from the linked entry, stripped model id');
    else fail('catalog request unexpected: ' + JSON.stringify(fixReq));
    // Free text (Ibrahim): a model id no listing carries can be typed and
    // sent as-is — no catalog update, no modal, exact bytes on the wire.
    // In the picker modal the typed id binds to the DRAFT provider.
    await page.locator('[data-test="pg-model-open"]').click();
    const selF = page.locator('[data-test="pg-picker-modal"]');
    await selF.waitFor({ timeout: 5000 });
    await page.locator('[data-test="pg-model-search"]').fill('brand-new-model');
    const customRow = page.locator('[data-test="pg-model-custom"]');
    await customRow.waitFor({ timeout: 3000 });
    await customRow.click();
    await page.locator('[data-test="pg-picker-confirm"]').click();
    await selF.waitFor({ state: 'hidden', timeout: 5000 });
    const customNm = (await card.locator('.pg-card-name').innerText()).trim();
    if (customNm === 'brand-new-model') ok('free text: the typed id becomes the model (plain card, no invented score)');
    else fail('free-text pick: ' + customNm);
    await page.locator('textarea[aria-label="Message"]').fill('ping');
    await page.keyboard.press('Enter');
    await page.locator('.pg-msg.assistant').last().locator('.pg-meta').waitFor({ timeout: 15000 });
    if (fixReq?.body.model === 'brand-new-model' && fixReq?.headers.authorization === 'Bearer sk-fixlab-1') ok('free-text model id is sent exactly as typed to the linked provider');
    else fail('free-text request: ' + JSON.stringify(fixReq?.body));
    await pickViaModal('Fixlab', 'fix-free'); // second catalog model of the same provider
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

    // ── 8. mobile layout (separate touch context) ─────────────
    // Phone checks: no horizontal overflow, the drawer does NOT bury the
    // chat on first visit (its own preference, default closed), the
    // composer is fully on screen (dvh, no clipped Send), and ONE tap on a
    // picker option selects it and closes the drawer (touch ≠ click). One
    // touch context; tap() requires hasTouch.
    const mctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    });
    const mp = await mctx.newPage();
    mp.on('pageerror', (e) => errors.push('pageerror(mobile): ' + e.message));
    await mp.addInitScript((s) => localStorage.setItem('ba.myproviders.v1', s), STORE);
    await mp.route('**/providers.json', (route) => route.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ as_of: '2026-11-01', kinds: ['first-party'], sources: {}, providers: CATALOG }) }));
    await mp.goto(BASE + '#/playground');
    const mcard = mp.locator('[data-test="pg-model-card"]');
    // The card lives in the drawer, which is hidden by default on phones —
    // wait on the always-visible chat head instead, then assert the drawer.
    await mp.locator('[data-test="pg-rail-toggle"]').waitFor({ timeout: 15000 });
    if (!(await mp.locator('.pg-rail').isVisible())) ok('mobile: the settings drawer does not bury the chat on first visit (default closed)');
    else fail('mobile: drawer covers the chat on first visit');
    const comp = await mp.locator('textarea[aria-label="Message"]').boundingBox();
    const mvh = await mp.evaluate(() => window.innerHeight);
    if (comp && comp.y + comp.height <= mvh + 2) ok(`mobile: composer fully on screen (bottom ${Math.round(comp.y + comp.height)} / viewport ${mvh})`);
    else fail(`mobile: composer clipped (bottom ${comp && Math.round(comp.y + comp.height)} / viewport ${mvh})`);

    const pickTouch = async (prov, want, cardText) => {
      if (!(await mp.locator('.pg-rail').isVisible())) await mp.locator('[data-test="pg-rail-toggle"]').tap();
      await mp.locator('[data-test="pg-model-open"]').tap();
      const msel = mp.locator('[data-test="pg-picker-modal"]');
      await msel.waitFor({ timeout: 3000 });
      await msel.locator('[data-test="pg-prov-row"]', { hasText: prov }).first().tap();
      await msel.locator('[data-test="pg-model-row"]', { hasText: want }).first().tap();
      await mp.locator('[data-test="pg-picker-confirm"]').tap();
      await msel.waitFor({ state: 'hidden', timeout: 3000 });
      await mp.waitForTimeout(300);
      const nm = (await mcard.locator('.pg-card-name').textContent()).trim(); // card may be display:none now
      if (nm === cardText) ok(`mobile: one confirm picked ${want} — card shows ${cardText}`);
      else fail(`mobile modal pick: expected ${cardText}, got "${nm}"`);
      if (!(await mp.locator('.pg-rail').isVisible())) ok('mobile: drawer closed after the confirm — the chat is visible again');
      else fail('mobile: drawer still covers the chat after picking a model');
    };
    await pickTouch('Second Hub', 'hub-mini', 'hub-mini');
    // Second pick straight from the chat head — the rail stays closed.
    await mp.locator('[data-test="pg-model-open-head"]').tap();
    const msel2 = mp.locator('[data-test="pg-picker-modal"]');
    await msel2.waitFor({ timeout: 3000 });
    await msel2.locator('[data-test="pg-prov-row"]', { hasText: 'Test Gateway' }).first().tap();
    await msel2.locator('[data-test="pg-model-row"]', { hasText: 'claude-opus-4.6' }).first().tap();
    await mp.locator('[data-test="pg-picker-confirm"]').tap();
    await msel2.waitFor({ state: 'hidden', timeout: 3000 });
    await mp.waitForTimeout(300);
    const mname = (await mcard.locator('.pg-card-name').textContent()).trim();
    if (mname === 'Claude Opus 4.6') ok('mobile: the chat-head button opens the picker too — claude-opus-4.6 confirmed with the rail closed');
    else fail('mobile head-button pick: ' + mname);
    await mctx.close();

    if (errors.length) fail('console errors:\n  ' + errors.join('\n  '));
    else ok('clean console');
  } catch (e) {
    fail(e.stack || String(e));
  } finally {
    await browser.close();
  }
  console.log(process.exitCode ? 'PLAYGROUND E2E FAILED' : 'PLAYGROUND E2E PASSED');
})();
