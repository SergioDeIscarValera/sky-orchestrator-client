import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ThemeToggle } from '../app/ThemeToggle'
import { applyTheme, chooseTheme, followSystemTheme, preferredTheme } from './theme'

/** A system whose dark preference the test turns on and off, as an OS does at dusk. */
function system(dark: boolean) {
  const listeners = new Set<() => void>()
  const query = {
    matches: dark,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }
  const original = window.matchMedia.bind(window)
  window.matchMedia = (() => query) as unknown as typeof window.matchMedia
  return {
    turn(next: boolean) {
      query.matches = next
      for (const listener of listeners) listener()
    },
    listening: () => listeners.size,
    restore() {
      window.matchMedia = original
    },
  }
}

describe('the theme (FR-SCN-08)', () => {
  it("starts with the system's and keeps nothing, so a later system change still counts", () => {
    const os = system(true)
    try {
      applyTheme(preferredTheme())
      expect(document.documentElement.dataset.theme).toBe('dark')
      expect(window.localStorage.getItem('soc.theme')).toBeNull()
    } finally {
      os.restore()
    }
  })

  it("follows the system's as it changes, until the user chooses one", () => {
    const os = system(false)
    const stop = followSystemTheme()
    try {
      applyTheme(preferredTheme())
      os.turn(true)
      expect(document.documentElement.dataset.theme).toBe('dark')
      os.turn(false)
      expect(document.documentElement.dataset.theme).toBe('light')
      chooseTheme('dark')
      os.turn(false)
      expect(document.documentElement.dataset.theme).toBe('dark')
      expect(preferredTheme()).toBe('dark')
    } finally {
      stop()
      expect(os.listening()).toBe(0)
      os.restore()
    }
  })

  it("shows what is on screen, the system's change included, and keeps the user's choice", async () => {
    const os = system(false)
    const stop = followSystemTheme()
    try {
      applyTheme(preferredTheme())
      render(<ThemeToggle />)
      expect(screen.getByRole('button', { name: 'Switch to the dark theme' })).toBeInTheDocument()
      act(() => {
        os.turn(true)
      })
      expect(
        await screen.findByRole('button', { name: 'Switch to the light theme' }),
      ).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Switch to the light theme' }))
      expect(window.localStorage.getItem('soc.theme')).toBe('light')
      expect(await screen.findByRole('button', { name: 'Switch to the dark theme' })).toBeVisible()
    } finally {
      stop()
      os.restore()
    }
  })
})
