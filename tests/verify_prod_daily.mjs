// verify_prod_daily.mjs — post-deploy production verification (stats-29 contract).
// Run after the Pages deploy lands: node tests/verify_prod_daily.mjs
// Checks the LIVE site, not the local build. Exit 1 on any failure.
import { chromium } from 'playwright';

const BASE = 'https://bitsnaps.github.io/benchmark_arena/';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const j = async (p) => (await fetch(BASE + p + `?nocache=${Date.now()}`)).json();
const doc = await j('benchmark_results.json');
const prov = await j('providers.json');

const rows = [...(doc.unified_closed || []), ...(doc.unified_open || [])];
const ranked = rows.filter(r => !r.unranked);
const meta = doc.models_meta || {};

check('timestamp is today', (doc.timestamp || '').startsWith(new Date().toISOString().slice(0, 10)),
      `ts=${doc.timestamp}`);
check('ranked rows present', ranked.length >= 150, `ranked=${ranked.length} unranked=${rows.length - ranked.length}`);
check('meta records present', Object.keys(meta).length >= 400, `meta=${Object.keys(meta).length}`);

// stats-78: formatting-variant fold — one row per [a-z0-9+] fold key
const seen = new Map();
const dupes = [];
for (const r of rows) {
  const k = (r.name || '').toLowerCase().replace(/[^a-z0-9+]/g, '');
  if (seen.has(k)) dupes.push(`${r.name} vs ${seen.get(k)}`);
  seen.set(k, r.name);
}
check('no formatting-variant duplicate rows', dupes.length === 0, dupes.slice(0, 3).join('; '));

// stats-78: Qwen2.5 Coder fold graduated, hyphen variant gone
const qwen = rows.filter(r => /qwen2\.?5/i.test(r.name || '') && /coder/i.test(r.name) && /32b/i.test(r.name));
check('Qwen2.5 Coder single row, ranked',
      qwen.length === 1 && qwen[0].name === 'Qwen2.5 Coder 32B Instruct' && !qwen[0].unranked,
      qwen.map(r => `${r.name}(unranked=${!!r.unranked})`).join('; ') || 'absent');

// stats-62: no live row may carry the registry-only flag
const flagged = rows.filter(r => (meta[r.name] || {}).no_bench_coverage).map(r => r.name);
check('no live row flagged no_bench_coverage', flagged.length === 0, flagged.slice(0, 4).join('; '));

// new-in-7d visibility
const weekAgo = Date.now() / 1000 - 7 * 86400;
const fresh = Object.entries(meta).filter(([k, m]) => {
  const t = m.created ? Date.parse(m.created) / 1000 : 0;
  return t > weekAgo && rows.some(r => r.name === k);
}).map(([k]) => k);
check('new models visible in 7d window', fresh.length >= 1, `${fresh.length}: ${fresh.slice(0, 5).join(', ')}`);

check('providers shipped', (prov.providers || []).length >= 40, `providers=${(prov.providers || []).length}`);

// console hygiene on the live page
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(4000);
await browser.close();
check('live page console clean', errors.length === 0, errors.slice(0, 3).join(' | '));

const failed = results.filter(r => !r.ok);
console.log(`\nverify_prod_daily: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
