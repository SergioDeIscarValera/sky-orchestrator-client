import { useSyncExternalStore } from 'react'

import { AIRCRAFT_COLOURS, aircraftColourToken } from '../theme/aircraft'

/** The scene's colours are the design tokens of the current theme (FR-SCN-08, NFR-UX-01). */
const TOKENS = {
  page: '--color-page',
  ground: '--color-surface',
  gridMinor: '--color-border',
  gridMajor: '--color-muted',
  accent: '--color-primary',
  casing: '--color-casing',
} as const

export type ScenePalette = Readonly<Record<keyof typeof TOKENS, string>> & {
  /** Each aircraft's own colour, by its index (`useAircraftColours`). */
  readonly aircraft: readonly string[]
}

export function readPalette(root: HTMLElement = document.documentElement): ScenePalette {
  const style = getComputedStyle(root)
  const read = (token: string) => style.getPropertyValue(token).trim()
  return {
    page: read(TOKENS.page),
    ground: read(TOKENS.ground),
    gridMinor: read(TOKENS.gridMinor),
    gridMajor: read(TOKENS.gridMajor),
    accent: read(TOKENS.accent),
    casing: read(TOKENS.casing),
    aircraft: Array.from({ length: AIRCRAFT_COLOURS }, (_, index) =>
      read(aircraftColourToken(index)),
    ),
  }
}

let current: { readonly theme: string | undefined; readonly palette: ScenePalette } | null = null

function subscribe(changed: () => void): () => void {
  const observer = new MutationObserver(changed)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => {
    observer.disconnect()
  }
}

function snapshot(): ScenePalette {
  const theme = document.documentElement.dataset.theme
  if (current === null || current.theme !== theme) current = { theme, palette: readPalette() }
  return current.palette
}

/** The palette, read again whenever the theme changes. */
export function usePalette(): ScenePalette {
  return useSyncExternalStore(subscribe, snapshot)
}
