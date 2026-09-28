// ── stats-52: Compare picker chip-row collapse ────────────────────────
// The pure partition behind the "top N + More..." display (Ibrahim: the
// 65-chip picker row crowded the pivot — "display the top 6 tags of them
// with one extra to More...").
//
// Rule (per cluster): a SELECTED chip is a live column — it always keeps
// its seat and must stay toggleable without expanding. The remaining seats
// (up to the floor) go to the biggest unselected chips by weight (catalog
// listing count; ties keep registry order — Array.sort is stable). The
// visible set always renders in the ORIGINAL list order, so toggling a
// chip never makes the row jump. Expansion is session-only: the persisted
// state is the selection, not the cosmetics.
//
// Never throws: malformed inputs degrade to "show nothing / show all
// selected", never a crashed picker.
export const CHIP_FLOOR = 6;

// pickVisibleChips(chips, selectedSet, floor?, weight?) → visible subset
//   chips       — array of { id, ... } (order = registry order)
//   selectedSet — Set of ids (or any iterable); selected chips always win
//   floor       — minimum visible chips when selection is sparse (default 6)
//   weight      — chip weight accessor (default c.n) for the pad ranking
export function pickVisibleChips(chips, selectedSet, floor = CHIP_FLOOR, weight = (c) => c.n) {
  const list = Array.isArray(chips) ? chips.filter(c => c && c.id != null) : [];
  const sel = selectedSet instanceof Set ? selectedSet : new Set(selectedSet || []);
  const cap = Number.isFinite(floor) && floor >= 0 ? Math.floor(floor) : CHIP_FLOOR;
  const selected = list.filter(c => sel.has(c.id));
  if (selected.length >= cap) return selected; // selected fill every seat
  const padded = list
    .filter(c => !sel.has(c.id))
    .sort((a, b) => (Number(weight(b)) || 0) - (Number(weight(a)) || 0))
    .slice(0, cap - selected.length);
  const vis = new Set([...selected, ...padded].map(c => c.id));
  return list.filter(c => vis.has(c.id)); // registry order, always
}
