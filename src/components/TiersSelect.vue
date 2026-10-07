<script setup>
// stats-60: the "Tiers" control — ONE modal bound to the lib/tiers.js
// singleton (the NewWindowSelect / newWindowDays pattern), mounted on the
// home toolbar so every surface (leaderboard chips, Compare rows, model
// cards) shows and switches the SAME mode. Default = Overall grade; the
// choice persists per device (localStorage) and syncs with ?tiers= (the
// URL wiring lives in HomeView, next to the ?avg= watches).
import { ref, computed } from 'vue';
import { tiersMode, setTiersMode, TIERS_MODES, TIERS_MODE_DEFAULT, TIERS_METHOD_NOTE } from '../lib/tiers.js';

const modalOpen = ref(false);
const currentLabel = computed(() =>
  TIERS_MODES.find(m => m.id === tiersMode.value)?.label ?? 'Overall grade');
const isCustom = computed(() => tiersMode.value !== TIERS_MODE_DEFAULT);

function choose(id) {
  setTiersMode(id);
}
</script>

<template>
  <!-- stats-26 discipline: control hints as Buefy tooltips -->
  <b-tooltip label="Group models into S/A/B/C/D grades for quick decisions — optional, default Overall grade. Open to switch to per-axis grades (Quality · Value · Speed) or turn tiers off."
    type="is-dark" multilined :delay="100">
    <button class="button is-small tiers-trigger" type="button"
      :class="isCustom ? 'is-warning' : 'is-dark is-light'"
      aria-label="Choose how model tiers are shown"
      @click="modalOpen = true">
      <i class="fas fa-layer-group"></i>
      <span style="margin-left:.5rem">Tiers · {{ currentLabel }}</span>
      <b-tag v-if="isCustom" type="is-warning" size="is-small" rounded class="ml-2">custom</b-tag>
    </button>
  </b-tooltip>

  <b-modal v-model="modalOpen" :width="560" aria-role="dialog" aria-label="Model tiers settings">
    <div class="panel-lab tiers-modal">
      <h3 class="mp-title" style="margin:0 0 .35rem">Model tiers</h3>
      <p class="cell-sub" style="margin:0 0 .9rem">
        Optional grouping for quick decisions — exact scores stay on every surface either way.
      </p>

      <div
        v-for="m in TIERS_MODES"
        :key="m.id"
        class="tiers-option"
        :class="{ 'is-active': tiersMode === m.id }"
        role="radio"
        :aria-checked="tiersMode === m.id"
        tabindex="0"
        @click="choose(m.id)"
        @keydown.enter.prevent="choose(m.id)"
        @keydown.space.prevent="choose(m.id)"
      >
        <i class="fas" :class="tiersMode === m.id ? 'fa-circle-dot' : 'fa-circle-notch'"></i>
        <div>
          <div class="tiers-option-label">{{ m.label }}</div>
          <div class="cell-sub">{{ m.desc }}</div>
        </div>
      </div>

      <p class="cell-sub tiers-method" style="margin:.9rem 0 0">{{ TIERS_METHOD_NOTE }}</p>

      <div class="row mt-sm" style="justify-content:flex-end">
        <button class="button is-small" type="button" @click="modalOpen = false">Done</button>
      </div>
    </div>
  </b-modal>
</template>

<style scoped>
.tiers-trigger { white-space: nowrap; }
.tiers-modal { padding: 1.1rem 1.2rem; }
.tiers-option {
  display: flex; gap: .7rem; align-items: flex-start;
  padding: .6rem .7rem; border: 1px solid var(--line, #2a2f3a);
  border-radius: 10px; cursor: pointer; margin-bottom: .5rem;
}
.tiers-option:hover { border-color: var(--teal, #2dd4bf); }
.tiers-option.is-active {
  border-color: var(--teal, #2dd4bf);
  background: color-mix(in srgb, var(--teal, #2dd4bf) 8%, transparent);
}
.tiers-option i { margin-top: .2rem; color: var(--teal, #2dd4bf); }
.tiers-option-label { font-weight: 600; font-size: .92rem; }
.tiers-method { border-top: 1px solid var(--line, #2a2f3a); padding-top: .7rem; }
</style>
