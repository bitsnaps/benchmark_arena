// ── Pure formatting / display helpers ─────────────────────────────────

import { PROVIDER_MATCHERS } from './constants.js';

export function fmtScore(val) {
  if (val === null || val === undefined) return '—';
  return Number.isInteger(val) ? String(val) : val.toFixed(1);
}

export function scoreColor(val) {
  if (val === null || val === undefined) return 'var(--faint)';
  if (val >= 80) return 'var(--teal)';
  if (val >= 60) return 'var(--indigo)';
  if (val >= 40) return 'var(--gold)';
  return 'var(--rose)';
}

export function barWidth(val) {
  if (val === null || val === undefined) return '0%';
  return Math.min(100, Math.max(0, val)) + '%';
}

// Buefy tag type for the Coverage Level column
export function clTag(cl) {
  if (cl === null || cl === undefined) return 'is-dark is-light';
  if (cl >= 100) return 'is-success';
  if (cl >= 62.5) return 'is-success is-light';
  if (cl >= 37.5) return 'is-warning is-light';
  return 'is-danger is-light';
}

// Gold / silver / bronze rank badge class
export function rankClass(r) {
  return r === 1 ? 'g' : r === 2 ? 's' : r === 3 ? 'b' : '';
}

// Gradient for the per-benchmark explorer bars
export function trackColor(i) {
  return i === 0
    ? 'linear-gradient(90deg,#f5c15a,#2ee6c7)'
    : 'linear-gradient(90deg,#4f6dff,#2ee6c7)';
}

// ── Provider avatars ──────────────────────────────────────────────────
export function providerColor(name) {
  const hit = PROVIDER_MATCHERS.find(p => p.re.test(name));
  return hit ? { name: hit.name, color: hit.color } : { name: 'Independent', color: '#8b9bb8' };
}

export function initials(name) {
  const words = String(name).split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!words.length) return '??';
  const w0 = words[0];
  if (w0.length >= 3) return w0.slice(0, 2).toUpperCase();
  return (w0 + (words[1] || '')).slice(0, 2).toUpperCase();
}

// URL slug for model / benchmark deep links ("GPT-5.2 Pro" → "gpt-5-2-pro")
export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
