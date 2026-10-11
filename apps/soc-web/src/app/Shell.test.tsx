import { screen } from '@testing-library/react'

import { FakeBackend, NEIGHBOUR } from '../test/FakeBackend'
import { renderApp } from '../test/render'
import { DESTINATIONS } from './destinations'

async function renderShell() {
  const rendered = renderApp(new FakeBackend(NEIGHBOUR))
  await screen.findByRole('banner')
  return rendered
}

describe('the shell', () => {
  it('lays the panels over the scene as landmarks', async () => {
    await renderShell()
    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeInTheDocument()
    expect(screen.getByRole('main', { name: 'Scene' })).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeInTheDocument()
  })

  it('offers every section of the console', async () => {
    await renderShell()
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
    const { user } = await renderShell()
    await user.click(screen.getByRole('button', { name: 'Switch to the dark theme' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(window.localStorage.getItem('soc.theme')).toBe('dark')
    await user.click(screen.getByRole('button', { name: 'Switch to the light theme' }))
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it("shows the organization's time with tabular figures, and UTC on hover", async () => {
    await renderShell()
    const time = screen.getByRole('banner').querySelector('time')
    expect(time).toHaveClass('tabular-nums')
    expect(time?.title).toMatch(/^Europe\/Madrid · \d{2}:\d{2}:\d{2} UTC$/)
  })
})
