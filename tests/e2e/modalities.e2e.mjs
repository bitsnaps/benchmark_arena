// stats-34 modalities e2e: leaderboard ?mod= filter, unknown-rows-hidden
// rule, model-card chips + provenance, output-beyond-text rule.
// Runs under tests/run-e2e.mjs (vite preview on 4173, base /benchmark_arena/).
// Expectations are derived from the committed snapshot — no pinned names,
// so a data refresh cannot silently invalidate the suite.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = path.join(REPO, 'tests', 'e2e', 'shots');
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173/benchmark_arena/';

const data = JSON.parse(fs.readFileSync(path.join(REPO, 'public/benchmark_results.json'), 'utf8'));
const META = data.models_meta || {};
const rowsAll = [...(data.unified_closed || []), ...(data.unified_open || [])];
const isOld = (name) => !!(META[name] && (META[name].superseded_by || META[name].stale));
const defaultRows = rowsAll.filter(r => !isOld(r.name));
const modRows = (tok) => defaultRows.filter(r => ((META[r.name]?.input_modalities) || []).includes(tok));
const unknownRows = defaultRows.filter(r => !(META[r.name]?.input_modalities || []).length);
const slugify = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

console.log('Expected (default view):', {
  all: defaultRows.length,
  image: modRows('image').length,
  audio: modRows('audio').length,
  video: modRows('video').length,
  unknown: unknownRows.length,
});

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }
const ok = (msg) => console.log('  ok:', msg);

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const SEL = 'select[aria-label="Filter by input modality"]';
  const rowNames = async () => (await page.locator('.b-table .table tbody tr .model-cell .model-link').allInnerTexts()).map(s => s.trim());
  const showAllPages = async () => {
    await page.waitForSelector('.page-size select', { timeout: 5000 }).catch(() => {});
    await page.selectOption('.page-size select', '0').catch(() => {});
  };

  // ── 1. Filter select exists with live counts ──
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.b-table .table tbody tr', { timeout: 10000 });
  await showAllPages();
  if (await page.locator(SEL).count()) ok('Modalities select present on the toolbar');
  else fail('Modalities select missing');

  // ── 2. Image filter: every visible row has image input; count exact ──
  const imgExpect = modRows('image');
  if (imgExpect.length) {
    await page.selectOption(SEL, 'image');
    await page.waitForFunction(
      (n) => document.querySelectorAll('.b-table .table tbody tr').length === n,
      imgExpect.length,
    ).catch(() => {});
    const got = await rowNames();
    const want = new Set(imgExpect.map(r => r.name));
    if (got.length === imgExpect.length && got.every(n => want.has(n))) {
      ok(`image filter: ${got.length} rows, all snapshot-derived image-input models`);
    } else {
      fail(`image filter rows mismatch: got ${got.length}, want ${imgExpect.length}`);
    }
    if (page.url().includes('mod=image')) ok('URL mirrors ?mod=image');
    else fail('URL does not mirror ?mod=image: ' + page.url());

    // ── 3. unknown-rows-hidden rule ──
    const unknown = new Set(unknownRows.map(r => r.name));
    const leaked = got.filter(n => unknown.has(n));
    if (unknown.size && leaked.length === 0) ok(`unknown-modality rows hidden while filter on (${unknown.size} exist)`);
    else if (!unknown.size) ok('no unknown-modality rows in this snapshot (vacuous check passed)');
    else fail(`unknown rows leaked through the image filter: ${leaked.join(', ')}`);

    // ── 4. Deep link #/?mod=image restores state without interaction ──
    // hash history: the query lives INSIDE the hash (stats-28 lesson)
    await page.goto(BASE + '#/?mod=image', { waitUntil: 'networkidle' });
    await page.waitForSelector('.b-table .table tbody tr', { timeout: 10000 });
    await showAllPages();
    await page.waitForFunction(
      (n) => document.querySelectorAll('.b-table .table tbody tr').length === n,
      imgExpect.length,
    ).catch(() => {});
    const deep = await rowNames();
    if (deep.length === imgExpect.length) ok('deep link ?mod=image restores the filtered view');
    else fail(`deep link count ${deep.length} != expected ${imgExpect.length}`);
  } else {
    console.log('  skip: no image-input rows in this snapshot (vacuous)');
  }

  // ── 5. Stale #/?mod=bogus drops the param and resets ──
  await page.goto(BASE + '#/?mod=bogus', { waitUntil: 'networkidle' });
  await page.waitForSelector('.b-table .table tbody tr', { timeout: 10000 });
  await showAllPages();
  await page.waitForFunction(
    (n) => document.querySelectorAll('.b-table .table tbody tr').length === n,
    defaultRows.length,
  ).catch(() => {});
  if (!page.url().includes('mod=')) ok('stale ?mod=bogus dropped from the URL');
  else fail('stale ?mod=bogus not dropped: ' + page.url());
  const resetCount = (await rowNames()).length;
  if (resetCount === defaultRows.length) ok(`reset back to any-modality (${resetCount} rows)`);
  else fail(`reset count ${resetCount} != default ${defaultRows.length}`);

  // ── 6. Model card chips: multimodal model shows input chips + provenance ──
  const multi = defaultRows.map(r => r.name)
    .filter(n => (META[n]?.input_modalities || []).filter(t => t !== 'text').length >= 1)
    .sort((a, b) => (META[b].input_modalities.length) - (META[a].input_modalities.length))[0];
  if (multi) {
    await page.goto(`${BASE}#/model/${slugify(multi)}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.model-head', { timeout: 10000 });
    const chips = await page.locator('.model-head .tag-lab').allInnerTexts();
    const wantTokens = META[multi].input_modalities;
    const allTokens = wantTokens.every(t => chips.some(c => c.trim().includes(t)));
    if (allTokens) ok(`model card chips for ${multi}: ${wantTokens.join(', ')}`);
    else fail(`model card chips incomplete for ${multi}: got [${chips.join(' | ')}]`);
    const head = await page.locator('.model-head').innerText();
    if (head.includes('Input')) ok('provenance label (Input ⓘ) present');
    else fail('provenance Input label missing');
    // output chips only when beyond text
    const outBeyond = (META[multi].output_modalities || []).filter(t => t !== 'text');
    const hasOutputLabel = chips.some(c => c.trim().startsWith('Output'));
    if (outBeyond.length ? hasOutputLabel : !hasOutputLabel) {
      ok(`output chips rule honored (${outBeyond.length ? 'shown' : 'hidden'} for text${outBeyond.length ? '+' + outBeyond.join('+') : '-only'} output)`);
    } else fail('output chips rule violated');
    await page.screenshot({ path: path.join(SHOTS, 'modalities-card.png') });
  } else fail('no multimodal model found in snapshot for the card check');

  // ── 7. Text-only model: no output chips, no false multimodal chips ──
  const textOnly = defaultRows.map(r => r.name)
    .find(n => JSON.stringify(META[n]?.input_modalities || []) === JSON.stringify(['text']));
  if (textOnly) {
    await page.goto(`${BASE}#/model/${slugify(textOnly)}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.model-head', { timeout: 10000 });
    const chips = (await page.locator('.model-head .tag-lab').allInnerTexts()).map(s => s.trim());
    if (!['image', 'audio', 'video'].some(t => chips.some(c => c.includes(t)))) {
      ok(`text-only card ${textOnly} shows no non-text chips`);
    } else fail(`text-only card ${textOnly} shows non-text chips: [${chips.join(' | ')}]`);
  } else ok('no text-only model in snapshot (vacuous)');

  // ── 8. Unknown-modality card shows the honest placeholder ──
  const unknownName = unknownRows.map(r => r.name)[0];
  if (unknownName) {
    await page.goto(`${BASE}#/model/${slugify(unknownName)}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.model-head', { timeout: 10000 });
    const body = await page.locator('.model-head').innerText();
    if (body.includes('unverified')) ok(`unknown card ${unknownName} says "unverified" honestly`);
    else fail(`unknown card ${unknownName} missing the unverified note`);
  } else ok('no unknown-modality rows in snapshot (vacuous)');

  // ── 9. console clean ──
  if (errors.length) fail('console/page errors: ' + errors.slice(0, 3).join(' || '));
  else ok('console clean');

  await browser.close();
  if (process.exitCode) console.log('MODALITIES E2E FAILED');
  else console.log('MODALITIES E2E PASSED');
})();
