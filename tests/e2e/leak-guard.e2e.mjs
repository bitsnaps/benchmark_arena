// Stale-model leak guard (e2e) — the UI-level test for the 2026-09 bug:
// "old models are still visible, even after uncheck the toggle button".
//
// Older releases (superseded_by / stale) must not appear in ANY default
// leaderboard tier, benchmark explorer, or compare preset. They may surface
// ONLY behind the Older-versions toggle or via explicit deep links (model
// page / compare URL), where they render a banner or Status row.
//
// Everything is derived from the committed snapshot via the shared mirror —
// no hardcoded counts — plus the curated regression/red-line name lists.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SHOTS = path.join(HERE, 'shots');
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173/benchmark_arena/';

const { makeMirror, slugify, MUST_BE_HIDDEN, MUST_STAY_VISIBLE } =
  await import(path.join(REPO, 'tests', 'helpers', 'snapshot.mjs'));
const M = makeMirror();
const OLD_NAMES = new Set(M.olderRows().map(r => r.name));

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }
const ok = (msg) => console.log('  ok:', msg);

// Rendered model names on a leaderboard/explorer page.
// NOTE: alias-footnote models render a ★ inside .model-link (presentation
// only) — strip it so comparisons use the data name (e.g. "grok 4 fast chat★").
async function visibleModels(page, selector) {
  const texts = await page.locator(selector).allInnerTexts();
  return texts.map(s => s.replace(/\u2605/g, '').trim()).filter(Boolean);
}

const LEADERBOARD_SEL = '.b-table .table tbody tr .model-cell .model-link';
const EXPLORER_SEL = '.hbar .name';

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // ── 1. Leaderboard: every tier hides every flagged model by default ──
  for (const [route, label] of [
    ['#/', 'All (default)'],
    ['#/?tier=closed', 'Closed'],
    ['#/?tier=open', 'Open-weight'],
  ]) {
    await page.goto(BASE + route, { waitUntil: 'networkidle' });
    await page.waitForSelector(LEADERBOARD_SEL, { timeout: 10000 });
    const shown = await visibleModels(page, LEADERBOARD_SEL);
    const leaked = shown.filter(n => OLD_NAMES.has(n));
    if (leaked.length) fail(`${label}: older models visible by default: ${leaked.join(' | ')}`);
    else ok(`${label}: ${shown.length} rows, zero older models (${OLD_NAMES.size} flagged in snapshot)`);

    for (const name of MUST_BE_HIDDEN) {
      if (!M.closed.some(r => r.name === name) && !M.open.some(r => r.name === name)) continue;
      if (shown.includes(name)) fail(`${label}: regression "${name}" visible by default`);
    }
    // red-line trio must share the default All table
    if (route === '#/') {
      let redOk = true;
      for (const name of MUST_STAY_VISIBLE) {
        if (!shown.includes(name)) { fail(`red line: "${name}" must stay visible by default`); redOk = false; }
      }
      if (redOk) ok('red line holds: ' + MUST_STAY_VISIBLE.join(' / ') + ' all visible');
    }
  }

  // ── 2. Toggle: OFF truly hides, ON interleaves the flagged set inline ──
  await page.goto(BASE + '#/', { waitUntil: 'networkidle' });
  await page.waitForSelector(LEADERBOARD_SEL);
  const sw = page.locator('label.switch', { hasText: 'Older versions' });
  if (await sw.locator('input').isChecked()) { await sw.click(); await page.waitForTimeout(300); }
  if (await page.locator('.older-section').count()) fail('separate older section rendered (must be inline-only now)');
  else ok('toggle OFF: no separate section, main table clean');

  await sw.click();
  await page.waitForTimeout(400);
  if (await page.locator('.older-section').count())
    fail('separate older section rendered while toggle is ON (older models must be INLINE)');
  else ok('toggle ON: older models render inline in the main table (no separate section)');
  // Read the main table row by row: name + whether the row is dimmed (older)
  const rowInfo = await page.locator('.b-table .table tbody tr').evaluateAll(rows =>
    rows.map(tr => ({
      name: (tr.querySelector('.model-cell .model-link')?.textContent || '').replace(/\u2605/g, '').trim(),
      older: tr.classList.contains('is-older-row'),
    })));
  const olderShown = rowInfo.filter(r => r.older).map(r => r.name);
  const expectedOlder = M.olderRows().map(r => r.name);
  if (olderShown.length !== expectedOlder.length)
    fail(`toggle ON: ${olderShown.length} dimmed older rows, snapshot flags ${expectedOlder.length}`);
  else ok(`toggle ON: exactly ${olderShown.length} flagged models interleaved inline`);
  const missing = expectedOlder.filter(n => !olderShown.includes(n));
  if (missing.length) fail('toggle ON: missing flagged models: ' + missing.join(' | '));
  // No over-flagging: every dimmed row must be flagged in the snapshot
  const misflagged = rowInfo.filter(r => r.older && !OLD_NAMES.has(r.name)).map(r => r.name);
  if (misflagged.length) fail('toggle ON: dimmed but not flagged in snapshot: ' + misflagged.join(' | '));
  else ok('dimmed set matches the snapshot flag set exactly');
  // Inline means interleaved — every model appears exactly once, no dupes
  const dupes = rowInfo.map(r => r.name).filter((n, i, arr) => n && arr.indexOf(n) !== i);
  if (dupes.length) fail('toggle ON: duplicated rows: ' + [...new Set(dupes)].join(' | '));
  else ok('toggle ON: no duplicated rows (older models interleaved, not appended)');
  await page.screenshot({ path: SHOTS + '/leak-guard-older-section.png' });

  await sw.click();
  await page.waitForTimeout(300);
  const afterOff = await visibleModels(page, LEADERBOARD_SEL);
  const stillThere = afterOff.filter(n => OLD_NAMES.has(n));
  if (stillThere.length) fail('toggle OFF again: older models still visible: ' + stillThere.join(' | '));
  else ok('toggle OFF again: older models disappear from the main table');

  // ── 3. Benchmark explorers share the rule ──
  const benches = (M.data.benchmarks || []).slice(0, 4);
  for (const bench of benches) {
    await page.goto(BASE + '#/benchmarks/' + slugify(bench), { waitUntil: 'networkidle' });
    await page.waitForSelector(EXPLORER_SEL, { timeout: 10000 });
    const shown = await visibleModels(page, EXPLORER_SEL);
    const leaked = shown.filter(n => OLD_NAMES.has(n));
    if (leaked.length) fail(`explorer "${bench}": older models visible: ${leaked.join(' | ')}`);
    else ok(`explorer "${bench}": ${shown.length} rows, zero older models`);
  }

  // ── 4. Compare presets never propose an older model ──
  await page.goto(BASE + '#/compare', { waitUntil: 'networkidle' });
  await page.waitForSelector('.panel-lab .chip', { timeout: 10000 });
  for (const chip of ['Top 3 overall', 'Top 3 open-weight', 'Battle of the labs']) {
    const loc = page.locator('.panel-lab .chip', { hasText: chip });
    if (!(await loc.count())) continue;
    await loc.click();
    await page.waitForTimeout(400);
    const cols = await visibleModels(page, '.cmp-headcell .model-link');
    const leaked = cols.filter(n => OLD_NAMES.has(n));
    if (leaked.length) fail(`compare preset "${chip}": older model in columns: ${leaked.join(' | ')}`);
    else ok(`compare preset "${chip}": ${cols.join(', ')} — all current`);
  }

  // ── 5. Explicit deep links still work (nothing deleted, just marked) ──
  const anyOld = [...MUST_BE_HIDDEN].find(n => OLD_NAMES.has(n));
  if (anyOld) {
    await page.goto(BASE + '#/model/' + slugify(anyOld), { waitUntil: 'networkidle' });
    await page.waitForSelector('.model-head', { timeout: 10000 });
    if (!(await page.locator('.notice, .tag-lab.warning').count()))
      fail(`model page of "${anyOld}" should mark it (banner/warning tag)`);
    else ok(`deep link keeps "${anyOld}" reachable and marked (nothing deleted)`);
  }

  if (errors.length) fail('page errors: ' + errors.join(' | '));
  else ok('zero console/page errors');

  await browser.close();
  console.log(process.exitCode ? 'LEAK GUARD FAILED' : 'LEAK GUARD PASSED');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
