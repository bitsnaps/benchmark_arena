// ── stats-92: creator-reported benchmarks on the Side-by-side page ─────
// Groups the vendor lane (baked ONLY on card_models rows by
// bake_vendor_scores.py — the leak detector forbids a ranked row carrying
// vendor_scores) across the models the user picked for comparison.
//
// Rows are keyed by the VERBATIM benchmark string — no aliasing, no
// normalization ('SWE-bench Pro' and 'SWE-Bench Pro' stay separate rows,
// exactly as the creators wrote them). Any normalization would be an
// editorial claim that two creators measured the same harness, which the
// stats-91 contract refuses.
//
// Red lines (stats-91, extended to the compare grid):
//   · these numbers are CLAIMS — self-reported by creators, never
//     measured by us;
//   · they never feed the Score/rank/avg-set math (they can't — the
//     helper returns plain display rows);
//   · NO winner highlighting: the compare grid's teal "best of selection"
//     marks measured cells only, so creator rows render without the
//     comparable-row treatment.
//
// Never throws: malformed entries degrade to skipped rows.

// vendorCompareGroups(rows, vendorScoresFor?) →
//   [{ benchmark, entries: [{ model, score, qualifier, source }], models }]
// sorted by (number of reporting models DESC, benchmark name ASC) — the
// benchmarks several selected models share (the actually comparable rows)
// surface first.
export function vendorCompareGroups(rows, vendorScoresFor) {
  const list = Array.isArray(rows) ? rows.filter(r => r && r.name) : [];
  const read = typeof vendorScoresFor === 'function'
    ? vendorScoresFor
    : (r) => (Array.isArray(r?.vendor_scores) ? r.vendor_scores : []);
  const byName = new Map();
  for (const row of list) {
    for (const v of read(row)) {
      const name = String(v?.benchmark ?? '').trim();
      const score = Number(v?.score);
      if (!name || !Number.isFinite(score)) continue;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push({
        model: row.name,
        score,
        qualifier: String(v?.qualifier || 'reported'),
        source: String(v?.source || ''),
      });
    }
  }
  return [...byName.entries()]
    .map(([benchmark, entries]) => ({ benchmark, entries, models: entries.length }))
    .sort((a, b) => b.models - a.models || a.benchmark.localeCompare(b.benchmark));
}
