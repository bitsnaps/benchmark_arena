// verify_prod_stats93.mjs — live verification of the stats-93 batch on the
// deployed Pages site:
//   · MaxxBench column (unLAP's mutated DeepSWE board, via BenchLM's md
//     mirror) — 14 ranked cells, non-core (not in the avg set), vintage
//     stamps, column order after DeepSWE
//   · census fix B — a :free-only OR listing (ERNIE-5.5-Flash-Preview class)
//     renders inline with an OR-only chip and a :free listing id in meta
//   · census lane C — curated HF-only rows (hf_only flag) render with the
//     honest HF-only chip (board + compare picker + compare headcell)
//   · measured elsewhere — GDPx / RLI link panels on covered model pages,
//     absent on uncovered ones (links only, never scores)
//   · regression: ranked #1 blend + unranked default OFF + no console errors
// Expectations derive from the DEPLOYED doc, not the local snapshot.
// Run after deploy: node tests/verify_prod_stats93.mjs (repo root).
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const BASE = 'https://bitsnaps.github.io/benchmark_arena/';
const SHOTS = 'scripts/shots';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
// exact census row counts need the whole table on one page ("All")
await page.addInitScript(() => window.localStorage.setItem('arena.pagesize', '0'));
const errors = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

const doc = await (await fetch(BASE + 'benchmark_results.json')).json();
const RANKED = [...(doc.unified_closed || []), ...(doc.unified_open || [])];
const CARDS = doc.card_models || [];
const slugify = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const slugMap = new Map();
{
  const used = new Set();
  const assign = (name) => {
    let s = slugify(name); const base = s; let n = 2;
    while (used.has(s)) s = `${base}-${n++}`;
    used.add(s); slugMap.set(name, s);
  };
  for (const r of RANKED) assign(r.name);
  for (const r of CARDS) if (!slugMap.has(r.name)) assign(r.name);
}

try {
  // ── A. MaxxBench column (doc level) ──
  const bl = doc.benchmarks || [];
  const iMX = bl.indexOf('MaxxBench');
  check('benchmarks: 14 columns, MaxxBench right after DeepSWE',
    bl.length === 14 && iMX === bl.indexOf('DeepSWE') + 1, JSON.stringify(bl));
  check('MaxxBench NOT in the shipped avg set (non-core red line)',
    !(doc.avg_benchmarks || []).includes('MaxxBench'),
    JSON.stringify(doc.avg_benchmarks));
  check('vintage stamps: maxxbench_asof + CC BY-NC source attribution',
    !!doc.maxxbench_asof && /CC BY-NC 4\.0/.test(doc.maxxbench_source || ''),
    `${doc.maxxbench_asof || '-'}`);
  const cells = RANKED.filter(r => r.MaxxBench != null);
  const opus = cells.find(r => r.name === 'Claude Opus 5.5');
  const worst = cells.find(r => r.name === 'DeepSeek V4 Flash 0731');
  check('14 ranked MaxxBench cells baked (top Claude Opus 5.5 76.4, low anchor 28.1)',
    cells.length === 14 && opus?.MaxxBench === 76.4 && worst?.MaxxBench === 28.1,
    `cells=${cells.length} top=${opus?.MaxxBench}`);
  check('non-core column left cl/num_benchmarks untouched',
    cells.every(r => r.cl === Math.round((doc.avg_benchmarks || [])
      .filter(b => r[b] != null).length / (doc.avg_benchmarks || []).length * 1000) / 10),
    'all 14 rows recompute to their shipped cl');

  // ── B. census fix B: :free-only listings ──
  const ernieMeta = (doc.models_meta || {})['ERNIE-5.5-Flash-Preview'];
  check('doc: :free-only ERNIE census row + real listing id in meta',
    CARDS.some(r => r.name === 'ERNIE-5.5-Flash-Preview') &&
    ernieMeta?.or_id === 'baidu/ernie-5.5-flash-preview:free',
    ernieMeta?.or_id || 'missing');
  const laneRows = CARDS.filter(r => r.hf_only);
  check('doc: curated HF-only lane ships (15 rows, curated-hf meta)',
    laneRows.length === 15 &&
    laneRows.every(r => (doc.models_meta[r.name] || {}).match === 'curated-hf'),
    `lane=${laneRows.length}`);

  // ── C. UI: board chips ──
  await page.goto(BASE + '#/?card=1', { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('.oronly-chip', { timeout: 45000 });
  await page.waitForTimeout(1200);
  const ernieCell = page.locator('tr', { hasText: 'ERNIE-5.5-Flash-Preview' }).first();
  check('board: ERNIE row renders with the OR-only chip',
    (await ernieCell.locator('.oronly-chip', { hasText: 'OR-only' }).count()) === 1);
  const laneCell = page.locator('tr', { hasText: 'Arete-27B' }).first();
  check('board: HF-lane row renders with the HF-only chip',
    (await laneCell.locator('.oronly-chip', { hasText: 'HF-only' }).count()) === 1);
  const mxHeader = page.locator('th', { hasText: 'MaxxB' });
  check('board: MaxxBench hidden by default (non-core, columns follow the Avg set)',
    (await mxHeader.count()) === 0, `ths=${await mxHeader.count()}`);
  await page.screenshot({ path: SHOTS + '/stats93-board.png', fullPage: false });

  // ── D2. Benchmarks page: the MaxxBench per-benchmark board renders ──
  await page.goto(BASE + '#/benchmarks/maxxbench', { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('.b-table .table tbody tr', { timeout: 45000 });
  await page.waitForTimeout(1200);
  const pageTxt = await page.locator('main, #app, body').first().innerText();
  check('benchmarks page (deep link): MaxxBench board shows the baked leader (Claude Opus 5.5 76.4)',
    /MaxxBench/i.test(pageTxt) && /Claude Opus 5\.5/.test(pageTxt) && /76\.4/.test(pageTxt),
    `len=${pageTxt.length}`);

  // ── D. model page: measured elsewhere ──
  await page.goto(BASE + '#/model/' + slugMap.get('Claude Opus 5.5'),
    { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('.panel-lab', { timeout: 45000 });
  await page.waitForTimeout(1200);
  const elsewherePanel = page.locator('.panel-lab', { hasText: 'Measured elsewhere' });
  check('model page (Claude Opus 5.5): Measured elsewhere panel with both boards',
    (await elsewherePanel.count()) === 1 &&
    /GDPx/.test(await elsewherePanel.innerText()) &&
    /Remote Labor Index/.test(await elsewherePanel.innerText()));
  const gdpxHref = await elsewherePanel.locator('a[href*="gdpx.semianalysis.com"]').count();
  const rliHref = await elsewherePanel.locator('a[href*="remotelabor.ai"]').count();
  check('panel links point at the real boards (no numbers rendered)',
    gdpxHref === 1 && rliHref === 1);
  await page.screenshot({ path: SHOTS + '/stats93-elsewhere.png', fullPage: false });

  const uncovered = page.locator('.panel-lab', { hasText: 'Measured elsewhere' });
  await page.goto(BASE + '#/model/' + slugMap.get('Kimi K3.1 Pro'),
    { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('.panel-lab', { timeout: 45000 });
  await page.waitForTimeout(800);
  check('model page (Kimi K3.1 Pro): no Measured elsewhere panel (not covered)',
    (await uncovered.count()) === 0);

  // ── E. compare: HF-only chip in the census headcell ──
  const lanePick = laneRows.find(r => r.name === 'Arete-27B') || laneRows[0];
  await page.goto(BASE + '#/compare?models=' + slugMap.get(lanePick.name),
    { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('.cmp-headcell', { timeout: 45000 });
  await page.waitForTimeout(1200);
  const cmpChip = await page.locator('.cmp-headcell .tag-lab.muted').first().innerText();
  check('compare: HF-lane headcell carries the HF-only chip',
    cmpChip.trim() === 'HF-only', cmpChip);

  // ── F. regressions ──
  await page.goto(BASE + '#/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('tbody tr', { timeout: 45000 });
  await page.waitForTimeout(1200);
  const unrankedVisible = await page.locator('.unranked-chip').count();
  check('unranked census default OFF (stats-90 regression)', unrankedVisible === 0,
    `chips=${unrankedVisible}`);
  const firstRow = page.locator('.b-table .table tbody tr').first();
  const rankText = (await firstRow.locator('.rank').innerText().catch(() => '')).trim();
  const firstName = await firstRow.innerText();
  check('ranked board #1 intact (rank number + stats-92 leader Claude Fable 5.2)',
    rankText === '1' && firstName.includes('Claude Fable 5.2'),
    `rank=${rankText} row=${firstName.slice(0, 40).replace(/\n/g, ' ')}`);

  check('zero console/page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
