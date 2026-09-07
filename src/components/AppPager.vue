<script setup>
// stats-21: THE pager. One design for every table in the app — Buefy's
// b-pagination pinned to the bottom-right with the page numbers sitting
// between the previous/next arrows, plus (when the surface owns the choice)
// the shared "rows per page" control from lib/pager.js. The page size is a
// single app-wide setting: changing it on any table changes it everywhere,
// so the number of pages never surprises.
import { computed, watch } from 'vue';
import { usePageSize, PAGE_ALL, clampPage } from '../lib/pager.js';

const props = defineProps({
  total: { type: Number, required: true },
  // Surfaces that inherit the app-wide size instead of owning it
  // (per-provider cards) hide the select; one control per view.
  showSize: { type: Boolean, default: true },
  ariaLabel: { type: String, default: 'Pagination' },
});
const page = defineModel('page', { type: Number, default: 1 });

const pageSize = usePageSize();
// Slice the same way b-table does on the leaderboard (0 = All → one page)
const perPage = computed(() => (pageSize.value === PAGE_ALL
  ? Math.max(props.total, 1) : pageSize.value));
const totalPages = computed(() => Math.max(1, Math.ceil(props.total / perPage.value)));

// A new size restarts the table at page 1; a shrinking result set never
// strands the pointer past the last page.
watch(pageSize, () => { page.value = 1; });
watch(totalPages, (t) => { page.value = clampPage(page.value, t); });
</script>

<template>
  <div class="app-pager" role="navigation" :aria-label="ariaLabel">
    <div v-if="showSize" class="page-size pg-size">
      <span class="cell-sub">rows per page</span>
      <b-select v-model.number="pageSize" size="is-small" aria-label="rows per page">
        <option :value="20">20</option>
        <option :value="50">50</option>
        <option :value="100">100</option>
        <option :value="0">All</option>
      </b-select>
    </div>
    <b-pagination
      v-if="totalPages > 1"
      v-model="page"
      :total="total"
      :per-page="perPage"
      size="is-small"
      :range-before="2"
      :range-after="2"
      aria-next-label="Next page"
      aria-previous-label="Previous page"
      aria-page-label="Page"
      aria-current-label="Current page"
    />
  </div>
</template>

<style>
/* One pager, bottom-right, arrows flanking the numbered pages — identical
   Buefy markup on every surface, only realigned here. */
.app-pager {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: .35rem .75rem;
  flex-wrap: wrap;
  margin-top: .45rem;
}
.app-pager .pg-size {
  display: flex;
  align-items: center;
  gap: .45rem;
}
.app-pager nav.pagination {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  flex-wrap: wrap;
  gap: .2rem;
  margin: 0;
}
/* DOM order is previous → next → list; visual order is previous → pages → next */
.app-pager .pagination-previous { order: 0; margin: 0; }
.app-pager .pagination-list { order: 1; flex-grow: 0; margin: 0; }
.app-pager .pagination-next { order: 2; margin: 0; }
/* reserved for b-pagination's optional jump-to-page input — unused here */
.app-pager .pagination-input { display: none; }
</style>
