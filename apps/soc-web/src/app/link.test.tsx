import { act, screen, within } from '@testing-library/react'

import { device, FakeBackend, NEIGHBOUR, NORTH } from '../test/FakeBackend'
import { renderApp } from '../test/render'

afterEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('the console cut off from its live topics (NFR-REL-07, NFR-SAF-02)', () => {
  it('says so beside the clock while cut off, and nothing once back', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    renderApp(backend)
    const banner = within(await screen.findByRole('banner'))
    const said = () => banner.getAllByRole('status').map((status) => status.textContent)
    expect(said()).not.toContain('Reconnecting')
    act(() => {
      backend.setLink('down')
    })
    expect(banner.getByText('Reconnecting')).toBeVisible()
    act(() => {
      backend.setLink('up')
    })
    expect(banner.queryByText('Reconnecting')).toBeNull()
  })

  it('reads every presence as unknown while cut off: it is as of the cut, not now', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    backend.seen.set(NORTH.id, [device('SOTESTUAV001'), device('SOTESTUAV002', false)])
    window.history.replaceState(null, '', '/?panel=fleet')
    renderApp(backend)
    const row = (name: RegExp) => screen.findByRole('button', { name })
    expect(await row(/^SOTESTUAV001.*Online$/)).toBeInTheDocument()
    expect(await row(/^SOTESTUAV002.*Offline$/)).toBeInTheDocument()
    act(() => {
      backend.setLink('down')
    })
    expect(await row(/^SOTESTUAV001.*Unknown$/)).toBeInTheDocument()
    expect(await row(/^SOTESTUAV002.*Unknown$/)).toBeInTheDocument()
    act(() => {
      backend.setLink('up')
    })
    expect(await row(/^SOTESTUAV001.*Online$/)).toBeInTheDocument()
  })
})
