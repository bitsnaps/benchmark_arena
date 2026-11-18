// verify_prod_stats88.mjs — post-deploy verification for the merged Arena
// column (stats-88). Run after the Pages deploy lands:
//   PLAYWRIGHT_BROWSERS_PATH=/home/z/.cache/ms-playwright node tests/verify_prod_stats88.mjs
// Checks the LIVE site, not the local build. Exit 1 on any failure.
import { chromium } from 'playwright';

const BASE = 'https://bitsnaps.github.io/benchmark_arena/';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const doc = await (await fetch(BASE + 'benchmark_results.json' + `?nocache=${Date.now()}`)).json();
const rows = [...(doc.unified_closed || []), ...(doc.unified_open || [])];
const meta = doc.models_meta || {};

// 1. the doc carries the merged column, not the old station keys
check('benchmarks list has Arena, no Arena.ai Text',
      (doc.benchmarks || []).includes('Arena')
      && !(doc.benchmarks || []).includes('Arena.ai Text'),
      `benchmarks=${JSON.stringify(doc.benchmarks)}`);
check('avg set renamed', (doc.avg_benchmarks || []).includes('Arena')
      && !(doc.avg_benchmarks || []).includes('Arena.ai Text'),
      `avg=${JSON.stringify(doc.avg_benchmarks)}`);
check('no row carries a station key',
      rows.every(r => !('Arena.ai Text' in r || 'Arena.ai Overall' in r)));

// 2. coverage + provenance split
const withArena = rows.filter(r => r.Arena !== null && r.Arena !== undefined);
const srcs = {};
for (const m of Object.values(meta)) {
  const s = (m || {}).arena_source;
  if (s) srcs[s] = (srcs[s] || 0) + 1;
}
check('Arena coverage preserved', withArena.length >= 130, `cells=${withArena.length}`);
check('measured Overall cells present', (srcs.overall || 0) >= 30,
      `overall=${srcs.overall || 0}`);
check('calibrated fill cells present', (srcs['text-calibrated'] || 0) >= 80,
      `fill=${srcs['text-calibrated'] || 0}`);
check('vintage stamps ship', !!doc.arena_overall_asof,
      `overall_asof=${doc.arena_overall_asof} text_pub=${doc.arena_text_publish_date || 'n/a'}`);
check('fill cells bounded to the Overall range',
      withArena.every(r => r.Arena >= 0 && r.Arena <= 100),
      `min=${Math.min(...withArena.map(r => r.Arena))} max=${Math.max(...withArena.map(r => r.Arena))}`);

// 3. the headline case: Claude Fable 5.2 measured on the Overall board
const fable = rows.find(r => r.name === 'Claude Fable 5.2');
const fmeta = meta['Claude Fable 5.2'] || {};
check('Fable 5.2 row exists with a measured Overall cell',
      !!fable && fable.Arena !== null && fmeta.arena_source === 'overall',
      `cell=${fable && fable.Arena} src=${fmeta.arena_source} raw=${fmeta.arena_raw}`);
check('Fable 5.2 is the top Arena cell among ranked rows',
      !!fable && rows.filter(r => !r.unranked && r.Arena != null)
        .every(r => r.Arena <= fable.Arena),
      `top=${fable && fable.Arena}`);

// 4. the UI renders the renamed column with fill markers
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(4000);
const headerTexts = await page.$$eval('thead th', ths => ths.map(t => t.textContent.trim()));
check('table header shows Arena', headerTexts.some(t => t === 'Arena'),
      `headers=${headerTexts.join('|').slice(0, 120)}`);
const fillMarks = await page.$$eval('.arena-fill-mark', els => els.length);
check('fill markers render in the table', fillMarks >= 5, `marks=${fillMarks}`);
const titleSample = await page.$eval('.arena-fill-mark', el =>
  el.closest('span')?.getAttribute('title') || '');
check('fill tooltip discloses calibration', /calibrated from the Text board/.test(titleSample),
      titleSample.slice(0, 80));
await browser.close();
check('console clean', errors.length === 0, errors.slice(0, 3).join(' | '));

const failed = results.filter(r => !r.ok);
console.log(`\nverify_prod_stats88: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
