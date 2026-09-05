// Value-lens e2e: the VALUE column (Score per 1M blended tokens) on the home
// leaderboard. Expectations are derived from the committed snapshot (same
// pattern as home.e2e.mjs), so a data refresh cannot silently invalidate it:
//   1. VALUE header sits between PRICE and the benchmark columns
//   2. anchor row (Claude Opus 5, $5/$25 → blend $10) shows Score ÷ 10
//   3. unpriced visible rows show an honest dash
//   4. clicking the header sorts by value — the two ends are exactly the
//      snapshot's best/worst value models (nulls sink in both directions)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = path.join(REPO, 'tests', 'e2e', 'shots');
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173/benchmark_arena/';

const data = JSON.parse(fs.readFileSync(path.join(REPO, 'public/benchmark_results.json'), 'utf8'));
const CORE = ['Artificial Analysis','BenchLM.ai','Arena.ai Text','SimpleBench.com','ARC-AGI-2','Design Arena','SWE-Marathon','FrontierSWE'];
const avg = r => { const v = CORE.map(b => r[b]).filter(x => x != null); return v.length ? v.reduce((a,b)=>a+b,0)/v.length : -1; };
const score = r => { const raw = avg(r); if (raw === -1) return -1; const cl = Math.min(100, Math.max(0, r.cl ?? 0)); return (cl/100)*raw + (1-cl/100)*50; };
const META = data.models_meta || {};
const isOld = r => !!(META[r.name] && (META[r.name].superseded_by || META[r.name].stale));
const blend = name => {
  const pr = META[name] && META[name].pricing_usd_per_1m;
  if (!pr || typeof pr.input !== 'number') return null;
  const out = typeof pr.output === 'number' ? pr.output : null;
  return out === null ? pr.input : (3 * pr.input + out) / 4;
};
const valueOf = r => {
  const b = blend(r.name);
  const s = score(r);
  if (!b || b <= 0 || s < 0) return null;
  return s / b;
};

// dedupe closed-first like the store's pivotAll
const seen = new Set();
const rows = [];
for (const r of [...(data.unified_closed || []), ...(data.unified_open || [])]) {
  if (seen.has(r.name)) continue;
  seen.add(r.name);
  rows.push(r);
}
const visible = rows.filter(r => !isOld(r));
const valued = visible.map(r => ({ name: r.name, v: valueOf(r) })).filter(x => x.v !== null)
  .sort((a, b) => a.v - b.v);
const WORST = valued[0];       // lowest value (frontier-priced)
const BEST = valued[valued.length - 1]; // highest value (cheap + capable)

// mirror of format.js fmtValue
const fmtValue = v => {
  if (v === null || v === undefined) return '—';
  if (v >= 100) return String(Math.round(v));
  return v.toFixed(1).replace(/\.0$/, '');
};

const anchor = rows.find(r => r.name === 'Claude Opus 5');
const ANCHOR_TXT = anchor ? fmtValue(valueOf(anchor)) : null;
// a visible row with no price → dash in the value column
const dashRow = visible.find(r => blend(r.name) === null && score(r) >= 0);

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }
const ok = (msg) => console.log('  ok:', msg);

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const firstName = () => page.locator('.b-table .table tbody tr').first()
    .locator('.model-cell .model-link').first().innerText();

  try {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('.b-table .table tbody tr', { timeout: 10000 });

    // ── 1. Header order: SCORE, PRICE, VALUE, then the 8 core columns ──
    const headers = (await page.locator('.b-table thead th').allInnerTexts()).map(s => s.trim().toUpperCase());
    const want = ['#', 'MODEL', 'SCORE', 'PRICE', 'VALUE', 'AA', 'BENCHLM', 'ARENA', 'SIMPLEB', 'ARC-2', 'DESIGN', 'SWE-M', 'FRONTIER', 'CL'];
    if (JSON.stringify(headers) === JSON.stringify(want)) ok('headers: SCORE PRICE VALUE + 8 core + CL');
    else fail('headers mismatch: ' + JSON.stringify(headers));

    // ── 2. Anchor row: Claude Opus 5 ($5 in / $25 out → blend $10) ──
    if (!anchor) {
      console.log('  (skip: no Claude Opus 5 row in this snapshot)');
    } else {
      const row = page.locator('.b-table tbody tr', { has: page.locator('.model-link', { hasText: 'Claude Opus 5' }) }).first();
      const cell = (await row.locator('.value-cell').innerText()).trim();
      if (cell === ANCHOR_TXT) ok(`Claude Opus 5 value cell = ${cell} (Score/10)`);
      else fail(`Claude Opus 5 value cell = "${cell}", expected "${ANCHOR_TXT}"`);
    }

    // ── 3. Unpriced visible rows show a dash in the VALUE cell ──
    if (!dashRow) {
      console.log('  (skip: every visible row has a price in this snapshot)');
    } else {
      const row = page.locator('.b-table tbody tr', { has: page.locator('.model-link', { hasText: dashRow.name }) }).first();
      const cell = (await row.locator('.value-cell').innerText()).trim();
      if (cell === '—') ok(`unpriced row "${dashRow.name}" shows an honest dash`);
      else fail(`unpriced row "${dashRow.name}" value cell = "${cell}", expected "—"`);
    }

    // ── 4. Sorting: two clicks cover both directions; ends = BEST / WORST ──
    await page.locator('.b-table thead th', { hasText: 'Value' }).first().click();
    await page.waitForTimeout(500);
    const first1 = await firstName();
    await page.locator('.b-table thead th', { hasText: 'Value' }).first().click();
    await page.waitForTimeout(500);
    const first2 = await firstName();
    const ends = new Set([BEST.name, WORST.name]);
    if (ends.has(first1) && ends.has(first2) && first1 !== first2)
      ok(`value sort flips between the two ends: "${first1}" ⇄ "${first2}" (best=${BEST.name} ${fmtValue(BEST.v)}, worst=${WORST.name} ${fmtValue(WORST.v)})`);
    else fail(`value sort ends wrong: got ["${first1}", "${first2}"], expected ["${BEST.name}", "${WORST.name}"] in some order`);
    // restore the default Score sort for any later navigation
    await page.locator('.b-table thead th', { hasText: 'Score' }).first().click();
    await page.waitForTimeout(300);

    await page.screenshot({ path: path.join(SHOTS, 'value-lens.png'), fullPage: false });
  } catch (e) {
    fail('exception: ' + e.message);
    await page.screenshot({ path: path.join(SHOTS, 'value-lens-fail.png'), fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }

  const real = errors.filter(e => !/favicon|Download the Vue Devtools/i.test(e));
  if (real.length) fail('console/page errors: ' + real.slice(0, 3).join(' | '));
  else ok('zero console/page errors');
  if (process.exitCode) process.exit(1);
  console.log('VALUE E2E PASSED');
})();
