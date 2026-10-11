import { act, screen, waitFor } from '@testing-library/react'

import { FakeBackend, NEIGHBOUR } from '../test/FakeBackend'
import { renderApp } from '../test/render'
import { readView } from './router'

async function openAt(search = '') {
  window.history.replaceState(null, '', `/${search}`)
  const rendered = renderApp(new FakeBackend(NEIGHBOUR))
  await screen.findByRole('banner')
  return rendered
}

afterEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('the view in the URL (NFR-UX-03)', () => {
  it('reads a panel and a fleet, and leaves out what does not read', () => {
    const fleet = '11111111-1111-4111-8111-111111111111'
    expect(readView({ panel: 'fleet', fleet })).toEqual({ panel: 'fleet', fleet })
    expect(readView({ panel: 'hangar', fleet: 'not-a-uuid', other: 1 })).toEqual({})
  })

  it('opens and closes a panel from the rail, and keeps it in the URL', async () => {
    const { user } = await openAt()
    const fleet = screen.getByRole('button', { name: 'Fleet' })
    expect(fleet).toHaveAttribute('aria-pressed', 'false')
    await user.click(fleet)
    expect(await screen.findByRole('heading', { name: 'Fleet' })).toBeInTheDocument()
    expect(fleet).toHaveAttribute('aria-pressed', 'true')
    expect(new URLSearchParams(window.location.search).get('panel')).toBe('fleet')
    await user.click(fleet)
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Fleet' })).toBeNull()
    })
    expect(window.location.search).toBe('')
  })

  it('opens the panel a shared link names, and says when its content arrives', async () => {
    await openAt('?panel=waylines')
    expect(await screen.findByText('Waylines arrive in M3.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Waylines' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('opens nothing for a link it cannot read', async () => {
    await openAt('?panel=hangar&fleet=nope')
    expect(screen.queryByRole('region')).toBeNull()
    expect(screen.queryAllByRole('button', { pressed: true })).toEqual([])
  })

  it('closes the open panel with Escape (NFR-UX-04)', async () => {
    const { user } = await openAt('?panel=geofences')
    await screen.findByRole('heading', { name: 'Geofences' })
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Geofences' })).toBeNull()
    })
  })

  it('switches one panel for another', async () => {
    const { user } = await openAt('?panel=fleet')
    await screen.findByRole('heading', { name: 'Fleet' })
    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'Operations' }))
    })
    expect(await screen.findByText('Operations arrive in M4.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Fleet' })).toBeNull()
  })
})
