// ── Router ────────────────────────────────────────────────────────────
// Hash history: GitHub Pages has no server rewrites, so #/... URLs are
// the zero-config option. Swap to createWebHistory when a real host with
// SPA fallback exists.

import { createRouter, createWebHashHistory } from 'vue-router';
import OverviewView from '../views/OverviewView.vue';

const routes = [
  { path: '/', name: 'overview', component: OverviewView },
  { path: '/leaderboard', redirect: { name: 'leaderboard', params: { tier: 'all' } } },
  {
    path: '/leaderboard/:tier(all|closed|open)',
    name: 'leaderboard',
    component: () => import('../views/LeaderboardView.vue'),
  },
  { path: '/benchmarks', name: 'benchmarks', component: () => import('../views/BenchmarksView.vue') },
  { path: '/:pathMatch(.*)*', redirect: { name: 'overview' } },
];

export default createRouter({
  history: createWebHashHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) return savedPosition;
    // Only jump to top when switching views, not when flipping tier tabs
    return to.name === from.name ? {} : { top: 0 };
  },
});
