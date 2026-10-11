import { act, screen, waitFor, within } from '@testing-library/react'

import type { FleetDraft } from '../backend/backend'
import { device, FakeBackend, MAVIC_AIR_2, NEIGHBOUR, NORTH } from '../test/FakeBackend'
import { renderApp } from '../test/render'

const DRAFT: FleetDraft = {
  name: 'Norte 1',
  model: MAVIC_AIR_2.model,
  airframeSerial: '1WNBH9',
  controllerSerial: null,
  gatewaySn: 'SOTESTDOCK01',
  aircraftSn: 'SOTESTUAV001',
  flightTimeBeforeSocS: 5400,
}

/** North with Norte 1 on SOTESTUAV001, and SOTESTUAV002 seen but in no fleet. */
async function farm() {
  const backend = new FakeBackend(NEIGHBOUR)
  backend.seen.set(NORTH.id, [device('SOTESTUAV001'), device('SOTESTUAV002', false)])
  const fleet = await backend.registerFleet(NORTH.id, DRAFT)
  return { backend, fleet }
}

async function openAt(backend: FakeBackend, search: string) {
  window.history.replaceState(null, '', `/${search}`)
  const rendered = renderApp(backend)
  await screen.findByRole('banner')
  return rendered
}

const group = (name: string) => screen.findByRole('region', { name: new RegExp(`^${name}`) })
const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })
const search = () => new URLSearchParams(window.location.search)

afterEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('the fleet panel (FR-FLE-02)', () => {
  it('lists the fleets, and apart the aircraft seen that are in none', async () => {
    const { backend } = await farm()
    await openAt(backend, '?panel=fleet')
    const fleets = await group('Fleets')
    expect(within(fleets).getByRole('button', { name: /Norte 1/ })).toHaveTextContent(
      'Norte 1DJI Mavic Air 2Online',
    )
    const seen = await group('Seen on the wire')
    expect(
      within(seen)
        .getAllByRole('button')
        .map((row) => row.textContent),
    ).toEqual(['SOTESTUAV002via labOffline'])
  })

  it('says what to do when there is nothing yet', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    backend.seen.set(NORTH.id, [])
    await openAt(backend, '?panel=fleet')
    expect(await screen.findByText(/No fleet registered yet/)).toBeInTheDocument()
    expect(screen.getByText(/No aircraft seen yet/)).toBeInTheDocument()
  })

  it('does not call an aircraft online while its stack is out of reach (FR-LNK-02)', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const lost = { name: 'lab', linkState: 'unreachable' } as const
    backend.seen.set(NORTH.id, [{ ...device('SOTESTUAV001'), stack: lost }])
    const { user } = await openAt(backend, '?panel=fleet')
    const row = within(await group('Seen on the wire')).getByRole('button')
    expect(row).toHaveTextContent('Stack unreachable')
    await user.click(row)
    expect(await within(inspector()).findByText('lab, unreachable')).toBeInTheDocument()
  })

  it('moves an aircraft to the fleets when another console registers it', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    await openAt(backend, '?panel=fleet')
    const seen = await group('Seen on the wire')
    expect(within(seen).getByRole('button', { name: /SOTESTUAV001/ })).toBeInTheDocument()
    await act(() => backend.registerFleet(NORTH.id, DRAFT))
    expect(
      await within(await group('Fleets')).findByRole('button', { name: /Norte 1/ }),
    ).toBeInTheDocument()
    expect(screen.getByText('Every aircraft seen is in a fleet.')).toBeInTheDocument()
  })
})

describe('the inspector follows the selection (FR-FLE-04, NFR-UX-03)', () => {
  it('shows the fleet a row selects, keeps it in the URL, and lets go on a second click', async () => {
    const { backend, fleet } = await farm()
    const { user } = await openAt(backend, '?panel=fleet')
    const row = within(await group('Fleets')).getByRole('button', { name: /Norte 1/ })
    await user.click(row)

    expect(await within(inspector()).findByRole('heading', { name: 'Norte 1' })).toBeVisible()
    expect(row).toHaveAttribute('aria-pressed', 'true')
    expect([search().get('panel'), search().get('fleet')]).toEqual(['fleet', fleet.id])
    const details = within(inspector())
    expect(details.getByText('1WNBH9')).toBeInTheDocument()
    expect(details.getByText('Not recorded')).toBeInTheDocument()
    expect(details.getByText('1 h 30 min')).toBeInTheDocument()
    expect(details.getByText('11 Oct 2026, 12:10')).toBeInTheDocument()
    expect(details.getByRole('link', { name: '19 m/s' })).toHaveAttribute(
      'href',
      MAVIC_AIR_2.sources.max_horizontal_speed_ms,
    )
    expect(details.getAllByText('Not published').length).toBeGreaterThan(0)

    await user.click(row)
    expect(await within(inspector()).findByText('Nothing selected.')).toBeInTheDocument()
    expect(search().get('fleet')).toBeNull()
    expect(search().get('panel')).toBe('fleet')
  })

  it('opens a shared link to an aircraft, and goes from it to its fleet', async () => {
    const { backend, fleet } = await farm()
    const { user } = await openAt(backend, '?gateway=SOTESTDOCK01&aircraft=SOTESTUAV001')
    const details = within(inspector())
    expect(await details.findByRole('heading', { name: 'SOTESTUAV001' })).toBeVisible()
    expect(details.getByText('Seen on the wire')).toBeInTheDocument()
    expect(details.getByText('0-67-0')).toBeInTheDocument()
    await user.click(details.getByRole('button', { name: 'Norte 1' }))
    expect(await details.findByRole('heading', { name: 'Norte 1' })).toBeVisible()
    expect(search().get('fleet')).toBe(fleet.id)
    expect(search().get('aircraft')).toBeNull()
  })

  it('says what a stale link points at, and clears it', async () => {
    const { backend } = await farm()
    const { user } = await openAt(backend, '?fleet=99999999-9999-4999-8999-999999999999')
    expect(await within(inspector()).findByText(/has no live fleet with this link/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Clear the selection' }))
    await waitFor(() => {
      expect(window.location.search).toBe('')
    })
    expect(within(inspector()).getByText('Nothing selected.')).toBeInTheDocument()
  })

  it('says so when a selected fleet is retired elsewhere', async () => {
    const { backend, fleet } = await farm()
    await openAt(backend, `?fleet=${fleet.id}`)
    expect(await within(inspector()).findByRole('heading', { name: 'Norte 1' })).toBeVisible()
    await act(() => backend.retireFleet(fleet.id))
    expect(await within(inspector()).findByText(/has no live fleet with this link/)).toBeVisible()
  })
})
