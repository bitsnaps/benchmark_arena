<script setup>
// stats-27: the "New badge" window selector — ONE control bound to the
// lib/newFlag.js singleton, mounted on the home toolbar and on both
// Providers tabs, so every surface flags (and re-flags) models with the
// SAME window and the tabs can never disagree. The choice persists per
// device (localStorage, same convention as the collapsible sections).
import { computed } from 'vue';
import { newWindowDays, setNewWindowDays, NEW_WINDOW_CHOICES, NEW_WINDOW_HINT } from '../lib/newFlag.js';

const win = computed({
  get: () => newWindowDays.value,
  set: (v) => setNewWindowDays(v),
});
</script>

<template>
  <!-- stats-26 discipline: control hints as Buefy tooltips -->
  <b-tooltip :label="NEW_WINDOW_HINT" type="is-dark" multilined :delay="100">
    <div class="row" style="gap:.4rem;align-items:center">
      <span class="cell-sub" style="white-space:nowrap">New badge</span>
      <b-select v-model.number="win" size="is-small" aria-label="How recent a release must be to show the NEW badge">
        <option v-for="d in NEW_WINDOW_CHOICES" :key="d" :value="d">{{ d }} days</option>
      </b-select>
    </div>
  </b-tooltip>
</template>
