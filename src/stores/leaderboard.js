// ── Leaderboard UI store (module-level singleton) ─────────────────────
// Cross-view state: search filter + side-by-side compare selection.

import { ref, watch } from 'vue';

const searchQuery = ref('');
const compareMode = ref(false);
const compareRows = ref([]);

// Leaving compare mode resets the selection
watch(compareMode, (on) => {
  if (!on) compareRows.value = [];
});

const isSameModel = (a, b) => a.name === b.name;

// Cap side-by-side at 5 models
const canCheck = (row) =>
  compareRows.value.some(r => r.name === row.name) || compareRows.value.length < 5;

const clearCompare = () => { compareRows.value = []; };

// Teal highlight for the best score per benchmark among compared rows
const isBest = (bench, row) => {
  if (row[bench] === null || row[bench] === undefined) return false;
  const max = Math.max(...compareRows.value.map(r => r[bench] ?? -1));
  return max > 0 && row[bench] === max;
};

export function useLeaderboard() {
  return { searchQuery, compareMode, compareRows, isSameModel, canCheck, clearCompare, isBest };
}
