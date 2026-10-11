// @vitest-environment node
import { eastNorth } from '../geometry/projection'
import { REPLAY, replaySample } from './replay'
import { createTelemetryStore } from './store'

const FARM = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }

describe('the development replay', () => {
  it('flies a circle of its radius around the origin, at its speed, within a few centimetres', () => {
    for (const index of [0, 7, 50, 300]) {
      const sample = replaySample(FARM, index, 0)
      const placed = eastNorth(FARM, {
        latitudeDeg: sample.latitudeDeg ?? NaN,
        longitudeDeg: sample.longitudeDeg ?? NaN,
      })
      expect(Math.hypot(placed.eastM, placed.northM)).toBeCloseTo(REPLAY.radiusM, 1)
    }
    const a = replaySample(FARM, 10, 0)
    const b = replaySample(FARM, 11, 0)
    const step = eastNorth(
      { latitudeDeg: a.latitudeDeg ?? NaN, longitudeDeg: a.longitudeDeg ?? NaN },
      { latitudeDeg: b.latitudeDeg ?? NaN, longitudeDeg: b.longitudeDeg ?? NaN },
    )
    expect(Math.hypot(step.eastM, step.northM)).toBeCloseTo(REPLAY.speedMs / REPLAY.rateHz, 1)
    expect(b.takenAtMs - a.takenAtMs).toBe(200)
  })

  it('heads along the circle, counter-clockwise seen from above', () => {
    expect(replaySample(FARM, 0, 0).headingDeg).toBeCloseTo(0, 6)
  })

  it('keeps to the rules of the store', () => {
    const store = createTelemetryStore()
    store.getState().receive(replaySample(FARM, 1, 0), 1)
    store.getState().receive(replaySample(FARM, 0, 0), 2)
    expect(store.getState().tracks.get('REPLAYDOCK/REPLAYUAV')?.latest.receivedAt).toBe(1)
  })
})
