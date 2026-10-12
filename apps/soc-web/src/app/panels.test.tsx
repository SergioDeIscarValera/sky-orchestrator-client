import { act, screen, waitFor, within } from '@testing-library/react'

import type { FleetDraft, WaylineDraft } from '../backend/backend'
import { FakeBackend, MAVIC_AIR_2, NEIGHBOUR, NORTH } from '../test/FakeBackend'
import { renderApp } from '../test/render'
import { readView, select, selectionOf, withPanel } from './router'

const DRAFT: FleetDraft = {
  name: 'Norte 1',
  model: MAVIC_AIR_2.model,
  airframeSerial: '1WNBH9',
  controllerSerial: null,
  gatewaySn: 'SOTESTDOCK01',
  aircraftSn: 'SOTESTUAV001',
  flightTimeBeforeSocS: 5400,
}

const SPOT = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
const CORRIDOR: WaylineDraft = {
  name: 'Corridor 1',
  takeoff: SPOT,
  defaultHeightM: 30,
  speedMs: 5,
  design: {},
  waypoints: [{ index: 0, position: SPOT, heightM: 30 }],
  metrics: { waypointCount: 1, distanceM: 0, durationS: 0 },
  bakeVersion: '1',
}

async function openAt(search = '', backend = new FakeBackend(NEIGHBOUR)) {
  window.history.replaceState(null, '', `/${search}`)
  const rendered = renderApp(backend)
  await screen.findByRole('banner')
  return rendered
}

/** NORTH with Norte 1 on SOTESTUAV001 and one saved wayline, each a selection to make. */
async function farm() {
  const backend = new FakeBackend(NEIGHBOUR)
  const fleet = await backend.registerFleet(NORTH.id, DRAFT)
  const wayline = await backend.createWayline(NORTH.id, CORRIDOR)
  return { backend, fleet, wayline }
}

const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })
const params = () => new URLSearchParams(window.location.search)

afterEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('the view in the URL (NFR-UX-03)', () => {
  it('reads a panel and a fleet, and leaves out what does not read', () => {
    const fleet = '11111111-1111-4111-8111-111111111111'
    expect(readView({ panel: 'fleet', fleet })).toEqual({ panel: 'fleet', fleet })
    expect(readView({ panel: 'hangar', fleet: 'not-a-uuid', other: 1 })).toEqual({})
  })

  it('reads an aircraft by its gateway and its serial, a fleet before it, neither alone', () => {
    const fleet = '11111111-1111-4111-8111-111111111111'
    const aircraft = { gateway: 'SOTESTDOCK01', aircraft: 'SOTESTUAV001' }
    expect(readView(aircraft)).toEqual(aircraft)
    expect(readView({ ...aircraft, fleet })).toEqual({ fleet })
    expect(readView({ gateway: 'SOTESTDOCK01' })).toEqual({})
    expect(readView({ ...aircraft, aircraft: 'SOTEST/../UAV' })).toEqual({})
  })

  it('reads a geofence, after a fleet and before an aircraft', () => {
    const fleet = '11111111-1111-4111-8111-111111111111'
    const geofence = '22222222-2222-4222-8222-222222222222'
    const aircraft = { gateway: 'SOTESTDOCK01', aircraft: 'SOTESTUAV001' }
    expect(readView({ panel: 'geofences', geofence })).toEqual({ panel: 'geofences', geofence })
    expect(readView({ geofence, fleet })).toEqual({ fleet })
    expect(readView({ ...aircraft, geofence })).toEqual({ geofence })
    expect(readView({ geofence: 'North field' })).toEqual({})
    const selection = { kind: 'geofence', geofenceId: geofence } as const
    expect(select({ panel: 'geofences', fleet }, selection)).toEqual({
      panel: 'geofences',
      geofence,
    })
    expect(selectionOf(select({}, selection))).toEqual(selection)
  })

  it('reads a wayline, after a geofence and before an aircraft', () => {
    const geofence = '22222222-2222-4222-8222-222222222222'
    const wayline = '33333333-3333-4333-8333-333333333333'
    const aircraft = { gateway: 'SOTESTDOCK01', aircraft: 'SOTESTUAV001' }
    expect(readView({ panel: 'waylines', wayline })).toEqual({ panel: 'waylines', wayline })
    expect(readView({ wayline, geofence })).toEqual({ geofence })
    expect(readView({ ...aircraft, wayline })).toEqual({ wayline })
    expect(readView({ wayline: 'Corridor' })).toEqual({})
    const selection = { kind: 'wayline', waylineId: wayline } as const
    expect(select({ panel: 'waylines', geofence }, selection)).toEqual({
      panel: 'waylines',
      wayline,
    })
    expect(selectionOf(select({}, selection))).toEqual(selection)
  })

  it("reads a selection's open form, and no form without a selection", () => {
    const aircraft = { gateway: 'SOTESTDOCK01', aircraft: 'SOTESTUAV001' }
    expect(readView({ ...aircraft, form: 'register' })).toEqual({ ...aircraft, form: 'register' })
    expect(readView({ form: 'register' })).toEqual({})
    expect(readView({ ...aircraft, form: 'delete' })).toEqual(aircraft)
  })

  it('selects one thing at a time and keeps the panel open', () => {
    const fleet = '11111111-1111-4111-8111-111111111111'
    const device = { kind: 'device', gatewaySn: 'SOTESTDOCK01', aircraftSn: 'A1' } as const
    const view = { panel: 'fleet', fleet } as const
    expect(select(view, device)).toEqual({
      panel: 'fleet',
      gateway: 'SOTESTDOCK01',
      aircraft: 'A1',
    })
    expect(selectionOf(select(view, device))).toEqual(device)
    expect(select(view, null)).toEqual({ panel: 'fleet' })
    expect(selectionOf({})).toBeNull()
  })

  it('opens a panel with nothing selected, or with none open', () => {
    expect(withPanel('geofences')).toEqual({ panel: 'geofences' })
    expect(withPanel(undefined)).toEqual({})
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
    await openAt('?panel=operations')
    expect(await screen.findByText('Operations arrive in M4.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Operations' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
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

describe('changing the panel drops the selection (NFR-UX-03)', () => {
  it('drops a fleet when the rail opens geofences', async () => {
    const { backend, fleet } = await farm()
    const { user } = await openAt(`?panel=fleet&fleet=${fleet.id}`, backend)
    await within(inspector()).findByRole('heading', { name: 'Norte 1' })
    await user.click(screen.getByRole('button', { name: 'Geofences' }))
    expect(await screen.findByRole('heading', { name: 'Geofences' })).toBeVisible()
    expect([params().get('panel'), params().get('fleet')]).toEqual(['geofences', null])
    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull()
    })
  })

  it('drops a wayline when the rail opens geofences', async () => {
    const { backend, wayline } = await farm()
    const { user } = await openAt(`?panel=waylines&wayline=${wayline.id}`, backend)
    await within(inspector()).findByRole('heading', { name: 'Corridor 1' })
    await user.click(screen.getByRole('button', { name: 'Geofences' }))
    expect(await screen.findByRole('heading', { name: 'Geofences' })).toBeVisible()
    expect([params().get('panel'), params().get('wayline')]).toEqual(['geofences', null])
    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull()
    })
  })

  it('drops a wayline when the rail opens the fleet', async () => {
    const { backend, wayline } = await farm()
    const { user } = await openAt(`?panel=waylines&wayline=${wayline.id}`, backend)
    await within(inspector()).findByRole('heading', { name: 'Corridor 1' })
    await user.click(screen.getByRole('button', { name: 'Fleet' }))
    expect(await screen.findByRole('heading', { name: 'Fleet' })).toBeVisible()
    expect([params().get('panel'), params().get('wayline')]).toEqual(['fleet', null])
    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull()
    })
  })

  it('drops a selection made in the scene when the rail opens a panel', async () => {
    const { backend } = await farm()
    const { user } = await openAt('?gateway=SOTESTDOCK01&aircraft=SOTESTUAV001', backend)
    await within(inspector()).findByRole('heading', { name: 'SOTESTUAV001' })
    await user.click(screen.getByRole('button', { name: 'Waylines' }))
    expect(await screen.findByRole('heading', { name: 'Waylines' })).toBeVisible()
    expect([params().get('panel'), params().get('aircraft')]).toEqual(['waylines', null])
    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull()
    })
  })

  it("drops the selection with the panel's close button", async () => {
    const { backend, fleet } = await farm()
    const { user } = await openAt(`?panel=fleet&fleet=${fleet.id}`, backend)
    await within(inspector()).findByRole('heading', { name: 'Norte 1' })
    await user.click(screen.getByRole('button', { name: 'Close Fleet' }))
    await waitFor(() => {
      expect(window.location.search).toBe('')
    })
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull()
  })

  it('drops the selection when the rail closes the open panel', async () => {
    const { backend, fleet } = await farm()
    const { user } = await openAt(`?panel=fleet&fleet=${fleet.id}`, backend)
    await within(inspector()).findByRole('heading', { name: 'Norte 1' })
    await user.click(screen.getByRole('button', { name: 'Fleet' }))
    await waitFor(() => {
      expect(window.location.search).toBe('')
    })
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull()
  })
})
