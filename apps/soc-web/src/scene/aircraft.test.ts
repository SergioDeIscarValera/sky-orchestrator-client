// @vitest-environment node
import { readFileSync } from 'node:fs'

import { Box3, Color, Matrix4, Vector3 } from 'three'

import type { TelemetrySample } from '../telemetry/sample'
import type { Track } from '../telemetry/store'
import {
  MAX_GLIDE_MS,
  MIN_SPAN_PX,
  SPAN_M,
  createAircraftGeometry,
  createAircraftParts,
  disposeAircraft,
  drawnAt,
  paintAircraft,
  placement,
  screenScale,
  writeAircraft,
  type Drawn,
} from './aircraft'
import { FIELD_OF_VIEW_DEG } from './camera'
import type { ScenePalette } from './palette'

const FARM = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
const THRESHOLDS = { telemetryStaleAfterMs: 3000, telemetryLostAfterMs: 10000 }
const PALETTE: ScenePalette = {
  page: 'white',
  ground: 'ivory',
  gridMinor: 'gainsboro',
  gridMajor: 'gray',
  accent: 'teal',
  casing: 'darkslategray',
}

function sample(changes: Partial<TelemetrySample> = {}): TelemetrySample {
  return {
    stack: 'lab',
    gatewaySn: 'SOTESTDOCK01',
    aircraftSn: 'SOTESTUAV001',
    takenAtMs: 0,
    sentAtMs: 0,
    latitudeDeg: FARM.latitudeDeg,
    longitudeDeg: FARM.longitudeDeg,
    heightM: 30,
    headingDeg: 0,
    homeDistanceM: 0,
    batteryPct: 90,
    satellites: 14,
    gpsQuality: 5,
    modeCode: 5,
    ...changes,
  }
}

function track(
  previous: Partial<TelemetrySample> | null,
  latest: Partial<TelemetrySample>,
  previousAt = 0,
  latestAt = 200,
): Track {
  return {
    latest: { sample: sample(latest), receivedAt: latestAt },
    previous: previous === null ? null : { sample: sample(previous), receivedAt: previousAt },
  }
}

interface Golden {
  readonly origin: { readonly latitude_deg: number; readonly longitude_deg: number }
  readonly point: { readonly latitude_deg: number; readonly longitude_deg: number }
  readonly east_m: number
  readonly north_m: number
  readonly name: string
}

const GOLDEN = (
  JSON.parse(
    readFileSync(
      new URL('../../../../contracts/geometry/projection.json', import.meta.url),
      'utf8',
    ),
  ) as { readonly cases: readonly Golden[] }
).cases.filter(({ name }) => name.startsWith('farm'))

describe('an aircraft in the scene (FR-SCN-04)', () => {
  it.each(GOLDEN.map((golden) => [golden.name, golden] as const))(
    'stands where its latitude, longitude and height put it, within 0.1 m: %s',
    (_name, golden) => {
      const placed = placement(
        { latitudeDeg: golden.origin.latitude_deg, longitudeDeg: golden.origin.longitude_deg },
        sample({
          latitudeDeg: golden.point.latitude_deg,
          longitudeDeg: golden.point.longitude_deg,
          heightM: 42.5,
        }),
      )
      expect(placed).not.toBeNull()
      expect(Math.abs((placed?.x ?? NaN) - golden.east_m)).toBeLessThan(0.1)
      expect(Math.abs((placed?.z ?? NaN) + golden.north_m)).toBeLessThan(0.1)
      expect(placed?.y).toBe(42.5)
    },
  )

  it('points its nose where DJI says it heads, clockwise from north', () => {
    const nose = (headingDeg: number) => {
      const placed = placement(FARM, sample({ headingDeg }))
      const turned = new Vector3(0, 0, -1).applyMatrix4(
        new Matrix4().makeRotationY(placed?.yawRad ?? NaN),
      )
      return [turned.x, turned.z].map((value) => Math.round(value * 1000) / 1000 + 0)
    }
    expect(nose(0)).toEqual([0, -1])
    expect(nose(90)).toEqual([1, 0])
    expect(nose(-90)).toEqual([-1, 0])
    expect(nose(180)).toEqual([0, 1])
  })

  it('stands on the ground below the takeoff level or without a height, and nowhere without a position', () => {
    expect(placement(FARM, sample({ heightM: -0.4 }))?.y).toBe(0)
    expect(placement(FARM, sample({ heightM: null }))?.y).toBe(0)
    expect(placement(FARM, sample({ latitudeDeg: null }))).toBeNull()
  })

  it('is built in code from a body, two arms and four rotors, a span across', () => {
    const geometry = createAircraftGeometry()
    geometry.computeBoundingBox()
    const size = (geometry.boundingBox ?? new Box3()).getSize(new Vector3())
    expect(size.x).toBeGreaterThan(SPAN_M * 0.8)
    expect(size.x).toBeLessThan(SPAN_M * 1.5)
    expect(size.y).toBeLessThan(0.1)
    expect(geometry.getAttribute('position').count).toBeGreaterThan(100)
  })
})

describe('motion between samples (FR-TEL-02)', () => {
  const east = (metres: number) => FARM.longitudeDeg + metres / 83_300

  it('glides from the previous sample to the latest over their interval, then stays', () => {
    const glide = track({ longitudeDeg: east(0) }, { longitudeDeg: east(10) }, 1000, 1200)
    const at = (now: number) => drawnAt(glide, FARM, now, THRESHOLDS)
    expect(at(1200)?.placement.x).toBeCloseTo(0, 3)
    expect(at(1300)?.placement.x).toBeCloseTo(5, 1)
    expect(at(1300)?.gliding).toBe(true)
    expect(at(1400)).toMatchObject({ gliding: false })
    expect(at(1400)?.placement.x).toBeCloseTo(10, 1)
    expect(at(2900)?.placement.x).toBe(at(1400)?.placement.x)
  })

  it('never draws a position past the latest sample, whatever the timing (2,000 cases)', () => {
    let seed = 7
    const random = () => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    for (let step = 0; step < 2000; step += 1) {
      const from = { x: (random() - 0.5) * 2000, z: (random() - 0.5) * 2000 }
      const to = { x: from.x + (random() - 0.5) * 40, z: from.z + (random() - 0.5) * 40 }
      const previousAt = random() * 10_000
      const latestAt = previousAt + random() * 3000
      const glide = track(
        { longitudeDeg: east(from.x), latitudeDeg: FARM.latitudeDeg - from.z / 111_000 },
        { longitudeDeg: east(to.x), latitudeDeg: FARM.latitudeDeg - to.z / 111_000 },
        previousAt,
        latestAt,
      )
      const now = latestAt + (random() - 0.2) * 5000
      const drawn = drawnAt(glide, FARM, now, THRESHOLDS)
      const start = placement(FARM, glide.previous?.sample ?? glide.latest.sample)
      const end = placement(FARM, glide.latest.sample)
      if (drawn === null || start === null || end === null) throw new Error('nothing drawn')
      const along = new Vector3(end.x - start.x, 0, end.z - start.z)
      const travelled = new Vector3(drawn.placement.x - start.x, 0, drawn.placement.z - start.z)
      const share = along.lengthSq() === 0 ? 0 : travelled.dot(along) / along.lengthSq()
      expect(share).toBeGreaterThanOrEqual(-1e-9)
      expect(share).toBeLessThanOrEqual(1 + 1e-9)
      expect(travelled.clone().sub(along.clone().multiplyScalar(share)).length()).toBeLessThan(1e-6)
    }
  })

  it('takes a long gap at most a second to cross, and turns the short way round', () => {
    const late = track({ headingDeg: 170 }, { headingDeg: -170 }, 0, 20_000)
    const halfway = drawnAt(late, FARM, 20_000 + MAX_GLIDE_MS / 2, {
      telemetryStaleAfterMs: 30_000,
      telemetryLostAfterMs: 60_000,
    })
    expect(halfway?.gliding).toBe(true)
    expect(Math.abs(halfway?.placement.yawRad ?? 0)).toBeCloseTo(Math.PI, 3)
  })

  it('is drawn as stale, then lost where it was last known', () => {
    const still = track(null, {}, 0, 0)
    expect(drawnAt(still, FARM, 2999, THRESHOLDS)?.freshness).toBe('live')
    expect(drawnAt(still, FARM, 3000, THRESHOLDS)?.freshness).toBe('stale')
    expect(drawnAt(still, FARM, 10_000, THRESHOLDS)).toMatchObject({ freshness: 'lost' })
  })
})

describe('drawing the aircraft (FR-SCN-04, NFR-RES-01)', () => {
  it('keeps a far aircraft a few dozen pixels across, and a near one its real size', () => {
    expect(screenScale(1, FIELD_OF_VIEW_DEG, 900)).toBe(1)
    const far = screenScale(3000, FIELD_OF_VIEW_DEG, 900)
    const metresPerPixel = (2 * 3000 * Math.tan((FIELD_OF_VIEW_DEG * Math.PI) / 360)) / 900
    expect((SPAN_M * far) / metresPerPixel).toBeCloseTo(MIN_SPAN_PX, 6)
  })

  it('draws the live in the accent, the stale muted, the lost as a disc only, in four draws', () => {
    const parts = createAircraftParts(8)
    paintAircraft(parts, PALETTE)
    const drawn = (x: number, freshness: Drawn['freshness']): Drawn => ({
      placement: { x, y: 25, z: 0, yawRad: 0 },
      freshness,
      gliding: false,
    })
    writeAircraft(
      parts,
      [
        { key: 'D/live', drawn: drawn(0, 'live') },
        { key: 'D/stale', drawn: drawn(50, 'stale') },
        { key: 'D/lost', drawn: drawn(100, 'lost') },
      ],
      { x: 0, y: 300, z: 300 },
      FIELD_OF_VIEW_DEG,
      900,
      PALETTE,
    )
    expect(parts.group.children).toHaveLength(4)
    expect([parts.bodies.count, parts.casings.count, parts.discs.count]).toEqual([2, 2, 3])
    expect(parts.keys).toEqual(['D/live', 'D/stale'])
    const colour = (index: number) => {
      const found = new Color()
      parts.bodies.getColorAt(index, found)
      return found.getHexString()
    }
    expect(colour(0)).not.toEqual(colour(1))
    expect(parts.stalks.geometry.drawRange.count).toBe(4)
    const position = new Vector3()
    const matrix = new Matrix4()
    parts.discs.getMatrixAt(2, matrix)
    expect(position.setFromMatrixPosition(matrix).toArray().map(Math.round)).toEqual([100, 0, 0])
    expect(parts.casings.material.color.getStyle()).toBe(parts.stalks.material.color.getStyle())
    disposeAircraft(parts)
  })
})
