// ── Router ────────────────────────────────────────────────────────────
// Hash history: GitHub Pages has no server rewrites, so #/... URLs are
// the zero-config option. Swap to createWebHistory when a real host with
// SPA fallback exists.
//
// Site map (leaderboard-first):
//   /                     Home = the leaderboard (tier tabs via ?tier=)
//   /benchmarks/:slug?    Per-benchmark explorer (slug deep links)
//   /model/:slug          Per-model score card
//   /providers            Provider & pricing catalog (providers.json)
//   /compare              Side-by-side comparison (?models=slug,slug)
//   /leaderboard/...      Legacy redirects → /?tier=...

import { createRouter, createWebHashHistory } from 'vue-router';
import HomeView from '../views/HomeView.vue';

const routes = [
  { path: '/', name: 'home', component: HomeView },
  { path: '/leaderboard', redirect: { name: 'home' } },
  {
    path: '/leaderboard/:tier(all|closed|open)',
    redirect: (to) => ({ name: 'home', query: { tier: to.params.tier } }),
  },
  {
    path: '/benchmarks/:slug?',
    name: 'benchmarks',
    component: () => import('../views/BenchmarksView.vue'),
  },
  {
    path: '/model/:slug',
    name: 'model',
    component: () => import('../views/ModelDetailView.vue'),
  },
  {
    path: '/providers',
    name: 'providers',
    component: () => import('../views/ProvidersView.vue'),
  },
  {
    path: '/compare',
    name: 'compare',
    component: () => import('../views/CompareView.vue'),
  },
  { path: '/:pathMatch(.*)*', redirect: { name: 'home' } },
];

export default createRouter({
  history: createWebHashHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) return savedPosition;
    // Keep scroll position when flipping tier tabs / search on home,
    // but always land at the top for real view changes.
    if (to.name === 'home' && from.name === 'home') return {};
    return { top: 0 };
  },
});
