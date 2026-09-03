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

// Opacity band for benchmark coverage: rows fade as CL drops so thin data
// is visually obvious without hiding anything. Bands align to 1/8 steps
// of the 8 core benchmarks (87.5% = 7/8).
export function covClass(cl) {
  if (cl === null || cl === undefined) return 'cov-min';
  if (cl >= 87.5) return 'cov-full';
  if (cl >= 62.5) return 'cov-mid';
  if (cl >= 37.5) return 'cov-low';
  return 'cov-min';
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

// ── Metadata formatting (OpenRouter catalog values) ───────────────────
// Token windows: 1_000_000 → "1M", 262_144 → "262K", 8_000 → "8K"
export function fmtCtx(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  n = Number(n);
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return (m >= 10 ? Math.round(m) : Math.round(m * 10) / 10) + 'M';
  }
  if (n >= 1000) return Math.round(n / 1000) + 'K';
  return String(n);
}

// Billions of parameters: 753.3 → "753B", 41 → "41B", 1.5 → "1.5B"
export function fmtB(b) {
  if (b === null || b === undefined || Number.isNaN(Number(b))) return '—';
  b = Number(b);
  if (b >= 100) return Math.round(b) + 'B';
  if (b >= 10) return Math.round(b) + 'B';
  return (Math.round(b * 10) / 10) + 'B';
}

// USD per 1M tokens: 10 → "$10", 3.5 → "$3.50", 0.03 → "$0.03", 0 → "$0"
export function fmtUsd(p) {
  if (p === null || p === undefined || Number.isNaN(Number(p))) return '—';
  p = Number(p);
  if (p === 0) return '$0';
  if (p >= 10) return '$' + Math.round(p);
  if (p >= 1) return '$' + p.toFixed(2).replace(/0$/, '');
  return '$' + p.toFixed(p < 0.1 ? 3 : 2).replace(/0+$/, '').replace(/\.$/, '');
}

// Modality chip icon (FontAwesome 7 names, icon pack = fas)
export function modalityIcon(m) {
  return { text: 'font', image: 'image', audio: 'volume-high', video: 'film', file: 'paperclip' }[m] || 'circle-question';
}
