// @vitest-environment node
import { eastNorth } from '../geometry/projection'
import {
  CIRCLING_FROM_S,
  MOST_REPLAYED,
  REPLAY,
  replayCount,
  replaySample,
  replaySerials,
  startReplay,
} from './replay'
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

  it('flies as many aircraft as asked, at most four, spread evenly round the circle', () => {
    expect([null, '', 'x', '0', '-2', '1.5', '1', '2', '9'].map(replayCount)).toEqual([
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      2,
      MOST_REPLAYED,
    ])
    expect(replaySerials(0)).toEqual({ gatewaySn: 'REPLAYDOCK', aircraftSn: 'REPLAYUAV' })
    expect(replaySerials(1)).toEqual({ gatewaySn: 'REPLAYDOCK2', aircraftSn: 'REPLAYUAV2' })
    const where = (sample: ReturnType<typeof replaySample>) =>
      eastNorth(FARM, {
        latitudeDeg: sample.latitudeDeg ?? NaN,
        longitudeDeg: sample.longitudeDeg ?? NaN,
      })
    // Two aircraft take off from opposite points of the circle and keep apart.
    for (const index of [0, CIRCLING_FROM_S * REPLAY.rateHz + 40]) {
      const first = where(replaySample(FARM, index, 0, 0, 2))
      const second = where(replaySample(FARM, index, 0, 1, 2))
      expect(Math.hypot(first.eastM - second.eastM, first.northM - second.northM)).toBeCloseTo(
        2 * REPLAY.radiusM,
        1,
      )
    }
    expect(replaySample(FARM, 0, 0, 1, 2).homeDistanceM).toBe(0)
  })

  it('feeds every aircraft it flies into the store at each tick', () => {
    vi.useFakeTimers()
    try {
      const store = createTelemetryStore()
      const stop = startReplay(store, FARM, 2)
      vi.advanceTimersByTime(1000 / REPLAY.rateHz)
      expect([...store.getState().tracks.keys()].sort()).toEqual([
        'REPLAYDOCK/REPLAYUAV',
        'REPLAYDOCK2/REPLAYUAV2',
      ])
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps to the rules of the store', () => {
    const store = createTelemetryStore()
    store.getState().receive(replaySample(FARM, 1, 0), 1)
    store.getState().receive(replaySample(FARM, 0, 0), 2)
    expect(store.getState().tracks.get('REPLAYDOCK/REPLAYUAV')?.latest.receivedAt).toBe(1)
  })
})
