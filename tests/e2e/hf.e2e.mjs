// Hugging Face identity e2e: open-weight models expose their HF repo as a
// clickable link — a compact "HF" chip in the leaderboard's model cell and
// the full repo id on the model card. Expectations derive from the committed
// snapshot (models_meta.hugging_face_id), so a data refresh cannot silently
// invalidate the spec:
//   1. every VISIBLE row with a verified HF id renders exactly one .hf-chip
//   2. rows without an HF id (closed / unverified) render none
//   3. the model card shows the full repo id linking to huggingface.co
//   4. ":free" catalog twins stay persisted in data but never render
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = path.join(REPO, 'tests', 'e2e', 'shots');
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173/benchmark_arena/';

const data = JSON.parse(fs.readFileSync(path.join(REPO, 'public/benchmark_results.json'), 'utf8'));
const META = data.models_meta || {};
const isOld = r => !!(META[r.name] && (META[r.name].superseded_by || META[r.name].stale));

// dedupe closed-first like the store's pivotAll
const seen = new Set();
const rows = [];
for (const r of [...(data.unified_closed || []), ...(data.unified_open || [])]) {
  if (seen.has(r.name)) continue;
  seen.add(r.name);
  rows.push(r);
}
const visible = rows.filter(r => !isOld(r));
const withHf = visible.filter(r => META[r.name] && META[r.name].hugging_face_id);

// anchors: a stable open model with a repo + a stable closed model without
const OPEN = withHf.find(r => r.name === 'DeepSeek V3') || withHf[0];
const CLOSED = visible.find(r => r.name === 'Claude Opus 5') || visible.find(r => !(META[r.name] && META[r.name].hugging_face_id));
const OPEN_HF = META[OPEN.name].hugging_face_id;
const OPEN_URL = 'https://huggingface.co/' + OPEN_HF;

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }
const ok = (msg) => console.log('  ok:', msg);

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  try {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('.b-table .table tbody tr', { timeout: 10000 });

    // ── 1. chip count on the leaderboard = visible rows with an HF id ──
    const chips = await page.locator('.b-table .hf-chip').count();
    if (chips === withHf.length) ok(`HF chips on the leaderboard: ${chips} (matches snapshot)`);
    else fail(`HF chips = ${chips}, expected ${withHf.length} (visible rows with hugging_face_id)`);

    // ── 2. open anchor row: chip href + tooltip carry the exact repo ──
    const openRow = page.locator('.b-table tbody tr', { has: page.locator('.model-link', { hasText: OPEN.name }) }).first();
    const chip = openRow.locator('a.hf-chip').first();
    if ((await chip.count()) === 0) {
      fail(`"${OPEN.name}" row has no HF chip`);
    } else {
      const href = await chip.getAttribute('href');
      const title = await chip.getAttribute('title');
      if (href === OPEN_URL) ok(`"${OPEN.name}" chip links to ${href}`);
      else fail(`"${OPEN.name}" chip href = "${href}", expected "${OPEN_URL}"`);
      if (title === 'Hugging Face: ' + OPEN_HF) ok('chip tooltip shows the full repo id');
      else fail(`chip title = "${title}", expected "Hugging Face: ${OPEN_HF}"`);
    }

    // ── 3. closed anchor row: no chip, ever ──
    const closedRow = page.locator('.b-table tbody tr', { has: page.locator('.model-link', { hasText: CLOSED.name }) }).first();
    const closedChips = await closedRow.locator('a.hf-chip').count();
    if (closedChips === 0) ok(`closed model "${CLOSED.name}" renders no HF chip`);
    else fail(`closed model "${CLOSED.name}" unexpectedly renders ${closedChips} HF chip(s)`);

    // ── 4. model card: full repo id as a clickable link ──
    await openRow.locator('.model-link').first().click();
    await page.waitForSelector('.model-head', { timeout: 10000 });
    const card = page.locator('.model-head a.hf-link').first();
    if ((await card.count()) === 0) {
      fail(`model card for "${OPEN.name}" has no HF link`);
    } else {
      const text = (await card.innerText()).trim();
      const href = await card.getAttribute('href');
      const target = await card.getAttribute('target');
      if (text === OPEN_HF) ok(`card shows the full repo id "${text}"`);
      else fail(`card HF text = "${text}", expected "${OPEN_HF}"`);
      if (href === OPEN_URL) ok(`card links to ${href}`);
      else fail(`card HF href = "${href}", expected "${OPEN_URL}"`);
      if (target === '_blank') ok('card HF link opens in a new tab');
      else fail(`card HF target = "${target}", expected "_blank"`);
    }

    // ── 5. closed model card: no HF link ──
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('.b-table .table tbody tr', { timeout: 10000 });
    await closedRow.locator('.model-link').first().click();
    await page.waitForSelector('.model-head', { timeout: 10000 });
    const closedCard = await page.locator('.model-head a.hf-link').count();
    if (closedCard === 0) ok(`closed model card for "${CLOSED.name}" has no HF link`);
    else fail(`closed model card unexpectedly shows ${closedCard} HF link(s)`);

    // ── 6. ":free" stays data-only — never rendered anywhere on the page ──
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('.b-table .table tbody tr', { timeout: 10000 });
    const bodyText = await page.locator('body').innerText();
    const anyFreeMeta = Object.values(META).some(m => (m.or_free_variants || []).length > 0);
    if (!bodyText.includes(':free')) ok('no ":free" variant leaks into the UI');
    else fail('":free" string rendered in the page — free variants must stay data-only');
    if (anyFreeMeta) ok('free variants present in snapshot meta (persisted for the future feature)');
    else console.log('  (note: no free variants in this snapshot — persistence untested here)');

    await page.screenshot({ path: path.join(SHOTS, 'hf-links.png'), fullPage: false });
  } catch (e) {
    fail('exception: ' + e.message);
    await page.screenshot({ path: path.join(SHOTS, 'hf-links-fail.png'), fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }

  const real = errors.filter(e => !/favicon|Download the Vue Devtools/i.test(e));
  if (real.length) fail('console/page errors: ' + JSON.stringify(real, null, 2));
  else ok('zero console errors');

  console.log(process.exitCode ? 'HF E2E FAILED' : 'HF E2E PASSED');
})();
