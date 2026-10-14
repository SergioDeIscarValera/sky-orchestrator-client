// @vitest-environment node
import type { Flight, TrackPoint } from '../backend/backend'
import { eastNorth, geodeticAt, type Geodetic } from '../geometry/projection'
import { FakeBackend, NORTH, PILOT } from '../test/FakeBackend'
import { recordings } from '../test/recordings'
import type { TelemetrySample } from '../telemetry/sample'
import { FLAT_GROUND, type Ground } from './site'
import { liveAfter, trackSpots, type TrackFrame } from './track'

const FARM: Geodetic = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
const START = Date.parse('2026-10-11T10:10:00Z')
const at = (eastM: number, northM: number): Geodetic => geodeticAt(FARM, { eastM, northM })

/** A stored sample taken `second` seconds after the start, `heightM` above the takeoff point. */
function stored(second: number, eastM: number, northM: number, heightM: number): TrackPoint {
  return {
    sampledAt: new Date(START + second * 1000).toISOString(),
    position: at(eastM, northM),
    heightM,
  }
}

/** A sample the telemetry store holds: taken `second` seconds after the start, in flight. */
function live(
  second: number,
  eastM: number,
  northM: number,
  heightM: number | null,
): TelemetrySample {
  const position = at(eastM, northM)
  return {
    stack: 'lab',
    gatewaySn: 'SOTESTDOCK01',
    aircraftSn: 'SOTESTUAV001',
    takenAtMs: START + second * 1000,
    sentAtMs: START + second * 1000 + 40,
    latitudeDeg: position.latitudeDeg,
    longitudeDeg: position.longitudeDeg,
    heightM,
    headingDeg: 0,
    homeDistanceM: 0,
    batteryPct: 90,
    satellites: 14,
    gpsQuality: 5,
    modeCode: 2,
  }
}

/** A frame with the farm as origin, its takeoff at `takeoff`, and the ground `ground`. */
function frame(ground: Ground = FLAT_GROUND, takeoff: Geodetic = FARM): TrackFrame {
  return { origin: FARM, ground, takeoff }
}

describe('a flight drawn as its track on the local frame (FR-SCN-04, FR-TEL-05)', () => {
  it('draws each stored sample where it was taken, on the local frame, in time order', () => {
    const points = [stored(0, 0, 0, 0), stored(1, 10, 5, 20), stored(2, -20, 30, 35)]
    const spots = trackSpots(frame(), points, [])
    expect(spots).toHaveLength(3)
    for (const [index, point] of points.entries()) {
      const { eastM, northM } = eastNorth(FARM, point.position)
      expect(spots[index]?.[0]).toBeCloseTo(eastM, 6)
      expect(spots[index]?.[2]).toBeCloseTo(-northM, 6)
    }
  })

  it('holds each vertex over the ground at its takeoff plus its height, never under the ground beneath', () => {
    // The ground rises a metre every ten metres eastward: at 100 m east it is 10 m high.
    const ground: Ground = (x) => x / 10
    const spots = trackSpots(
      frame(ground),
      [stored(0, 100, 0, 5), stored(1, 0, 0, 5), stored(2, 100, 0, 30)],
      [],
    )
    for (const [index, expected] of [10, 5, 30].entries()) {
      expect(spots[index]?.[1]).toBeCloseTo(expected, 6)
    }
  })

  it("measures each height from the ground at the takeoff point, not the origin's", () => {
    const ground: Ground = (x) => x / 10
    // The takeoff stands 5 m above the origin's level, so a sample 10 m above it is 15 m up.
    const spots = trackSpots(frame(ground, at(50, 0)), [stored(0, 0, 0, 10)], [])
    expect(spots[0]?.[1]).toBeCloseTo(15, 9)
  })

  it('appends the live samples after the last stored point, in time order, and none before it', () => {
    const points = [stored(0, 0, 0, 0), stored(1, 10, 0, 10)]
    const samples = [
      live(-1, 99, 99, 9),
      live(3, 30, 0, 30),
      live(1, 10, 0, 10),
      live(2, 20, 0, 20),
    ]
    const spots = trackSpots(frame(), points, samples)
    expect(spots).toHaveLength(4)
    // The two live samples after the stored point, in time order; the one at the stored point and
    // the one before it are not drawn, and the track ends at the newest sample.
    expect(spots.slice(2).map(([x]) => Math.round(x))).toEqual([20, 30])
    expect(spots.slice(2).map(([, y]) => y)).toEqual([20, 30])
    expect(liveAfter(points, samples).map(({ takenAtMs }) => takenAtMs)).toEqual([
      START + 2000,
      START + 3000,
    ])
  })

  it('draws a live sample without a position not at all', () => {
    const unplaced = { ...live(4, 40, 0, 40), latitudeDeg: null, longitudeDeg: null }
    expect(trackSpots(frame(), [stored(0, 0, 0, 0)], [unplaced])).toHaveLength(1)
  })

  it('draws the live samples alone while no sample is stored yet', () => {
    const spots = trackSpots(frame(), [], [live(0, 0, 0, 0), live(1, 10, 0, 12)])
    expect(spots.map(([x, y]) => [Math.round(x), y])).toEqual([
      [0, 0],
      [10, 12],
    ])
  })

  it('draws nothing when there is no stored sample and no live one', () => {
    expect(trackSpots(frame(), [], [])).toEqual([])
  })
})

describe('a track drawn from a replayed flight (FR-TEL-05)', () => {
  it("after a replayed flight, the track's vertices equal the stored samples' positions", async () => {
    // The recording's samples in time order, kept as the database keeps them: one row a moment,
    // each with a position and a height, as soc-cloud wrote them into soc.telemetry_samples.
    const replayed = recordings().get('2026-10-12-dock-flight-and-cut.jsonl') ?? []
    const stored: TrackPoint[] = []
    let last = Number.NEGATIVE_INFINITY
    for (const { sample } of replayed) {
      const { latitudeDeg, longitudeDeg, heightM, takenAtMs } = sample
      if (latitudeDeg === null || longitudeDeg === null || heightM === null) continue
      if (takenAtMs <= last) continue
      last = takenAtMs
      stored.push({
        sampledAt: new Date(takenAtMs).toISOString(),
        position: { latitudeDeg, longitudeDeg },
        heightM,
      })
    }
    expect(stored.length).toBeGreaterThan(300)

    const backend = new FakeBackend(PILOT)
    const operation = await backend.createOperation(NORTH.id, {
      name: 'Replayed flight',
      geofenceId: null,
      takeoffSecurityHeightM: null,
    })
    const flight: Flight = {
      id: '88888888-8888-4888-8888-888888888888',
      operationId: operation.id,
      mode: 'real',
      fleetId: '33333333-3333-4333-8333-333333333333',
      gatewaySn: 'SOTESTDOCK01',
      aircraftSn: 'SOTESTUAV001',
      preparedAt: new Date(START).toISOString(),
      executedAt: null,
      tookOffAt: null,
      landedAt: null,
      endedAt: null,
      endReason: null,
      breachedAt: null,
    }
    backend.addFlight(flight)
    backend.addTrackPoints(flight.id, stored)

    const read = await backend.track(flight.id)
    expect(read).toEqual(stored)
    const spots = trackSpots(frame(), read, [])
    expect(spots).toHaveLength(stored.length)
    for (const [index, point] of read.entries()) {
      const { eastM, northM } = eastNorth(FARM, point.position)
      const spot = spots[index]
      // Within 0.1 m of the stored position on the local frame (FR-SCN-04); on the flat ground the
      // height is the stored one, never under the ground.
      expect(Math.abs((spot?.[0] ?? Number.NaN) - eastM)).toBeLessThan(0.1)
      expect(Math.abs((spot?.[2] ?? Number.NaN) + northM)).toBeLessThan(0.1)
      expect(spot?.[1]).toBeCloseTo(Math.max(0, point.heightM), 9)
    }
  })
})
