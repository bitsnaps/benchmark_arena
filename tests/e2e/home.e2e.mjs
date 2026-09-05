// Home leaderboard e2e: tiers, freshness toggle, CL slider, model pages, explorer.
// Runs under tests/run-e2e.mjs (vite preview on 4173, base /benchmark_arena/).
// Expectations are derived from the committed snapshot, so a data refresh
// cannot silently invalidate the suite.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = path.join(REPO, 'tests', 'e2e', 'shots');
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173/benchmark_arena/';

// Expected #1 per tier + slug helper, computed from the real snapshot.
// Mirrors the site's ranking rule: older releases (superseded versions of
// the same product line + stale generations 9+ months old) are excluded
// from the default ranking and hidden behind the Older-versions toggle.
const data = JSON.parse(fs.readFileSync(path.join(REPO, 'public/benchmark_results.json'), 'utf8'));
const CORE = ['Artificial Analysis','BenchLM.ai','Arena.ai Text','SimpleBench.com','ARC-AGI-2','Design Arena','SWE-Marathon','FrontierSWE'];
const avg = r => { const v = CORE.map(b => r[b]).filter(x => x != null); return v.length ? v.reduce((a,b)=>a+b,0)/v.length : -1; };
// CL-weighted global score (mirrors stores/data.js scoreForModel): w*raw + (1-w)*50
const score = r => { const raw = avg(r); if (raw === -1) return -1; const cl = Math.min(100, Math.max(0, r.cl ?? 0)); return (cl/100)*raw + (1-cl/100)*50; };
const META = data.models_meta || {};
const supOf = name => (META[name] && META[name].superseded_by) || null;
const isOld = r => !!(META[r.name] && (META[r.name].superseded_by || META[r.name].stale));
const topOf = list => [...list].filter(r => !isOld(r)).sort((a,b)=>score(b)-score(a))[0]?.name;
const slugify = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const EXPECT = {
  all: topOf([...(data.unified_closed||[]), ...(data.unified_open||[])]),
  closed: topOf(data.unified_closed||[]),
  open: topOf(data.unified_open||[]),
};
const BENCHES = data.benchmarks || [];
console.log('Expected #1 per tier:', EXPECT);

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

  // ── 1. Home IS the leaderboard ──
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.b-table .table tbody tr', { timeout: 10000 });
  ok('home renders the leaderboard table directly');
  if (await page.locator('.hero-lab').count()) fail('hero/overview page should be gone');
  const navTexts = (await page.locator('.navbar-start a').allInnerTexts()).map(s => s.trim());
  if (navTexts.join(',') !== 'Leaderboard,Benchmarks,Providers') fail('navbar should be [Leaderboard, Benchmarks, Providers], got ' + navTexts);
  else ok('navbar: Leaderboard + Benchmarks + Providers (no Overview)');
  const firstAll = await firstName();
  if (firstAll !== EXPECT.all) fail(`home #1 = "${firstAll}", expected "${EXPECT.all}"`);
  else ok(`home #1 row = ${firstAll} (overall top, All tab default)`);
  if (await page.locator('.home-stats .stat').count() !== 4) fail('stats strip should have 4 tiles');
  else ok('snapshot stats strip present');

  // ── 1b. Older releases (superseded + stale): hidden by default, opacity tiers on rows ──
  const ALLROWS = [...(data.unified_closed || []), ...(data.unified_open || [])];
  const supInTable = ALLROWS.find(r => supOf(r.name));
  const staleInTable = ALLROWS.find(r => META[r.name] && META[r.name].stale && !META[r.name].superseded_by);
  const hasOverride = ALLROWS.some(r => r.name === 'gemini 3 pro');
  if (!supInTable) { console.log('  (skip: no superseded model in this snapshot)'); }
  else {
    if (await page.locator(`.b-table .table tbody tr .model-link:text-is("${supInTable.name}")`).count())
      fail(`superseded model "${supInTable.name}" should be hidden by default`);
    else ok(`superseded model "${supInTable.name}" hidden by default`);
    if (staleInTable) {
      if (await page.locator(`.b-table .table tbody tr .model-link:text-is("${staleInTable.name}")`).count())
        fail(`stale model "${staleInTable.name}" should be hidden by default`);
      else ok(`stale generation "${staleInTable.name}" hidden by default`);
    }
    if (hasOverride) {
      if (await page.locator('.b-table .table tbody tr .model-link:text-is("gemini 3 pro")').count())
        fail('override-flagged "gemini 3 pro" should be hidden by default');
      else ok('override-flagged "gemini 3 pro" hidden by default (Gemini 3.1 Pro unaffected)');
      if (!(await page.locator('.b-table .table tbody tr .model-link:text-is("Gemini 3.1 Pro")').count()))
        fail('"Gemini 3.1 Pro" must stay visible (Pro/Flash lines never cross-hide)');
      else ok('"Gemini 3.1 Pro" still visible while old "gemini 3 pro" hides');
    }
    if (await page.locator('.older-section').count()) fail('older section should not render by default');
    else ok('older section absent by default');
    // opacity tiers are applied
    const dimmed = await page.locator('.b-table .table tbody tr.cov-mid, .b-table .table tbody tr.cov-low, .b-table .table tbody tr.cov-min').count();
    const full = await page.locator('.b-table .table tbody tr.cov-full').count();
    if (!dimmed || !full) fail(`opacity tiers missing (dimmed=${dimmed}, full=${full})`);
    else {
      const op = await page.locator('.b-table .table tbody tr.cov-low, .b-table .table tbody tr.cov-min').first()
        .evaluate(el => getComputedStyle(el).opacity);
      if (parseFloat(op) >= 1) fail(`dimmed row opacity should be < 1, got ${op}`);
      else ok(`coverage opacity tiers render (dimmed=${dimmed}, full=${full}, sample opacity=${op})`);
    }
    // toggle ON → older models interleave INLINE in the main ranked table
    await page.locator('label.switch:has-text("Older versions")').click();
    await page.waitForTimeout(400);
    const expectedOlder = ALLROWS.filter(isOld).length;
    if (await page.locator('.older-section').count())
      fail('separate older section rendered (older models must be inline now)');
    else ok('no separate older section — old models live in the main listing');
    const olderInline = await page.locator('.b-table .table tbody tr.is-older-row').count();
    if (olderInline !== expectedOlder)
      fail(`inline older rows: expected ${expectedOlder}, got ${olderInline}`);
    else ok(`older versions toggle interleaves ${olderInline} dimmed rows inline (superseded + stale)`);
    if (!(await page.locator(`.b-table .table tbody tr.is-older-row .model-link:text-is("${supInTable.name}")`).count()))
      fail(`"${supInTable.name}" should appear inline (dimmed) after toggle`);
    else ok(`"${supInTable.name}" interleaved into the main ranking`);
    if (hasOverride && !(await page.locator('.b-table .table tbody tr.is-older-row .model-link:text-is("gemini 3 pro")').count()))
      fail('override-flagged "gemini 3 pro" should appear inline after toggle');
    else if (hasOverride) ok('"gemini 3 pro" interleaved into the main ranking');
    const oldRank = (await page.locator('.b-table .table tbody tr.is-older-row').first().locator('.rank').innerText()).trim();
    if (oldRank !== '—') fail(`inline older rows should show "—" rank, got "${oldRank}"`);
    else ok('inline older rows carry no rank (excluded from ranking)');
    const oldOp = await page.locator('.b-table .table tbody tr.is-older-row').first()
      .evaluate(el => getComputedStyle(el).opacity);
    if (parseFloat(oldOp) >= 1) fail(`inline older row should be dimmed, got ${oldOp}`);
    else ok(`inline older rows render dimmed (opacity=${oldOp})`);
    if (!(await page.locator('.b-table .table tbody tr.is-older-row .older-chip').count()))
      fail('inline older rows should carry an "older" chip');
    else ok('inline older rows carry the "older" chip');
    // merged table = every model exactly once; top of the table unchanged
    const totalRows = await page.locator('.b-table .table tbody tr').count();
    if (totalRows !== ALLROWS.length)
      fail(`with toggle ON the table should list all ${ALLROWS.length} models, got ${totalRows}`);
    else ok(`toggle ON: single merged table lists all ${totalRows} models`);
    const topAfter = await firstName();
    if (topAfter !== EXPECT.all) fail(`top row after merge = "${topAfter}", expected "${EXPECT.all}"`);
    else ok(`top row unchanged after merge (${topAfter})`);
    await page.screenshot({ path: SHOTS + '/home-older-versions.png' });
    // hide again before navigating on
    await page.locator('label.switch:has-text("Older versions")').click();
    await page.waitForTimeout(300);
    // superseded model page shows the banner + successor link
    await page.goto(BASE + '#/model/' + slugify(supInTable.name), { waitUntil: 'networkidle' });
    await page.waitForSelector('.model-head', { timeout: 10000 });
    if (!(await page.locator('.notice:has-text("superseded by")').count())) fail('superseded banner missing on model page');
    else {
      ok(`superseded banner shown for "${supInTable.name}"`);
      await page.locator('.notice a').click();
      await page.waitForTimeout(600);
      const succ = supOf(supInTable.name);
      if (!page.url().includes('/model/' + slugify(succ))) fail(`successor link should open ${slugify(succ)}, got ${page.url()}`);
      else ok(`banner link opens successor "${succ}"`);
    }
    // override pair: gemini 3 pro page banners and links to Gemini 3.1 Pro
    if (hasOverride) {
      await page.goto(BASE + '#/model/gemini-3-pro', { waitUntil: 'networkidle' });
      await page.waitForSelector('.model-head', { timeout: 10000 });
      if (!(await page.locator('.notice:has-text("superseded by")').count())) fail('gemini 3 pro banner missing');
      else {
        ok('"gemini 3 pro" model page shows superseded banner');
        await page.locator('.notice a').click();
        await page.waitForTimeout(600);
        if (!page.url().includes('/model/gemini-3-1-pro')) fail('gemini 3 pro should link to gemini-3-1-pro, got ' + page.url());
        else ok('override successor link opens "Gemini 3.1 Pro"');
      }
    }
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('.b-table .table tbody tr');
  }

  // ── 1c. Min-CL slider filters thin-coverage rows ──
  {
    const before = await page.locator('.b-table .table tbody tr').count();
    await page.locator('input.cl-slider').evaluate(el => {
      el.value = '50';
      el.dispatchEvent(new Event('input'));
    });
    await page.waitForTimeout(400);
    const after = await page.locator('.b-table .table tbody tr').count();
    if (after >= before) fail(`slider should filter rows (before=${before}, after=${after})`);
    else {
      // every remaining row must have CL >= 50 (CL tag lives in the last column)
      const clTexts = await page.locator('.b-table .table tbody tr td:last-child').allInnerTexts();
      const bad = clTexts.map(t => parseFloat(t)).filter(v => !Number.isNaN(v) && v < 50);
      if (bad.length) fail(`rows below CL 50 still visible: ${bad.join(',')}`);
      else ok(`min-CL slider: ${before} → ${after} rows, all CL ≥ 50%`);
    }
    if (!(await page.locator('text=CL ≥ 50%').count())) fail('slider value tag should read CL ≥ 50%');
    else ok('slider tag reads CL ≥ 50%');
    // reset so tier-tab expectations below are unaffected
    await page.locator('input.cl-slider').evaluate(el => {
      el.value = '0';
      el.dispatchEvent(new Event('input'));
    });
    await page.waitForTimeout(300);
    const reset = await page.locator('.b-table .table tbody tr').count();
    if (reset !== before) fail(`slider reset mismatch (${reset} vs ${before})`);
    else ok('slider reset restores all rows');
  }

  // ── 1d. Avg-set dropdown: user-selectable average + hide/show columns ──
  // Default must stay the shipped 8-core formula. Benchmark COLUMNS follow the
  // selection 1:1: EQBench CW (non-selected) starts with its column hidden
  // entirely; opting in via its checkbox makes the column appear (teal),
  // re-scores (custom badge + ?avg= + persistence), and Reset hides it again.
  // ≥1 benchmark always stays selected.
  {
    const eqbThCount = async () => await page
      .locator('.b-table thead th', { hasText: 'EQB' }).count();
    // anchor the match to a whole class token ("noncore-col" contains "core-col")
    const CORE_RE = /(^|\s)core-col(\s|$)/;
    // buefy re-renders column headers async — poll instead of a fixed wait.
    // wantVisible=true  → wait for an EQB th carrying core-col
    // wantVisible=false → wait for the EQB th to disappear completely
    const pollEqb = async (wantVisible, tries = 12) => {
      for (let i = 0; i < tries; i++) {
        const n = await eqbThCount();
        if (!wantVisible && n === 0) return true;
        if (wantVisible && n > 0) {
          const cls = await page.locator('.b-table thead th', { hasText: 'EQB' })
            .first().getAttribute('class');
          if (CORE_RE.test(cls || '')) return true;
        }
        await page.waitForTimeout(250);
      }
      return false;
    };
    const statSub = page.locator('.home-stats .stat').nth(1).locator('.sub');

    if (!/8 of them counted/.test(await statSub.innerText()))
      fail(`default stats should say "8 of them counted", got "${await statSub.innerText()}"`);
    else ok('default avg set: 8 benchmarks counted in the global Score');
    if (await eqbThCount())
      fail(`EQB column should be hidden while unselected, class="${await page.locator('.b-table thead th', { hasText: 'EQB' }).first().getAttribute('class')}"`);
    else ok('hide/show columns: EQB column hidden by default (not in the avg set)');
    if (page.url().includes('avg=')) fail('default home URL should not carry ?avg=');
    else ok('no ?avg= param by default');
    if (await page.locator('.avg-dropdown .tag:has-text("custom")').count())
      fail('custom badge should be hidden while the default set is active');
    else ok('no custom badge by default');

    // open the dropdown once and keep it open for the whole section — the
    // trigger is a toggle and close-on-click is disabled by design
    await page.locator('.avg-dropdown .avg-trigger').click();
    await page.waitForTimeout(300);
    // checkbox input is opacity:0 — click the visible .b-checkbox label
    const eqbLabel = page.locator('.avg-dropdown .avg-bench-row .b-checkbox', { hasText: 'EQB' });
    const defaultPreset = page.locator('.avg-dropdown .dropdown-item', { hasText: 'Default (8 core)' });
    if (!(await defaultPreset.count()) || !(await eqbLabel.count()))
      fail('avg-set dropdown should list presets and per-benchmark checkboxes');
    else ok('avg-set dropdown lists presets + per-benchmark checkboxes');
    await eqbLabel.click();
    await page.waitForTimeout(500);

    // EQB column APPEARS as counted (teal header); badge + URL param + stats follow
    if (!(await pollEqb(true))) fail('EQB column should appear with core-col after opt-in');
    else ok('EQBench CW opt-in: column appears + counted in the Score');
    if (!(await page.locator('.avg-dropdown .tag:has-text("custom")').count()))
      fail('custom badge missing after opt-in');
    else ok('custom badge visible after opt-in');
    if (!page.url().includes('avg=')) fail('?avg= param missing after custom selection');
    else ok('custom mix synced into the URL (?avg=)');
    if (!/9 of them counted/.test(await statSub.innerText()))
      fail(`stats after opt-in should say "9 of them counted", got "${await statSub.innerText()}"`);
    else ok('stats now count 9 benchmarks in the Score');

    // persistence: reload → selection survives via localStorage (and URL param)
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.b-table .table tbody tr', { timeout: 10000 });
    if (!(await pollEqb(true))) fail('EQB column lost after reload — persistence broken');
    else ok('custom mix persists across reload (localStorage + ?avg=)');

    // reset → shipped formula, param gone (menu re-opened after reload)
    await page.locator('.avg-dropdown .avg-trigger').click();
    await page.waitForTimeout(300);
    await page.locator('.avg-dropdown button:has-text("Reset to default")').click();
    await page.waitForTimeout(500);
    if (page.url().includes('avg=')) fail('?avg= should be gone after reset');
    else ok('reset drops the ?avg= param');
    if (await pollEqb(false)) ok('reset hides the EQB column again (shipped 8-core formula)');
    else fail('EQB column should disappear after reset');

    // ≥1 guard: unchecking everything still leaves exactly one selected (locked)
    const boxes = page.locator('.avg-dropdown .avg-bench-row input[type="checkbox"]');
    const labels = page.locator('.avg-dropdown .avg-bench-row .b-checkbox');
    const nBoxes = await boxes.count();
    for (let i = 0; i < nBoxes; i++) {
      const box = boxes.nth(i);
      if ((await box.isChecked()) && !(await box.isDisabled())) await labels.nth(i).click();
    }
    await page.waitForTimeout(300);
    const checkedLeft = await page.locator('.avg-dropdown .avg-bench-row input[type="checkbox"]:checked').count();
    const lockedLeft = await page.locator('.avg-dropdown .avg-bench-row input[type="checkbox"]:checked:disabled').count();
    if (checkedLeft < 1 || lockedLeft !== 1)
      fail(`≥1 guard failed (${checkedLeft} checked, ${lockedLeft} locked)`);
    else ok('≥1 selection guard holds: last benchmark locks instead of deselecting');
    // clean up: back to default so the sections below see shipped behavior
    await page.locator('.avg-dropdown button:has-text("Reset to default")').click();
    await page.waitForTimeout(400);
    await page.locator('.page-head h1').click(); // outside click closes the dropdown
    await page.waitForTimeout(300);
    if (page.url().includes('avg=')) fail('final cleanup left ?avg= behind');
    else ok('cleanup: default avg set restored, dropdown closed');
  }

  // ── 2. Tier tabs → ?tier= ──
  await page.click('.tier-tabs .tabs li:nth-child(2) a');
  await page.waitForTimeout(400);
  if (!page.url().includes('tier=closed')) fail('closed tab URL, got ' + page.url());
  if ((await firstName()) !== EXPECT.closed) fail('closed #1 mismatch');
  else ok(`closed tab → ?tier=closed, #1 = ${await firstName()}`);
  await page.click('.tier-tabs .tabs li:nth-child(3) a');
  await page.waitForTimeout(400);
  if ((await firstName()) !== EXPECT.open) fail('open #1 mismatch');
  else ok(`open tab → ?tier=open, #1 = ${await firstName()}`);

  // ── 3. Legacy /#/leaderboard/x redirects ──
  await page.goto(BASE + '#/leaderboard/open', { waitUntil: 'networkidle' });
  await page.waitForSelector('.b-table .table tbody tr', { timeout: 10000 });
  if (!page.url().includes('tier=open')) fail('legacy #/leaderboard/open should redirect to ?tier=open, got ' + page.url());
  else ok('legacy #/leaderboard/open → #/?tier=open');
  if (!/Open-weight/i.test(await page.locator('.tier-tabs .tabs li.is-active a').innerText())) fail('redirected page should show Open-weight active');
  else ok('redirect lands on Open-weight tab');

  // ── 4. Search ?q= sync on home (back to All tab first) ──
  await page.click('.tier-tabs .tabs li:nth-child(1) a');
  await page.waitForTimeout(400);
  await page.fill('input.input', 'Claude');
  await page.waitForTimeout(500);
  const rowsQ = await page.locator('.b-table .table tbody tr').count();
  if (!page.url().includes('q=Claude') || rowsQ < 2) fail(`search sync failed (${page.url()}, ${rowsQ} rows)`);
  else ok(`search synced (?q=Claude, ${rowsQ} rows), tier param dropped on All`);
  await page.fill('input.input', '');
  await page.waitForTimeout(400);

  // ── 5. Model page from table row link ──
  await page.click('.tier-tabs .tabs li:nth-child(1) a');
  await page.waitForTimeout(400);
  const linkedName = await firstName();
  await page.locator('.b-table .table tbody tr').first().locator('.model-link').click();
  await page.waitForSelector('.model-head', { timeout: 10000 });
  const heading = (await page.locator('.model-head h1').innerText()).trim();
  if (!page.url().includes('#/model/' + slugify(linkedName)) || heading !== linkedName)
    fail(`model page mismatch (${page.url()} vs ${slugify(linkedName)}, h1=${heading})`);
  else ok(`row link opens #/model/${slugify(linkedName)} ("${heading}")`);
  const bars = await page.locator('.panel-lab a.hbar').count();
  const docTitle = await page.title();
  // expected bar count = number of benchmarks the model actually has scores for
  const rowAll = [...(data.unified_closed || []), ...(data.unified_open || [])]
    .find(r => r.name === linkedName);
  const expectBars = rowAll
    ? (data.benchmarks || []).filter(b => rowAll[b] != null).length : 0;
  if (bars !== expectBars) fail(`model card should list ${expectBars} score bars, got ${bars}`);
  else ok(`model card: ${bars} score bars (matches data), wins tag, title="${docTitle}"`);
  await page.screenshot({ path: SHOTS + '/model-page.png' });

  // bench link inside model card → benchmark explorer
  const firstBenchLink = page.locator('.panel-lab a.hbar').first();
  const benchSlug = await firstBenchLink.getAttribute('href');
  await firstBenchLink.click();
  await page.waitForSelector('.chips .chip', { timeout: 10000 });
  if (!page.url().includes(benchSlug.replace('#', ''))) fail(`bench link → ${page.url()}, expected contains ${benchSlug}`);
  else ok(`model card bench link → #${benchSlug.replace(/^#/, '')}`);
  const activeChip = (await page.locator('.chips .chip.on').first().innerText()).trim();
  ok(`explorer opened with active chip: ${activeChip}`);

  // ── 6. Explorer row → model page (or search fallback for non-pivot models); chips update URL ──
  await page.locator('.hbar.row-click').first().click();
  await page.waitForTimeout(700);
  if (page.url().includes('/model/')) {
    await page.waitForSelector('.model-head', { timeout: 10000 });
    ok('explorer hbar opens model score card');
  } else if (page.url().includes('q=')) {
    ok(`explorer hbar falls back to leaderboard search (${decodeURIComponent(page.url().split('q=')[1])} not in unified pivot)`);
    await page.goBack();
    await page.waitForTimeout(500);
  } else {
    fail('explorer hbar should open model card or search fallback, got ' + page.url());
  }
  await page.goto(BASE + '#/benchmarks', { waitUntil: 'networkidle' });
  await page.waitForSelector('.chips .chip', { timeout: 10000 });
  const arcChip = page.locator('.chips .chip', { hasText: 'ARC-2' }).first();
  await arcChip.click();
  await page.waitForTimeout(400);
  if (!page.url().includes('/benchmarks/arc-agi-2')) fail('ARC chip should deep-link /benchmarks/arc-agi-2, got ' + page.url());
  else ok('chip click deep-links #/benchmarks/arc-agi-2');
  const h2 = (await page.locator('.grid-2 h2').innerText()).trim();
  if (h2 !== 'ARC-AGI-2') fail('active bench should be ARC-AGI-2, got ' + h2);
  else ok('explorer shows ARC-AGI-2 content');

  // ── 6b. Explorer hides older releases too (Design Arena has 6) ──
  {
    const olderInBench = ['Claude Fable 5', 'Gemini 3.7 Flash', 'Muse Spark 1.2'];
    await page.locator('.chips .chip', { hasText: 'Design' }).first().click();
    await page.waitForTimeout(400);
    if (!page.url().includes('/benchmarks/design-arena')) fail('Design chip should deep-link, got ' + page.url());
    // shared toggle state must be OFF here (section 1b turned it back off)
    const switchLoc = page.locator('.panel-lab label.switch', { hasText: 'Older versions' });
    const wasOn = await switchLoc.locator('input').isChecked();
    if (wasOn) { await switchLoc.click(); await page.waitForTimeout(300); }
    for (const name of olderInBench) {
      if (await page.locator(`.hbar .name:text-is("${name}")`).count())
        fail(`explorer should hide older "${name}" by default`);
    }
    const visCount = await page.locator('.hbar').count();
    ok(`explorer default ranking has ${visCount} rows, no older releases`);
    // toggle on → older rows appear dimmed, without a rank number
    await switchLoc.click();
    await page.waitForTimeout(400);
    const olderBar = page.locator('.hbar.is-older-row', { hasText: 'Claude Fable 5' });
    if (!(await olderBar.count())) fail('older rows should render in explorer when toggled on');
    else {
      const dimOpacity = await olderBar.first().evaluate(el => getComputedStyle(el).opacity);
      if (parseFloat(dimOpacity) >= 1) fail(`explorer older row should be dimmed, got ${dimOpacity}`);
      else ok(`explorer older rows render dimmed (opacity=${dimOpacity})`);
      const barRank = (await olderBar.first().locator('.rank').innerText()).trim();
      if (barRank !== '—') fail(`explorer older row rank should be "—", got "${barRank}"`);
      else ok('explorer older rows carry no rank');
    }
    await page.screenshot({ path: SHOTS + '/bench-older-versions.png' });
    // top-3 glance never includes older models (endsWith avoids prefix
    // false-positives like "Claude Fable 5.1" matching "Claude Fable 5")
    const glanceLines = (await page.locator('.grid-2 .kv .k').allInnerTexts())
      .map(t => t.trim());
    for (const name of olderInBench) {
      if (glanceLines.some(line => line.endsWith(name))) fail(`top-3 glance should not include older "${name}"`);
    }
    ok('top-3 glance uses current-generation models only');
    await switchLoc.click(); // off again
    await page.waitForTimeout(300);
  }

  // ── 7. Direct deep links: model + unknown slug ──
  await page.goto(BASE + '#/model/' + slugify(EXPECT.open), { waitUntil: 'networkidle' });
  await page.waitForSelector('.model-head', { timeout: 10000 });
  if (((await page.locator('.model-head h1').innerText()).trim()) !== EXPECT.open) fail('deep-linked model page mismatch');
  else ok(`deep link #/model/${slugify(EXPECT.open)} renders "${EXPECT.open}"`);
  await page.goto(BASE + '#/model/does-not-exist', { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Model not found', { timeout: 10000 });
  ok('unknown model slug shows friendly not-found');
  await page.screenshot({ path: SHOTS + '/model-404.png' });

  // ── 8. Compare flow on home + full comparison page ──
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.b-table .table tbody tr');
  await page.locator('label.switch:has-text("Compare")').click();
  await page.locator('.b-table .table tbody tr .b-checkbox input').nth(0).click({ force: true });
  await page.locator('.b-table .table tbody tr .b-checkbox input').nth(1).click({ force: true });
  await page.waitForTimeout(300);
  if (!await page.locator('text=Side by side').count()) fail('compare panel missing');
  else ok('compare panel works on home');
  if (!await page.locator('button:has-text("Full comparison")').count()) fail('panel should offer Full comparison CTA');
  else ok('compare panel offers "Full comparison" CTA');
  // model page "Add to compare" CTA (pick a model NOT already checked)
  await page.locator('.b-table .table tbody tr').nth(3).locator('.model-link').click();
  await page.waitForSelector('.model-head');
  const btnLabel = (await page.locator('.model-head button').innerText()).trim();
  if (!/Add to compare/.test(btnLabel)) fail(`expected enabled CTA, got "${btnLabel}"`);
  await page.click('.model-head button');
  await page.waitForSelector('.cmp-headcell', { timeout: 10000 });
  if (!page.url().includes('/compare')) fail('compare CTA should land on #/compare, got ' + page.url());
  const cmpCols = await page.locator('.cmp-headcell').count();
  if (cmpCols !== 3) fail(`full comparison should show 3 columns, got ${cmpCols}`);
  else ok('model page "Add to compare" → full comparison page with 3 columns');
  await page.screenshot({ path: SHOTS + '/home-compare.png' });

  // ── 9. Category leaders → model pages ──
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.model-tile h3', { timeout: 10000 });
  const cardModel = (await page.locator('.model-tile h3').first().innerText()).trim();
  await page.locator('.model-tile').first().click();
  await page.waitForSelector('.model-head', { timeout: 10000 });
  if (((await page.locator('.model-head h1').innerText()).trim()) !== cardModel) fail('leader card should open its model page');
  else ok(`leader card → model page of "${cardModel}"`);

  // ── 10. Screenshots + mobile ──
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.b-table .table tbody tr');
  await page.screenshot({ path: SHOTS + '/home-desktop.png' });
  const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mob.on('pageerror', e => errors.push('mobile pageerror: ' + e.message));
  await mob.goto(BASE, { waitUntil: 'networkidle' });
  await mob.waitForSelector('.b-table .table tbody tr', { timeout: 10000 });
  await mob.screenshot({ path: SHOTS + '/home-mobile.png' });
  await mob.goto(BASE + '#/model/' + slugify(EXPECT.all), { waitUntil: 'networkidle' });
  await mob.waitForSelector('.model-head', { timeout: 10000 });
  await mob.screenshot({ path: SHOTS + '/model-mobile.png' });
  ok('mobile screenshots taken');

  if (errors.length) fail('page errors: ' + errors.join(' | '));
  else ok('zero console/page errors');

  await browser.close();
  console.log(process.exitCode ? 'SMOKE TEST FAILED' : 'SMOKE TEST PASSED');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
