// @vitest-environment node
import { readFileSync } from 'node:fs'

import { Box3, CircleGeometry, Color, Matrix4, Mesh, Raycaster, Vector3 } from 'three'

import type { TelemetrySample } from '../telemetry/sample'
import { takeoffAfter, type Track } from '../telemetry/store'
import { SITE } from '../test/site'
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
  restOnGround,
  screenScale,
  takeoffLevel,
  writeAircraft,
  type Drawn,
} from './aircraft'
import { FIELD_OF_VIEW_DEG } from './camera'
import type { ScenePalette } from './palette'
import { groundOf, type Ground } from './terrain'

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
  const samples = previous === null ? [sample(latest)] : [sample(previous), sample(latest)]
  return {
    latest: { sample: sample(latest), receivedAt: latestAt },
    previous: previous === null ? null : { sample: sample(previous), receivedAt: previousAt },
    takeoff: samples.reduce(takeoffAfter, null),
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

describe('an aircraft over the terrain (FR-SCN-04, ADR-0014)', () => {
  const ground = groundOf(SITE)
  /** Metres east and north of the farm, as a sample's latitude and longitude. */
  const at = (eastM: number, northM: number) => ({
    longitudeDeg: FARM.longitudeDeg + eastM / 83_300,
    latitudeDeg: FARM.latitudeDeg + northM / 111_000,
  })

  it('flies its height above the ground at its takeoff point, not above the ground under it', () => {
    // Took off 50 m west and 50 m north, 5 m above the origin; now over ground 5 m below it.
    const flight = track(
      { ...at(-50, 50), modeCode: 0, heightM: 0 },
      { ...at(50, -50), heightM: 30 },
    )
    expect(takeoffLevel(flight, FARM, ground)).toBeCloseTo(5, 1)
    const drawn = drawnAt(flight, FARM, 1000, THRESHOLDS, ground)
    expect(drawn?.placement.y).toBeCloseTo(35, 1)
    expect(drawn?.placement.groundY).toBeCloseTo(-5, 1)
  })

  it('never draws under the ground beneath it, and stands on it idle or without a height', () => {
    const takeoff = 5
    const over = (changes: Partial<TelemetrySample>) =>
      placement(FARM, sample({ ...at(-90, 90), ...changes }), ground, takeoff)
    // The ground 90 m west and 90 m north is 9 m above the origin, above the takeoff level.
    expect(over({ heightM: 2 })?.y).toBeCloseTo(9, 1)
    expect(over({ heightM: 30, modeCode: 0 })?.y).toBeCloseTo(9, 1)
    expect(over({ heightM: null })?.y).toBeCloseTo(9, 1)
    expect(over({ heightM: 30 })?.y).toBeCloseTo(35, 1)
  })

  it('guesses its takeoff under where it was first seen flying, and learns it once idle', () => {
    let takeoff = takeoffAfter(null, sample({ ...at(80, -80), modeCode: 5 }))
    expect(takeoff).toMatchObject({ estimated: true })
    takeoff = takeoffAfter(takeoff, sample({ ...at(-80, 80), modeCode: 5 }))
    expect(takeoff?.longitudeDeg).toBeCloseTo(at(80, -80).longitudeDeg, 9)
    takeoff = takeoffAfter(takeoff, sample({ ...at(-80, 80), modeCode: 0 }))
    expect(takeoff).toMatchObject({ ...at(-80, 80), estimated: false })
    expect(takeoffAfter(takeoff, sample({ latitudeDeg: null, modeCode: 0 }))).toBe(takeoff)
  })

  it('glides above a ridge crossed between two samples', () => {
    // A ridge 20 m high along the north-south line through the origin.
    const ridge: Ground = (x) => Math.max(0, 20 - Math.abs(x))
    const glide = track({ ...at(-30, 0), heightM: 5 }, { ...at(30, 0), heightM: 5 }, 1000, 1200)
    const halfway = drawnAt(glide, FARM, 1300, THRESHOLDS, ridge)
    expect(halfway?.placement.x).toBeCloseTo(0, 0)
    expect(halfway?.placement.groundY).toBeCloseTo(20, 0)
    expect(halfway?.placement.y).toBeGreaterThanOrEqual(halfway?.placement.groundY ?? Infinity)
  })

  it('lays its disc on the slope under it, above the ground across its whole span', () => {
    const disc = new Mesh(new CircleGeometry(4, 32).rotateX(-Math.PI / 2))
    restOnGround(disc, ground, 20, -20, 4)
    disc.updateMatrixWorld()
    // The ground rises 1 m every 20 m west and every 20 m north: the disc's face leans
    // downhill, south-east, as the slope's own normal does.
    const up = new Vector3(0, 1, 0).applyQuaternion(disc.quaternion)
    expect(up.angleTo(new Vector3(0.05, 1, 0.05).normalize())).toBeLessThan(1e-6)
    const position = disc.geometry.getAttribute('position')
    for (let index = 0; index < position.count; index += 1) {
      const vertex = new Vector3()
        .fromBufferAttribute(position, index)
        .applyMatrix4(disc.matrixWorld)
      expect(vertex.y).toBeGreaterThan(ground(vertex.x, vertex.z))
    }
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
      placement: { x, y: 25, z: 0, yawRad: 0, groundY: 0 },
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
      'D/stale',
    )
    expect(parts.group.children).toHaveLength(5)
    expect(parts.ring.visible).toBe(true)
    expect(Math.round(parts.ring.position.x)).toBe(50)
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
    writeAircraft(parts, [], { x: 0, y: 300, z: 300 }, FIELD_OF_VIEW_DEG, 900, PALETTE, 'D/stale')
    expect(parts.ring.visible).toBe(false)
    disposeAircraft(parts)
  })
})

describe('picking an aircraft (FR-SCN-05)', () => {
  it('finds the aircraft under the pointer wherever it has flown, and only the aircraft', () => {
    const parts = createAircraftParts(8)
    const drawn = (x: number, z: number): Drawn => ({
      placement: { x, y: 30, z, yawRad: 0, groundY: 0 },
      freshness: 'live',
      gliding: false,
    })
    const hits = (x: number, z: number) => {
      const ray = new Raycaster(new Vector3(x, 500, z), new Vector3(0, -1, 0))
      return ray.intersectObject(parts.group, true).map((hit) => [hit.object.name, hit.instanceId])
    }
    const camera = { x: 0, y: 300, z: 300 }
    writeAircraft(parts, [], camera, FIELD_OF_VIEW_DEG, 900, PALETTE)
    expect(hits(0, 0)).toEqual([])
    writeAircraft(
      parts,
      [{ key: 'D/a', drawn: drawn(0, 0) }],
      camera,
      FIELD_OF_VIEW_DEG,
      900,
      PALETTE,
    )
    expect(hits(0, 0)[0]).toEqual(['aircraft', 0])
    writeAircraft(
      parts,
      [
        { key: 'D/a', drawn: drawn(400, -300) },
        { key: 'D/b', drawn: drawn(-200, 100) },
      ],
      camera,
      FIELD_OF_VIEW_DEG,
      900,
      PALETTE,
    )
    expect(hits(400, -300).some(([name, instance]) => name === 'aircraft' && instance === 0)).toBe(
      true,
    )
    expect(hits(-200, 100).some(([name, instance]) => name === 'aircraft' && instance === 1)).toBe(
      true,
    )
    expect(hits(0, 0)).toEqual([])
    disposeAircraft(parts)
  })
})
