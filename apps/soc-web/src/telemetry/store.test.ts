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
