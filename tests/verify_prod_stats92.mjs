// verify_prod_stats92.mjs — live verification of the stats-92 Side-by-side
// upgrade on the deployed Pages site:
//   · creator-reported benchmarks render in their own compare group
//     (qualifier cells, self-reported disclaimer, NO winner highlighting)
//   · census columns (OR-only cards + unranked) compare honestly — dash
//     Global Score, census chip, no crown, no ghost prior-blend rating
//   · the compare picker now searches the OR-only census
//   · ranked columns keep their real blend score (regression guard)
// Expectations derive from the DEPLOYED doc, not the local snapshot, so
// this script stays valid across daily refreshes.
// Run after deploy: node tests/verify_prod_stats92.mjs (repo root).
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
const errors = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

const doc = await (await fetch(BASE + 'benchmark_results.json')).json();
const CARDS = doc.card_models || [];
const VENDOR = CARDS.filter(r => Array.isArray(r.vendor_scores) && r.vendor_scores.length);
const slugify = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
// exact slug map (mirrors modelSlugs: ranked universe first, then cards)
const slugMap = new Map();
{
  const used = new Set();
  const assign = (name) => {
    let s = slugify(name); const base = s; let n = 2;
    while (used.has(s)) s = `${base}-${n++}`;
    used.add(s); slugMap.set(name, s);
  };
  for (const r of [...(doc.unified_closed || []), ...(doc.unified_open || [])]) assign(r.name);
  for (const r of CARDS) if (!slugMap.has(r.name)) assign(r.name);
}
const fs1 = (v) => (v === null || v === undefined ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(1));

try {
  check('deployed doc: >=2 census models carry creator scores', VENDOR.length >= 2,
    `vendor models=${VENDOR.length}`);

  // ── 1. Creator-reported pair side by side ──
  const longcat = VENDOR.find(r => /longcat/i.test(r.name)) || VENDOR[0];
  const mate = VENDOR.find(r => r.name !== longcat.name
    && r.vendor_scores.some(v => longcat.vendor_scores.some(w => w.benchmark === v.benchmark)));
  const pair = [longcat, mate].filter(Boolean);
  const shared = mate
    ? longcat.vendor_scores.filter(w => mate.vendor_scores.some(v => v.benchmark === w.benchmark)).map(w => w.benchmark)
    : [];
  await page.goto(BASE + '#/compare?models=' + pair.map(r => slugMap.get(r.name)).join(','),
    { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('.cmp-headcell', { timeout: 45000 });
  await page.waitForTimeout(1500); // router/hydration settle
  await page.screenshot({ path: SHOTS + '/stats92-vendor-pair.png', fullPage: false });

  const headNums = await page.locator('.cmp-headcell .num').allInnerTexts();
  check('census columns show honest dash Global Score',
    headNums.length === pair.length && headNums.every(t => t.trim() === '—'),
    JSON.stringify(headNums));
  const muted = await page.locator('.cmp-headcell .tag-lab.muted').count();
  check('census columns carry the OR-only chip', muted === pair.length, `chips=${muted}`);

  const vendorLabel = page.locator('.cmp-group', { hasText: 'Creator-reported benchmarks' });
  check('Creator-reported benchmarks group renders', (await vendorLabel.count()) === 1);
  if ((await vendorLabel.count()) === 1) {
    check('group hint carries the self-reported disclaimer',
      /not measured by us/i.test(await vendorLabel.innerText()));
  }
  const winnersAfterVendor = await page.evaluate(() => {
    const kids = [...document.querySelectorAll('.cmp-grid > *')];
    const vi = kids.findIndex(k => k.classList.contains('cmp-group') && /creator-reported/i.test(k.textContent));
    if (vi < 0) return -1;
    return kids.slice(vi + 1).filter(k => k.classList.contains('winner-cell')).length;
  });
  check('no winner highlighting in the creator-reported group', winnersAfterVendor === 0,
    `teal cells=${winnersAfterVendor}`);
  const vRowCount = await page.evaluate(() => {
    const kids = [...document.querySelectorAll('.cmp-grid > *')];
    const vi = kids.findIndex(k => k.classList.contains('cmp-group') && /creator-reported/i.test(k.textContent));
    return kids.slice(vi + 1).filter(k => k.classList.contains('cmp-label')).length;
  });
  check('creator rows exist for the pair', vRowCount >= Math.max(pair.length, shared.length),
    `rows=${vRowCount} shared=${shared.length}`);

  if (shared.length) {
    const cells = await page.evaluate((b) => {
      const kids = [...document.querySelectorAll('.cmp-grid > *')];
      const i = kids.findIndex(k => k.classList.contains('cmp-label')
        && k.querySelector('span')?.textContent.trim() === b);
      if (i < 0) return null;
      const out = [];
      for (let j = i + 1; j < kids.length && !kids[j].classList.contains('cmp-label')
        && !kids[j].classList.contains('cmp-group'); j++) out.push(kids[j].textContent.trim());
      return out;
    }, shared[0]);
    const want = pair.map(r => fs1(r.vendor_scores.find(v => v.benchmark === shared[0]).score));
    check(`shared benchmark "${shared[0]}" compares both creators with qualifiers`,
      Array.isArray(cells) && cells.length === pair.length
      && want.every((w, i) => cells[i]?.includes(w))
      && cells.every(c => /in-house|cited|reported/.test(c)),
      `want=${JSON.stringify(want)} got=${JSON.stringify(cells)}`);
  }
  const footTxt = await page.locator('section').innerText();
  check('footnote disclaimer present', /not measured by us/.test(footTxt));

  // ── 2. Picker search surfaces the census ──
  await page.goto(BASE + '#/compare', { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('.cmp-headcell', { timeout: 45000 }); // pair still selected
  await page.click('.cmp-toolbar button:has-text("Clear all")');
  await page.waitForSelector('.panel-lab .chip', { timeout: 45000 });
  await page.fill('.panel-lab input', longcat.name.split(' ').slice(0, 2).join(' '));
  await page.waitForTimeout(800);
  const optText = await page.locator('.dropdown-item', { hasText: longcat.name })
    .first().innerText().catch(() => '');
  check('picker search surfaces census models with creator-score status',
    /creator scores/.test(optText), optText.replace(/\s+/g, ' ').slice(0, 80));

  // ── 3. Unranked honesty + ranked regression ──
  const unranked = [...(doc.unified_closed || []), ...(doc.unified_open || [])]
    .find(r => r.unranked && (r['Artificial Analysis'] != null));
  const ranked = [...(doc.unified_closed || []), ...(doc.unified_open || [])]
    .find(r => !r.unranked && !r.card && (r['Artificial Analysis'] != null));
  if (unranked && ranked) {
    await page.goto(BASE + '#/compare?models=' + slugMap.get(ranked.name) + ',' + slugMap.get(unranked.name),
      { waitUntil: 'load', timeout: 60000 });
    await page.waitForSelector('.cmp-headcell', { timeout: 45000 });
    await page.waitForTimeout(1500);
    const probe = await page.evaluate(([unName, rkName]) => {
      const cols = [...document.querySelectorAll('.cmp-headcell')];
      const un = cols.find(c => c.textContent.includes(unName));
      const rk = cols.find(c => c.textContent.includes(rkName));
      const kids = [...document.querySelectorAll('.cmp-grid > *')];
      const vi = kids.findIndex(k => k.classList.contains('cmp-label') && /Score per/.test(k.textContent));
      const unIdx = un ? cols.findIndex(c => c === un) : -1;
      return {
        unNum: un?.querySelector('.num')?.textContent.trim(),
        unChip: un?.textContent.includes('unranked'),
        unCrown: un ? /wins/.test(un.textContent) : null,
        unValue: vi >= 0 && unIdx >= 0 ? kids[vi + 1 + unIdx]?.textContent.trim() : null,
        rkNum: rk?.querySelector('.num')?.textContent.trim(),
        vendorHidden: !kids.some(k => k.classList.contains('cmp-group') && /creator-reported/i.test(k.textContent)),
      };
    }, [unranked.name, ranked.name]);
    check('unranked Global Score is an honest dash', probe.unNum === '—', `got=${probe.unNum}`);
    check('unranked column carries the unranked chip', probe.unChip === true);
    check('unranked column never carries a wins crown', probe.unCrown === false);
    check('unranked Value is an honest dash', probe.unValue === null || probe.unValue.includes('—'),
      `got=${probe.unValue}`);
    check('creator group stays hidden without vendor models', probe.vendorHidden === true);
    check('ranked column keeps a real blend score', !!probe.rkNum && probe.rkNum !== '—',
      `got=${probe.rkNum}`);
    await page.screenshot({ path: SHOTS + '/stats92-unranked-honesty.png', fullPage: false });
  } else {
    check('unranked/ranked probe rows found in deployed doc', false, 'probe rows missing');
  }

  check('zero console/page errors', errors.length === 0, errors.join(' | ').slice(0, 200));
} catch (e) {
  check('script completed without exception', false, String(e).slice(0, 300));
}

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\nverify_prod_stats92: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
