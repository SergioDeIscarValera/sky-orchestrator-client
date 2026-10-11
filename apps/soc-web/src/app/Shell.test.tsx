import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { DESTINATIONS } from './destinations'
import { Shell } from './Shell'

describe('the shell', () => {
  it('lays the panels over the scene as landmarks', () => {
    render(<Shell />)
    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeInTheDocument()
    expect(screen.getByRole('main', { name: 'Scene' })).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeInTheDocument()
  })

  it('offers every section of the console', () => {
    render(<Shell />)
    expect(DESTINATIONS.map(({ label }) => label)).toEqual([
      'Fleet',
      'Geofences',
      'Waylines',
      'Operations',
      'Settings',
    ])
    for (const { label } of DESTINATIONS) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
  })

  it('switches the theme and remembers it', async () => {
    document.documentElement.dataset.theme = 'light'
    render(<Shell />)
    await userEvent.click(screen.getByRole('button', { name: 'Switch to the dark theme' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(window.localStorage.getItem('soc.theme')).toBe('dark')
    await userEvent.click(screen.getByRole('button', { name: 'Switch to the light theme' }))
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('shows the time with tabular figures', () => {
    render(<Shell />)
    expect(screen.getByRole('banner').querySelector('time')).toHaveClass('tabular-nums')
  })
})
