import { act, renderHook, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'

import type { FleetDraft } from '../backend/backend'
import { SettingsContext } from '../config/settings'
import { useCameraCommands } from '../scene/commands'
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
    const tile = (label: string) => values.getByText(label).nextElementSibling
    expect(tile('Height')).toHaveTextContent('Unavailable')
    expect(values.getByText('above takeoff')).toBeInTheDocument()
    expect(tile('Battery')).toHaveTextContent('87 %')
    expect(tile('Satellites')).toHaveTextContent('14')
    expect(values.getByText('quality 5')).toBeInTheDocument()
    expect(tile('Mode')).toHaveTextContent('Wayline')
    expect(tile('Heading')).toHaveTextContent('270°')
    expect(tile('From home')).toHaveTextContent('34.5 m')
    expect(tile('Position')).toHaveTextContent('41.652312° N, 4.724512° W')
    // What Sky Orchestrator does not send yet has no tile, rather than an empty one.
    expect(values.queryByText('Horizontal speed')).toBeNull()
    expect(values.queryByText('0 m')).toBeNull()
  })

  it('never shows a sample held up as live: last known and greyed (FR-SAF-02, NFR-REL-07)', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    backend.seen.set(NORTH.id, [device('SOTESTUAV001')])
    window.history.replaceState(null, '', '/?gateway=SOTESTDOCK01&aircraft=SOTESTUAV001')
    renderApp(backend)
    await screen.findByRole('complementary', { name: 'Inspector' })
    await inspector().findByRole('heading', { name: 'SOTESTUAV001' })
    const section = (name: string) => within(inspector().getByRole('region', { name }))
    const height = (name: string) => section(name).getByText('Height').nextElementSibling
    // On time: 5 ms from soc-cloud's send to the browser.
    act(() => {
      backend.sample(NORTH.id, sample({ takenAtMs: 1000, sentAtMs: Date.now() - 5 }))
    })
    expect(section('Live').getByText('Live, under 1 s ago')).toBeInTheDocument()
    expect(height('Live')).toHaveClass('text-heading')
    // Held up 5.5 s by a cut, then delivered: as old as that, whatever its arrival. Half
    // a second either side of the whole second, so the clock's own millisecond cannot tip it.
    act(() => {
      backend.sample(NORTH.id, sample({ takenAtMs: 2000, sentAtMs: Date.now() - 5505 }))
    })
    expect(section('Last known').getByText('Stale, 5 s ago')).toBeInTheDocument()
    expect(height('Last known')).toHaveClass('text-muted')
    act(() => {
      backend.sample(NORTH.id, sample({ takenAtMs: 3000, sentAtMs: Date.now() - 11_505 }))
    })
    expect(section('Last known').getByText('Lost, 11 s ago')).toBeInTheDocument()
  })

  it('says where the height is measured from, once the aircraft has stood idle', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    backend.seen.set(NORTH.id, [device('SOTESTUAV001')])
    window.history.replaceState(null, '', '/?gateway=SOTESTDOCK01&aircraft=SOTESTUAV001')
    renderApp(backend)
    await screen.findByRole('complementary', { name: 'Inspector' })
    await inspector().findByRole('heading', { name: 'SOTESTUAV001' })
    const takeoff = () => live().getByText('Takeoff point').nextElementSibling
    act(() => {
      backend.sample(NORTH.id, sample({ takenAtMs: 1000 }))
    })
    expect(takeoff()).toHaveTextContent('Not seen; the scene assumes its first position')
    act(() => {
      backend.sample(NORTH.id, sample({ takenAtMs: 2000, modeCode: 0, longitudeDeg: -4.7246 }))
      backend.sample(NORTH.id, sample({ takenAtMs: 3000 }))
    })
    expect(takeoff()).toHaveTextContent('41.652312° N, 4.724600° W')
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

  it('colours the battery bar by its level, low under 50 % and critical under 20 %', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    backend.seen.set(NORTH.id, [device('SOTESTUAV001')])
    window.history.replaceState(null, '', '/?gateway=SOTESTDOCK01&aircraft=SOTESTUAV001')
    renderApp(backend)
    await screen.findByRole('complementary', { name: 'Inspector' })
    await inspector().findByRole('heading', { name: 'SOTESTUAV001' })
    const bar = () => inspector().getByText('Battery').parentElement?.querySelector('[data-level]')
    const levels: string[] = []
    for (const [takenAtMs, batteryPct] of [
      [1000, 87],
      [2000, 49],
      [3000, 19],
    ] as const) {
      act(() => {
        backend.sample(NORTH.id, sample({ takenAtMs, batteryPct }))
      })
      levels.push(bar()?.getAttribute('data-level') ?? 'none')
    }
    expect(levels).toEqual(['ok', 'low', 'critical'])
    act(() => {
      backend.sample(NORTH.id, sample({ takenAtMs: 4000, batteryPct: null }))
    })
    expect(bar()).toBeNull()
  })

  it('follows the aircraft in the scene from its inspector, and lets it go', async () => {
    useCameraCommands.getState().pin(null)
    const backend = new FakeBackend(NEIGHBOUR)
    backend.seen.set(NORTH.id, [device('SOTESTUAV001')])
    window.history.replaceState(null, '', '/?gateway=SOTESTDOCK01&aircraft=SOTESTUAV001')
    const { user } = renderApp(backend)
    await screen.findByRole('complementary', { name: 'Inspector' })
    await inspector().findByRole('heading', { name: 'SOTESTUAV001' })
    await user.click(inspector().getByRole('button', { name: 'Follow' }))
    expect(useCameraCommands.getState().pinned).toBe('SOTESTDOCK01/SOTESTUAV001')
    const following = inspector().getByRole('button', { name: 'Following' })
    expect(following).toHaveAttribute('aria-pressed', 'true')
    await user.click(following)
    expect(useCameraCommands.getState().pinned).toBeNull()
    expect(inspector().getByRole('button', { name: 'Follow' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
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
    const latest = { receivedAt, dueAt: receivedAt }
    const { result } = renderHook(() => useFreshness(latest), { wrapper })
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
