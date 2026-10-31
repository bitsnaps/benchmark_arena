// Playground e2e: the chat journey against a mocked OpenAI-compatible
// provider (page.route — no network, no real key). Covers: navbar item,
// empty state without providers, model picker fed by two My Providers
// listings with the arena join on the card, request shape (URL, bearer
// key, system prompt, model), streamed markdown with raw HTML escaped,
// reported-usage metrics, IndexedDB persistence across reload, a 401
// rendered inline + Retry, the CORS/network explanation, deep links (fresh
// pre-bound chat), history switch/rename/delete, the provider filter, the
// collapsible rail, in-place reply edit, message delete, and a clean
// console. Runs under tests/run-e2e.mjs (vite preview on 4173, base
// /benchmark_arena/).
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

    // ── 7c. provider filter ─────────────────────────────────────────
    const countAll = await page.locator('[data-test="pg-count"]').innerText();
    await page.locator('[data-test="pg-prov-filter"]').selectOption('pgtest');
    const countFiltered = await page.locator('[data-test="pg-count"]').innerText();
    if (/across 1 provider/.test(countFiltered) && /across 2 providers/.test(countAll)) ok('provider dropdown narrows the picker (count line: 2 providers → 1)');
    else fail(`filter counts: all="${countAll.trim()}" filtered="${countFiltered.trim()}"`);
    await page.locator('[data-test="pg-prov-filter"]').selectOption('');

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
