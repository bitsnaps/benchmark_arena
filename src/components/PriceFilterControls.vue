<script setup>
// stats-23: the pricing filter as ONE reusable widget — the "free only"
// switch + the max-price slider + its live label. Every Providers tab
// mounts this same component and every instance binds the SAME shared
// state (lib/priceFilter.js — the pager.js singleton pattern), so the
// tabs can never disagree: toggle it on either tab and both follow.
// Free ≠ unlimited — the tooltips carry the rate-limit caveat.
import { usePriceFilter } from '../lib/priceFilter.js';

const { freeOnly, sliderVal, maxPriceLabel } = usePriceFilter();
</script>

<template>
  <!-- stats-26: control hints as Buefy tooltips (same recipe everywhere) -->
  <b-tooltip label="Keep only models with a free listing — free ≠ unlimited, rate limits apply"
    type="is-dark" multilined :delay="100">
    <b-switch v-model="freeOnly" size="is-small">free only</b-switch>
  </b-tooltip>
  <span class="cell-sub" style="margin-left:.4rem">max price</span>
  <b-tooltip label="Cap the blended API price (3:1 in:out, USD per 1M tokens). Free listings count as $0; unpriced listings hide while the cap is on."
    type="is-dark" multilined :delay="100">
    <b-slider v-model="sliderVal" :min="0" :max="100" :step="1" size="is-small"
      :tooltip="false" aria-label="maximum blended price per 1M tokens" style="max-width:240px" />
  </b-tooltip>
  <span class="cell-sub pm-price-label">{{ maxPriceLabel }}</span>
</template>
