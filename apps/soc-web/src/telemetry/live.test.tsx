import { act, renderHook, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'

import type { FleetDraft } from '../backend/backend'
import { SettingsContext } from '../config/settings'
import {
  device,
  FakeBackend,
  MAVIC_AIR_2,
  NEIGHBOUR,
  NORTH,
  ORCHARD,
  PILOT,
} from '../test/FakeBackend'
import { renderApp, SETTINGS } from '../test/render'
import { useFreshness } from './freshness'
import type { TelemetrySample } from './sample'

const DRAFT: FleetDraft = {
  name: 'Norte 1',
  model: MAVIC_AIR_2.model,
  airframeSerial: '1WNBH9',
  controllerSerial: null,
  gatewaySn: 'SOTESTDOCK01',
  aircraftSn: 'SOTESTUAV001',
  flightTimeBeforeSocS: 0,
}

function sample(changes: Partial<TelemetrySample> = {}): TelemetrySample {
  return {
    stack: 'lab',
    gatewaySn: 'SOTESTDOCK01',
    aircraftSn: 'SOTESTUAV001',
    takenAtMs: 1_790_800_000_000,
    sentAtMs: 1_790_800_000_004,
    latitudeDeg: 41.652312,
    longitudeDeg: -4.724512,
    heightM: 12.3,
    headingDeg: -90,
    homeDistanceM: 34.5,
    batteryPct: 87,
    satellites: 14,
    gpsQuality: 5,
    modeCode: 5,
    ...changes,
  }
}

const inspector = () => within(screen.getByRole('complementary', { name: 'Inspector' }))
const live = () => within(inspector().getByRole('region', { name: 'Live' }))

describe('live values in the inspector (FR-TEL-03, FR-FLE-04)', () => {
  it("shows the fleet's latest sample, and unavailable for what it lacks, never zero", async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const fleet = await backend.registerFleet(NORTH.id, DRAFT)
    window.history.replaceState(null, '', `/?fleet=${fleet.id}`)
    renderApp(backend)
    await screen.findByRole('complementary', { name: 'Inspector' })
    await inspector().findByRole('heading', { name: 'Norte 1' })
    expect(live().getByText('No sample since the console opened')).toBeInTheDocument()

    act(() => {
      backend.sample(NORTH.id, sample({ heightM: null }))
    })
    const values = live()
    expect(values.getByText('Live, under 1 s ago')).toBeInTheDocument()
    expect(values.getByText('41.652312° N, 4.724512° W')).toBeInTheDocument()
    expect(values.getByText('270°')).toBeInTheDocument()
    expect(values.getByText('87 %')).toBeInTheDocument()
    expect(values.getByText('Wayline')).toBeInTheDocument()
    const height = values.getByText('Height above takeoff').nextElementSibling
    expect(height).toHaveTextContent('Unavailable')
    expect(values.getByText('Horizontal speed').nextElementSibling).toHaveTextContent('Unavailable')
    expect(values.queryByText('0 m')).toBeNull()
  })

  it('shows a newer sample, and never an older one that arrives late', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    backend.seen.set(NORTH.id, [device('SOTESTUAV001')])
    window.history.replaceState(null, '', '/?gateway=SOTESTDOCK01&aircraft=SOTESTUAV001')
    renderApp(backend)
    await screen.findByRole('complementary', { name: 'Inspector' })
    await inspector().findByRole('heading', { name: 'SOTESTUAV001' })
    act(() => {
      backend.sample(NORTH.id, sample({ batteryPct: 80, takenAtMs: 2000 }))
      backend.sample(NORTH.id, sample({ batteryPct: 81, takenAtMs: 1000 }))
    })
    expect(live().getByText('80 %')).toBeInTheDocument()
  })

  it("listens to the open organization's telemetry only", async () => {
    window.localStorage.setItem(`soc.organization.${PILOT.userId}`, ORCHARD.id)
    const backend = new FakeBackend(PILOT)
    renderApp(backend)
    await screen.findByRole('button', { name: `Organization: ${ORCHARD.name}` })
    await vi.waitFor(() => {
      expect([backend.watchingTelemetry(ORCHARD.id), backend.watchingTelemetry(NORTH.id)]).toEqual([
        1, 0,
      ])
    })
  })
})

describe('a value turns stale and lost on time (FR-TEL-02)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('crosses each threshold within 100 ms of it, not a tick later', () => {
    const wrapper = ({ children }: { readonly children: ReactNode }) => (
      <SettingsContext
        value={{ ...SETTINGS, telemetryStaleAfterMs: 3050, telemetryLostAfterMs: 10050 }}
      >
        {children}
      </SettingsContext>
    )
    const receivedAt = performance.now()
    const { result } = renderHook(() => useFreshness(receivedAt), { wrapper })
    expect(result.current.freshness).toBe('live')

    act(() => {
      vi.advanceTimersByTime(3049)
    })
    expect(result.current.freshness).toBe('live')
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current.freshness).toBe('stale')
    act(() => {
      vi.advanceTimersByTime(6999)
    })
    expect(result.current.freshness).toBe('stale')
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toEqual({ freshness: 'lost', ageMs: 10050 })
  })
})
