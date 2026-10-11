import { useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'soc.theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

/** The theme the user chose with the toggle on this device, or null if they never did. */
function chosenTheme(): Theme | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return stored === 'light' || stored === 'dark' ? stored : null
  } catch {
    return null
  }
}

function systemTheme(): Theme {
  const dark = typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches
  return dark ? 'dark' : 'light'
}

/** The theme to show: the one the user chose, or else the system's. */
export function preferredTheme(): Theme {
  return chosenTheme() ?? systemTheme()
}

/** Shows `theme`, remembering nothing: the system's theme is followed, not kept. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
}

/** Shows `theme` and keeps it on this device, as the toggle does: the system no longer decides. */
export function chooseTheme(theme: Theme): void {
  applyTheme(theme)
  try {
    window.localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    return
  }
}

/**
 * Until the user chooses a theme, the console follows the system's as it changes,
 * a laptop turning dark at dusk say, with no reload (FR-SCN-08). Returns the stop.
 */
export function followSystemTheme(): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined
  const query = window.matchMedia(DARK_QUERY)
  const follow = () => {
    if (chosenTheme() === null) applyTheme(query.matches ? 'dark' : 'light')
  }
  query.addEventListener('change', follow)
  return () => {
    query.removeEventListener('change', follow)
  }
}

function subscribe(changed: () => void): () => void {
  const observer = new MutationObserver(changed)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => {
    observer.disconnect()
  }
}

function shown(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

/** The theme on screen, whoever set it: the toggle or the system. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, shown)
}
