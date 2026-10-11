import { screen, waitFor, within } from '@testing-library/react'

import { useCameraCommands } from '../scene/commands'
import type { TelemetrySample } from '../telemetry/sample'
import { FakeBackend, NORTH, ORCHARD, PILOT } from '../test/FakeBackend'
import { renderApp } from '../test/render'
import { SITE } from '../test/site'

async function openedOn(organizationId: string, search = '', backend = new FakeBackend(PILOT)) {
  window.history.replaceState(null, '', `/${search}`)
  window.localStorage.setItem(`soc.organization.${PILOT.userId}`, organizationId)
  const rendered = renderApp(backend)
  await screen.findByRole('banner')
  return rendered
}

/** A sample of the lab stack's test aircraft, as soc-cloud broadcast it at `sentAtMs`. */
function broadcast(sentAtMs: number): TelemetrySample {
  return {
    stack: 'lab',
    gatewaySn: 'SOTESTDOCK01',
    aircraftSn: 'SOTESTUAV001',
    takenAtMs: sentAtMs - 4,
    sentAtMs,
    latitudeDeg: 41.65,
    longitudeDeg: -4.72,
    heightM: 10,
    headingDeg: 0,
    homeDistanceM: 0,
    batteryPct: 90,
    satellites: 14,
    gpsQuality: 5,
    modeCode: 0,
  }
}

afterEach(() => {
  window.history.replaceState(null, '', '/')
  Reflect.deleteProperty(window, 'socScene')
})

describe('the scene region (FR-SCN-01)', () => {
  it('says plainly when the browser cannot draw the scene', async () => {
    await openedOn(NORTH.id)
    const scene = screen.getByRole('main', { name: 'Scene' })
    expect(within(scene).getByRole('status')).toHaveTextContent('SOC needs WebGL 2')
  })

  it('names the missing site model, or the missing position', async () => {
    await openedOn(NORTH.id)
    expect(await screen.findByRole('note')).toHaveTextContent(
      'No site model for Finca Norte yet: the ground is flat.',
    )
  })

  it('credits the site model it draws, and says no more about the ground', async () => {
    const backend = new FakeBackend(PILOT)
    backend.sites.set(NORTH.id, SITE)
    await openedOn(NORTH.id, '', backend)
    expect(await screen.findByText(SITE.model.attribution)).toBeInTheDocument()
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('names a site model it cannot load, and keeps the flat ground', async () => {
    const backend = new FakeBackend(PILOT)
    backend.siteFailure = new Error('elevation.f32 answered HTTP 500')
    await openedOn(NORTH.id, '', backend)
    expect(await screen.findByRole('note')).toHaveTextContent(
      'The site model of Finca Norte cannot be loaded (elevation.f32 answered HTTP 500): the ground is flat.',
    )
  })

  it('stays the same region when the organization changes', async () => {
    const { user } = await openedOn(NORTH.id)
    const scene = screen.getByRole('main', { name: 'Scene' })
    await user.click(screen.getByRole('button', { name: `Organization: ${NORTH.name}` }))
    await user.click(await screen.findByRole('menuitemradio', { name: /Almendral/ }))
    await screen.findByRole('button', { name: `Organization: ${ORCHARD.name}` })
    expect(screen.getByRole('main', { name: 'Scene' })).toBe(scene)
    expect(screen.getByRole('note')).toHaveTextContent(
      'Almendral has no position in Virtual Origen: the scene is not on the map.',
    )
  })

  it('shows its statistics only when asked, and hands the sampler over', async () => {
    await openedOn(NORTH.id)
    expect(screen.queryByRole('definition')).toBeNull()
    expect(Reflect.has(window, 'socScene')).toBe(false)
  })

  it('shows frames, frame time, draw calls and memory with ?stats (NFR-OBS-05)', async () => {
    await openedOn(NORTH.id, '?stats')
    const stats = screen.getByLabelText('Scene statistics')
    for (const name of ['frames', 'p95', 'delivery p95', 'draw calls', 'geometries', 'textures']) {
      expect(within(stats).getByText(name)).toBeInTheDocument()
    }
    expect(Reflect.has(window, 'socScene')).toBe(true)
  })

  it('shows the delivery p95 of the telemetry the console has received (NFR-PERF-01)', async () => {
    const { backend } = await openedOn(NORTH.id, '?stats')
    const deliveryP95 = () =>
      within(screen.getByLabelText('Scene statistics')).getByText('delivery p95').nextElementSibling
    expect(deliveryP95()).toHaveTextContent(/^–$/)
    backend.sample(NORTH.id, broadcast(Date.now() - 40))
    await waitFor(() => {
      expect(Number.parseFloat(deliveryP95()?.textContent ?? '')).toBeGreaterThanOrEqual(40)
    })
    expect(deliveryP95()).toHaveTextContent(/^\d+\.\d ms$/)
  })
})

describe('the map tools (FR-SCN-03)', () => {
  it('ask the camera to come closer, go farther and return to the overview', async () => {
    const { user } = await openedOn(NORTH.id)
    const tools = screen.getByRole('toolbar', { name: 'Map tools' })
    const sent = () => useCameraCommands.getState().last?.command
    await user.click(within(tools).getByRole('button', { name: 'Closer' }))
    expect(sent()).toBe('closer')
    await user.click(within(tools).getByRole('button', { name: 'Farther' }))
    expect(sent()).toBe('farther')
    await user.click(within(tools).getByRole('button', { name: 'Back to the site overview' }))
    expect(sent()).toBe('overview')
  })
})
