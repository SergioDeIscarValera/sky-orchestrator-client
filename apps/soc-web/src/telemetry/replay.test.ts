// @vitest-environment node
import { eastNorth } from '../geometry/projection'
import { CIRCLING_FROM_S, REPLAY, replaySample } from './replay'
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
    const circling = CIRCLING_FROM_S * REPLAY.rateHz
    const a = replaySample(FARM, circling + 10, 0)
    const b = replaySample(FARM, circling + 11, 0)
    const step = eastNorth(
      { latitudeDeg: a.latitudeDeg ?? NaN, longitudeDeg: a.longitudeDeg ?? NaN },
      { latitudeDeg: b.latitudeDeg ?? NaN, longitudeDeg: b.longitudeDeg ?? NaN },
    )
    expect(Math.hypot(step.eastM, step.northM)).toBeCloseTo(REPLAY.speedMs / REPLAY.rateHz, 1)
    expect(b.takenAtMs - a.takenAtMs).toBe(200)
  })

  it('stands idle, takes off straight up, then circles at its height', () => {
    const at = (seconds: number) => replaySample(FARM, Math.round(seconds * REPLAY.rateHz), 0)
    expect(at(0)).toMatchObject({ modeCode: 0, heightM: 0, homeDistanceM: 0 })
    expect(at(REPLAY.idleS - 0.2)).toMatchObject({ modeCode: 0, heightM: 0 })
    expect(at(REPLAY.idleS + 1)).toMatchObject({ modeCode: 4, heightM: REPLAY.climbMs })
    expect(at(REPLAY.idleS + 1).latitudeDeg).toBe(at(0).latitudeDeg)
    expect(at(CIRCLING_FROM_S)).toMatchObject({ modeCode: 5, heightM: REPLAY.heightM })
    const half = CIRCLING_FROM_S + (Math.PI * REPLAY.radiusM) / REPLAY.speedMs
    expect(at(half).homeDistanceM).toBeCloseTo(2 * REPLAY.radiusM, 0)
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
