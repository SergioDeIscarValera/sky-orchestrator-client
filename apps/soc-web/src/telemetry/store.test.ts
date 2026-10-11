// @vitest-environment node
import { createTelemetryStore } from './store'
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
    const store = createTelemetryStore()
    store.getState().receive(sample(1000), 10)
    store.getState().receive(sample(1200), 210)
    const track = store.getState().tracks.get('SOTESTDOCK01/SOTESTUAV001')
    expect(track?.latest).toEqual({ sample: sample(1200), receivedAt: 210 })
    expect(track?.previous).toEqual({ sample: sample(1000), receivedAt: 10 })
  })

  it('drops a sample the aircraft took no later than the latest, so a track never runs back', () => {
    const store = createTelemetryStore()
    store.getState().receive(sample(1200), 10)
    const before = store.getState()
    store.getState().receive(sample(1000), 20)
    store.getState().receive(sample(1200), 30)
    expect(store.getState()).toBe(before)
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
})
