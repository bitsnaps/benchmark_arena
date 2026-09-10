// Value map e2e (stats-31): the /#/value interactive scatter — "Quality per
// dollar". Expectations are derived from the committed snapshot (same
// pattern as value.e2e.mjs), so a data refresh cannot silently invalidate
// the spec:
//   1. home integrates the feature (nav item + footnote link) and both land on /#/value
//   2. default view = Our Score (X) vs Blended price (Y, log) — exactly the
//      plotted set the store math implies (current-gen rows with a score
//      and a positive blended price)
//   3. hover tooltip carries the anchor model's identity + price + score
//   4. Pareto frontier ON by default: path drawn + teal halos = snapshot frontier size
//   5. frontier toggle off removes the guide (URL mirrors ?frontier=0)
//   6. axis swap (Y → AA TTFT) re-filters honestly and updates the title
//   7. clicking a dot deep-links to the model card
//   8. Older toggle adds the older generations that have both values
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = path.join(REPO, 'tests', 'e2e', 'shots');
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173/benchmark_arena/';

// ── mirror of the store math (value.e2e.mjs pattern) ────────────────────
const data = JSON.parse(fs.readFileSync(path.join(REPO, 'public/benchmark_results.json'), 'utf8'));
const CORE = ['Artificial Analysis','BenchLM.ai','Arena.ai Text','SimpleBench.com','ARC-AGI-2','Design Arena','SWE-Marathon','FrontierSWE'];
const META = data.models_meta || {};
const score = (r) => {
  const v = CORE.map(b => r[b]).filter(x => x != null);
  if (!v.length) return null;
  const raw = v.reduce((a, b) => a + b, 0) / v.length;
  const cl = Math.min(100, Math.max(0, r.cl ?? 0));
  return (cl / 100) * raw + (1 - cl / 100) * 50;
};
const blend = (name) => {
  const m = META[name] || {};
  const aa = m.pricing_aa_usd_per_1m;               // stats-19: AA list wins
  if (aa && typeof aa.input === 'number') {
    const out = typeof aa.output === 'number' ? aa.output : null;
    const b = out === null ? aa.input : (3 * aa.input + out) / 4;  // store rule: no output → input
    return b > 0 ? b : null;                        // log axis: 0 is not plottable
  }
  const pr = m.pricing_usd_per_1m;
  if (!pr || typeof pr.input !== 'number') return null;
  const out = typeof pr.output === 'number' ? pr.output : null;
  const b = out === null ? pr.input : (3 * pr.input + out) / 4;
  return b > 0 ? b : null;
};
const ttft = (name) => (META[name] || {}).aa_ttft_seconds ?? null;
const isOld = (name) => !!(META[name] && (META[name].superseded_by || META[name].stale));

// dedupe closed-first like the store's pivotAll
const seen = new Set();
const rows = [];
for (const r of [...(data.unified_closed || []), ...(data.unified_open || [])]) {
  if (seen.has(r.name)) continue;
  seen.add(r.name);
  rows.push(r);
}

const plot = (xf, yf, older) => rows
  .filter(r => older || !isOld(r.name))
  .map(r => ({ name: r.name, x: xf(r), y: yf(r.name) }))
  .filter(p => p.x != null && p.y != null);

const DEFAULT_PTS = plot(score, blend, false);
const OLDER_PTS = plot(score, blend, true);
const TTFT_PTS = plot(score, ttft, false);

// Pareto frontier (score↑ better, price↓ better) — mirror of lib/scatter.js
const frontier = (pts) => {
  const eps = 1e-9;
  const good = (v, d) => (d === 'low' ? -v : v);
  return pts.filter((p, i) => !pts.some((q, j) => {
    if (i === j) return false;
    const qx = good(q.x, 'high'), qy = good(q.y, 'low');
    const gx = good(p.x, 'high'), gy = good(p.y, 'low');
    return qx >= gx - eps && qy >= gy - eps && (qx - gx > eps || qy - gy > eps);
  }));
};
const FRONTIER = frontier(DEFAULT_PTS);

// anchor: the best-scoring frontier model (deterministic given the snapshot)
const ANCHOR = FRONTIER.reduce((a, b) => (b.x > a.x ? b : a));
const ANCHOR_SLUG = ANCHOR.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

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
    // ── 1. Home integrates the Value map (nav + footnote link) ──
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('.navbar', { timeout: 10000 });
    const navLink = page.locator('.navbar-start .navbar-item', { hasText: 'Value map' });
    if (await navLink.count() === 1) ok('navbar has the Value map item');
    else fail('navbar Value map item missing');
    const footLink = page.locator('main a', { hasText: 'Value map' }).last();
    if (await footLink.count() >= 1) ok('home footnote links to the Value map');
    else fail('home footnote Value map link missing');
    await navLink.click();
    await page.waitForSelector('svg.value-map circle.vpt', { timeout: 10000 });
    if (page.url().includes('#/value')) ok('nav lands on #/value');
    else fail('nav did not land on #/value: ' + page.url());

    // ── 2. Default view: Score × Blended price, exact plotted set ──
    const n0 = await page.locator('svg.value-map circle.vpt').count();
    if (n0 === DEFAULT_PTS.length) ok(`default points = ${n0} (snapshot-exact)`);
    else fail(`default points = ${n0}, expected ${DEFAULT_PTS.length}`);
    // X title renders first in the SVG, Y title last
    const xTitle = (await page.locator('svg.value-map text.vaxtitle').first().textContent()).trim();
    const yTitle = (await page.locator('svg.value-map text.vaxtitle').last().textContent()).trim();
    if (/Our Score/.test(xTitle)) ok('X axis title = Our Score');
    else fail('X axis title wrong: ' + xTitle);
    if (/Blended API price/.test(yTitle)) ok('Y axis title = Blended API price');
    else fail('Y axis title wrong: ' + yTitle);
    // dot identity: every expected name is on the plot (data-name attr)
    const missing = [];
    for (const p of DEFAULT_PTS) {
      const sel = `svg.value-map circle.vpt[data-name="${p.name.replace(/"/g, '\\"')}"]`;
      if (!(await page.locator(sel).count())) missing.push(p.name);
    }
    if (!missing.length) ok('every expected model has a dot (data-name)');
    else fail(`missing dots: ${missing.join(', ')}`);

    // ── 3. Hover tooltip on the anchor frontier model ──
    await page.hover(`svg.value-map circle.vpt[data-name="${ANCHOR.name.replace(/"/g, '\\"')}"]`);
    await page.waitForSelector('.vtip', { timeout: 5000 });
    const tip = (await page.locator('.vtip').innerText()).replace(/\s+/g, ' ');
    if (tip.includes(ANCHOR.name)) ok(`tooltip names the anchor (${ANCHOR.name})`);
    else fail('tooltip misses the anchor name: ' + tip.slice(0, 120));
    if (/Score/.test(tip) && /Blended/.test(tip)) ok('tooltip carries Score + Blended price rows');
    else fail('tooltip missing Score/Blended rows: ' + tip.slice(0, 160));
    await page.mouse.move(10, 10); // clear hover before the next step
    await page.waitForTimeout(200);

    // ── 4. Frontier ON by default: guide path + halo per frontier model ──
    if (await page.locator('svg.value-map path.vfrontier').count() === 1) ok('frontier guide path drawn');
    else fail('frontier path missing');
    const halos = await page.locator('svg.value-map circle.vhalo').count();
    if (halos === FRONTIER.length) ok(`frontier halos = ${halos} (snapshot-exact)`);
    else fail(`frontier halos = ${halos}, expected ${FRONTIER.length}`);
    const picks = (await page.locator('.vm-frontier .chip').allInnerTexts()).map(s => s.trim());
    const fNames = FRONTIER.map(p => p.name);
    if (picks.length === fNames.length && fNames.every(f => picks.includes(f)))
      ok('frontier picks row lists exactly the frontier models');
    else fail(`frontier picks mismatch:\n    FRONTIER=${JSON.stringify(fNames)}\n    picks=${JSON.stringify(picks)}`);

    // ── 5. Frontier toggle off (URL mirrors ?frontier=0) ──
    await page.locator('label.switch', { hasText: 'Frontier' }).first().click();
    await page.waitForTimeout(400);
    if (await page.locator('svg.value-map path.vfrontier').count() === 0) ok('frontier off removes the guide path');
    else fail('frontier path still visible after toggle');
    if (page.url().includes('frontier=0')) ok('URL mirrors ?frontier=0');
    else fail('URL missing frontier=0: ' + page.url());
    await page.locator('label.switch', { hasText: 'Frontier' }).first().click(); // restore
    await page.waitForTimeout(300);

    // ── 6. Axis swap: Y → AA TTFT re-filters + retitles ──
    await page.selectOption('select[aria-label="Y axis metric"]', 'ttft');
    await page.waitForTimeout(500);
    const yTitle2 = (await page.locator('svg.value-map text.vaxtitle').last().textContent()).trim();
    if (/TTFT/.test(yTitle2)) ok('Y axis title follows the swap (TTFT)');
    else fail('Y axis title did not update: ' + yTitle2);
    const nT = await page.locator('svg.value-map circle.vpt').count();
    if (nT === TTFT_PTS.length) ok(`score × TTFT points = ${nT} (snapshot-exact)`);
    else fail(`score × TTFT points = ${nT}, expected ${TTFT_PTS.length}`);
    if (page.url().includes('y=ttft')) ok('URL mirrors ?y=ttft');
    else fail('URL missing y=ttft: ' + page.url());
    await page.selectOption('select[aria-label="Y axis metric"]', 'blend');
    await page.waitForTimeout(500);

    // ── 7. Click-through: dot → model card deep link ──
    await page.click(`svg.value-map circle.vpt[data-name="${ANCHOR.name.replace(/"/g, '\\"')}"]`);
    await page.waitForURL(/#\/model\//, { timeout: 8000 });
    if (page.url().includes(`/model/${ANCHOR_SLUG}`)) ok(`dot click deep-links to /model/${ANCHOR_SLUG}`);
    else fail('click landed on unexpected URL: ' + page.url());
    await page.waitForSelector('h1.section-title', { timeout: 8000 });
    const cardName = (await page.locator('h1.section-title').first().innerText()).trim();
    if (cardName === ANCHOR.name) ok(`model card shows the clicked model (${cardName})`);
    else fail(`model card shows "${cardName}", expected "${ANCHOR.name}"`);

    // ── 8. Older toggle adds the older generations with both values ──
    await page.goBack();
    await page.waitForSelector('svg.value-map circle.vpt', { timeout: 8000 });
    await page.locator('label.switch', { hasText: 'Older' }).first().click();
    await page.waitForTimeout(500);
    const n1 = await page.locator('svg.value-map circle.vpt').count();
    if (n1 === OLDER_PTS.length) ok(`with Older on: ${n1} points (snapshot-exact)`);
    else fail(`with Older on: ${n1} points, expected ${OLDER_PTS.length}`);
    if (page.url().includes('older=1')) ok('URL mirrors ?older=1');
    else fail('URL missing older=1: ' + page.url());

    await page.screenshot({ path: path.join(SHOTS, 'scatter.png'), fullPage: false });
  } catch (e) {
    fail('exception: ' + e.message);
    await page.screenshot({ path: path.join(SHOTS, 'scatter-fail.png'), fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }

  if (errors.length) fail('console/page errors:\n' + errors.join('\n'));
  else ok('console clean');
  console.log(process.exitCode ? 'SCATTER E2E FAILED' : 'SCATTER E2E PASSED');
})();
