// ── Sorter factory for sortable compare tables (stats-55) ─────────────
// The side-by-side panel (ComparePanel.vue) sorts models by Score and by
// each benchmark cell. Buefy's default comparator (and plain JS `>` on
// mixed null/number) treats missing values incoherently: on a DESCENDING
// sort a null cell floats to the TOP — "no data" would beat every score.
//
// House null-policy, identical to PivotTable's byScore/byPrice/byValue:
// a cell with no value NEVER wins a sort — it sinks to the bottom in BOTH
// directions, and two missing cells stay tied (stable sort keeps their
// relative order). Pure function so it is unit-testable without a mount.
export function sinkLast(get) {
  return (a, b, isAsc) => {
    const av = get(a);
    const bv = get(b);
    const aOk = av !== null && av !== undefined;
    const bOk = bv !== null && bv !== undefined;
    if (!aOk && !bOk) return 0;
    if (!aOk) return 1;  // a has no value → a always sorts after b
    if (!bOk) return -1; // b has no value → b always sorts after a
    if (av === bv) return 0;
    return isAsc ? av - bv : bv - av;
  };
}
