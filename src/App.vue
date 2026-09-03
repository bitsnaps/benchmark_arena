<script setup>
// App shell — navbar, router outlet, footer. All data lives in the
// shared store (src/stores/data.js), fetched once for every view.
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useData } from './stores/data.js';
import { useLeaderboard } from './stores/leaderboard.js';

const route = useRoute();
const router = useRouter();
const { loading, error, stats, ensureLoaded } = useData();
const { compareMode, compareRows } = useLeaderboard();

const menuOpen = ref(false);

onMounted(ensureLoaded);

function goCompare() {
  compareMode.value = true;
  router.push({ name: 'leaderboard', params: { tier: 'all' } });
}
</script>

<template>
  <div>
    <b-loading :model-value="loading" :is-full-page="true" />

    <!-- ── Navbar ─────────────────────────────────────────────── -->
    <nav class="navbar is-fixed-top lab-nav" role="navigation" aria-label="main navigation">
      <div class="wrap" style="display:flex;width:min(1240px,calc(100% - 2rem));">
        <div class="navbar-brand">
          <router-link class="navbar-item" :to="{ name: 'overview' }">
            <span class="brand-mark"><i class="fas fa-ranking-star"></i></span>
            <span class="brand-word">Benchmark <span>Arena</span></span>
          </router-link>
          <a role="button" class="navbar-burger" :class="{ 'is-active': menuOpen }" aria-label="menu"
            :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">
            <span aria-hidden="true"></span><span aria-hidden="true"></span><span aria-hidden="true"></span>
          </a>
        </div>
        <div class="navbar-menu" :class="{ 'is-active': menuOpen }">
          <div class="navbar-start">
            <router-link class="navbar-item" :class="{ 'is-active': route.name === 'overview' }"
              :to="{ name: 'overview' }" @click="menuOpen = false">Overview</router-link>
            <router-link class="navbar-item" :class="{ 'is-active': route.name === 'leaderboard' }"
              :to="{ name: 'leaderboard', params: { tier: 'all' } }" @click="menuOpen = false">Leaderboard</router-link>
            <router-link class="navbar-item" :class="{ 'is-active': route.name === 'benchmarks' }"
              :to="{ name: 'benchmarks' }" @click="menuOpen = false">Benchmarks</router-link>
          </div>
          <div class="navbar-end">
            <a class="navbar-item compare-pill" @click="goCompare">
              <i class="fas fa-code-compare"></i>&nbsp; Compare ({{ compareRows.length }})
            </a>
          </div>
        </div>
      </div>
    </nav>

    <main class="shell">
      <div class="wrap">
        <!-- Error -->
        <b-message v-if="error" type="is-danger" has-icon icon="triangle-exclamation" title="Error">
          {{ error }}
        </b-message>

        <router-view v-else-if="!loading" />

        <!-- Footer -->
        <footer class="footer-lab mt">
          <div class="row" style="justify-content:space-between">
            <span>Benchmark Arena · Vue 3 + Buefy/Bulma · snapshot {{ stats.lastUpdated }}</span>
            <span>Data from {{ stats.totalBenchmarks }} public leaderboards · not an official ranking</span>
          </div>
        </footer>
      </div>
    </main>
  </div>
</template>
