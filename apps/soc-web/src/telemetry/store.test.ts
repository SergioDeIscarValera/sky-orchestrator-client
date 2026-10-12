// @vitest-environment node
import { createTelemetryStore, slidingMinimum, TRANSIT_WINDOW_MS } from './store'
import type { TelemetrySample } from './sample'

function sample(takenAtMs: number, aircraftSn = 'SOTESTUAV001'): TelemetrySample {
  return {
    stack: 'lab',
    gatewaySn: 'SOTESTDOCK01',
    aircraftSn,
    takenAtMs,
    sentAtMs: takenAtMs + 4,
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

describe("the console's telemetry (FR-TEL-01, FR-TEL-02)", () => {
  it("keeps each aircraft's latest sample and the one before it", () => {
    let wall = 1010
    const store = createTelemetryStore(() => wall)
    store.getState().receive(sample(1000), 10)
    wall = 1210
    store.getState().receive(sample(1200), 210)
    const track = store.getState().tracks.get('SOTESTDOCK01/SOTESTUAV001')
    expect(track?.latest).toEqual({ sample: sample(1200), receivedAt: 210, dueAt: 210 })
    expect(track?.previous).toEqual({ sample: sample(1000), receivedAt: 10, dueAt: 10 })
  })

  it('drops a sample the aircraft took no later than the latest, so a track never runs back', () => {
    const store = createTelemetryStore()
    store.getState().receive(sample(1200), 10)
    const before = store.getState()
    store.getState().receive(sample(1000), 20)
    store.getState().receive(sample(1200), 30)
    expect(store.getState()).toBe(before)
  })

  it('remembers where the aircraft last stood idle, its takeoff point (ADR-0014)', () => {
    const store = createTelemetryStore()
    const flying = (takenAtMs: number, longitudeDeg: number) => ({
      ...sample(takenAtMs),
      longitudeDeg,
      modeCode: 5,
    })
    store.getState().receive(flying(1000, -4.7), 10)
    const takeoff = () => store.getState().tracks.get('SOTESTDOCK01/SOTESTUAV001')?.takeoff
    expect(takeoff()).toEqual({ latitudeDeg: 41.65, longitudeDeg: -4.7, estimated: true })
    store.getState().receive(sample(1200), 20)
    store.getState().receive(flying(1400, -4.71), 30)
    expect(takeoff()).toEqual({ latitudeDeg: 41.65, longitudeDeg: -4.72, estimated: false })
  })

  it('leaves the other aircraft as they were, so they do not draw again', () => {
    const store = createTelemetryStore()
    store.getState().receive(sample(1000, 'A1'), 10)
    const first = store.getState().tracks.get('SOTESTDOCK01/A1')
    store.getState().receive(sample(1000, 'A2'), 10)
    expect(store.getState().tracks.get('SOTESTDOCK01/A1')).toBe(first)
    store.getState().clear()
    expect(store.getState().tracks.size).toBe(0)
  })
})

describe("the console's delivery p95 (NFR-PERF-01)", () => {
  const WALL = 1_790_800_100_000

  /** A sample taken at `takenAtMs` and broadcast `deliveryMs` before `WALL`. */
  function broadcast(takenAtMs: number, deliveryMs: number): TelemetrySample {
    return { ...sample(takenAtMs), sentAtMs: WALL - deliveryMs }
  }

  it('is null before any sample', () => {
    const store = createTelemetryStore(() => WALL)
    expect(store.getState().deliveryP95()).toBeNull()
  })

  it('takes the nearest rank: 1 to 100 ms, in any order, gives 95 ms', () => {
    const store = createTelemetryStore(() => WALL)
    for (let taken = 1; taken <= 100; taken += 1) {
      store.getState().receive(broadcast(taken, 101 - taken), taken)
    }
    expect(store.getState().deliveryP95()).toBe(95)
  })

  it('takes the 19th of 20 deliveries, the rank ceil(0.95 * 20), not the 20th', () => {
    const store = createTelemetryStore(() => WALL)
    for (let taken = 1; taken <= 20; taken += 1) {
      store.getState().receive(broadcast(taken, taken), taken)
    }
    expect(store.getState().deliveryP95()).toBe(19)
  })

  it('measures each kept sample from its broadcast to the wall clock', () => {
    const store = createTelemetryStore(() => WALL)
    store.getState().receive(broadcast(1, 37), 0)
    expect(store.getState().deliveryP95()).toBe(37)
  })

  it('does not measure a sample it drops as older', () => {
    const store = createTelemetryStore(() => WALL)
    store.getState().receive(broadcast(200, 10), 0)
    store.getState().receive(broadcast(100, 1000), 0)
    expect(store.getState().deliveryP95()).toBe(10)
  })

  it('keeps the last 600 measurements and no more', () => {
    const store = createTelemetryStore(() => WALL)
    let taken = 0
    const receiveDelivery = (deliveryMs: number) => {
      taken += 1
      store.getState().receive(broadcast(taken, deliveryMs), taken)
    }
    // 601 deliveries: a slow one, then 570 fast, then 30 slow. Only the last 600 count, so 30
    // are slow and the 570th smallest, the p95, is fast. A window of 599 or 601 would be slow.
    receiveDelivery(1000)
    for (let i = 0; i < 570; i += 1) receiveDelivery(1)
    for (let i = 0; i < 30; i += 1) receiveDelivery(1000)
    expect(store.getState().deliveryP95()).toBe(1)
  })

  it("reads the browser's clock by default", () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(WALL)
    try {
      const store = createTelemetryStore()
      store.getState().receive(broadcast(1, 25), 0)
      expect(store.getState().deliveryP95()).toBe(25)
    } finally {
      now.mockRestore()
    }
  })

  it('keeps each store its own deliveries, so no module holds them (ADR-0022)', () => {
    const first = createTelemetryStore(() => WALL)
    const second = createTelemetryStore(() => WALL)
    first.getState().receive(broadcast(1, 25), 0)
    expect(first.getState().deliveryP95()).toBe(25)
    expect(second.getState().deliveryP95()).toBeNull()
  })

  it('measures each organization apart: clearing the store empties its deliveries', () => {
    const store = createTelemetryStore(() => 10_000)
    store.getState().receive({ ...sample(1000), sentAtMs: 10_000 - 400 }, 1)
    expect(store.getState().deliveryP95()).toBe(400)
    store.getState().clear()
    expect(store.getState().deliveryP95()).toBeNull()
    store.getState().receive({ ...sample(2000), sentAtMs: 10_000 - 30 }, 2)
    expect(store.getState().deliveryP95()).toBe(30)
  })

  it('counts a sample held up by a cut from when it was due, so it never reads as live (FR-SAF-02)', () => {
    // The browser's clock a minute ahead of the mini-PC's: the offset cancels out.
    const AHEAD_MS = 60_000
    let wall = 0
    const store = createTelemetryStore(() => wall + AHEAD_MS)
    const due = (takenAtMs: number) => {
      store.getState().receive(sample(takenAtMs), wall)
      return store.getState().tracks.get('SOTESTDOCK01/SOTESTUAV001')?.latest.dueAt
    }
    // On time: 5 ms after soc-cloud sent each, so due as it arrives.
    wall = 1009
    expect(due(1005 - 4)).toBe(1009)
    wall = 1209
    expect(due(1205 - 4)).toBe(1209)
    // An 8 s cut held what was sent meanwhile, delivered at once when it ended: each is
    // due when it was sent, 5 ms later, however late it arrived.
    wall = 9209
    expect([due(1405 - 4), due(5205 - 4), due(9205 - 4)]).toEqual([1409, 5209, 9209])
  })

  it('takes the usual transit over the last 30 s, so a cut leaves it as it was', () => {
    const least = slidingMinimum(TRANSIT_WINDOW_MS)
    expect([least(0, 7), least(100, 5), least(200, 9)]).toEqual([7, 5, 5])
    expect(least(25_000, 8000)).toBe(5)
    // Thirty seconds on, 5 is gone: the least since is the usual transit now.
    expect(least(30_150, 9)).toBe(9)
    expect(least(30_300, 6)).toBe(6)
  })
})
