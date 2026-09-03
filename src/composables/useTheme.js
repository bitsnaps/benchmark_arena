import { ref } from 'vue'

// Official Buefy/Bulma theme pattern: data-theme attribute on <html>,
// persisted in localStorage, OS preference on first visit.
const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('theme') : null
const prefersDark =
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches

const isDark = ref(stored ? stored === 'dark' : prefersDark)

function applyTheme() {
  document.documentElement.setAttribute('data-theme', isDark.value ? 'dark' : 'light')
}

// Apply before first paint to avoid a flash of the wrong theme
if (typeof document !== 'undefined') applyTheme()

function toggleTheme() {
  isDark.value = !isDark.value
  localStorage.setItem('theme', isDark.value ? 'dark' : 'light')
  applyTheme()
}

export function useTheme() {
  return { isDark, toggleTheme }
}
