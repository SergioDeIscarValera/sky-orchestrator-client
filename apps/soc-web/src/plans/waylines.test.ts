// @vitest-environment node
import type { Wayline } from '../backend/backend'
import { bake, type Design } from '../geometry/bake'
import { geodeticAt, type Geodetic } from '../geometry/projection'
import {
  climbOf,
  designingOf,
  draftOf,
  formatDuration,
  ownHeightOf,
  primitiveSummary,
} from './waylines'

const FARM: Geodetic = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
const at = (east: number, north: number) => geodeticAt(FARM, { eastM: east, northM: north })

const DESIGN: Design = {
  takeoff: at(0, 0),
  defaultHeightM: 30,
  takeoffSecurityHeightM: 20,
  speedMs: 5,
  finishAction: 'land',
  primitives: [{ kind: 'route', points: [at(0, 50), { ...at(100, 50), heightM: 40 }] }],
}
const baked = bake(DESIGN, { origin: FARM, maxArcSpacingM: 10, envelope: null })

function saved(draft: ReturnType<typeof draftOf>): Wayline {
  return {
    ...draft,
    id: 'w1',
    createdAt: '2026-10-12T10:00:00Z',
    updatedAt: '2026-10-12T10:00:00Z',
  }
}

describe('a wayline saved by the designer (FR-WAY-09, IR-WAY-01)', () => {
  it('saves the design as the schema writes it and the bake as baked, by its version', () => {
    const draft = draftOf('  North corridor ', DESIGN, baked)
    expect(draft).toMatchObject({
      name: 'North corridor',
      takeoff: at(0, 0),
      defaultHeightM: 30,
      speedMs: 5,
      metrics: { waypointCount: 2, distanceM: baked.distanceM, durationS: baked.durationS },
      bakeVersion: '1.0.0',
    })
    // The bake's own points, through the local frame and back: a hair off the drawn ones.
    expect(draft.waypoints.map(({ index, heightM }) => [index, heightM])).toEqual([
      [0, 30],
      [1, 40],
    ])
    expect(draft.waypoints[1]?.position.latitudeDeg).toBeCloseTo(at(100, 50).latitudeDeg, 9)
    expect(draft.waypoints[1]?.position.longitudeDeg).toBeCloseTo(at(100, 50).longitudeDeg, 9)
    expect(draft.design).toMatchObject({ finish_action: 'land', takeoff_security_height_m: 20 })
  })

  it('opens a saved one with the design it was saved with', () => {
    const designing = designingOf(saved(draftOf('North corridor', DESIGN, baked)))
    expect(designing).toMatchObject({ waylineId: 'w1', tool: null })
    expect(designing.sketch).toEqual({
      name: 'North corridor',
      takeoff: DESIGN.takeoff,
      defaultHeightM: 30,
      speedMs: 5,
      takeoffSecurityHeightM: 20,
      finishAction: 'land',
      primitives: DESIGN.primitives,
    })
    expect(climbOf(saved(draftOf('North corridor', DESIGN, baked)))).toBe(20)
  })

  it('writes nothing the schema refuses, naming where', () => {
    const lonely: Design = { ...DESIGN, primitives: [{ kind: 'route', points: [at(0, 50)] }] }
    expect(() => draftOf('North corridor', lonely, baked)).toThrow(/primitives\[0\]\.points/)
  })

  it('refuses to open a design that does not read, and draws no climb for it', () => {
    const broken = { ...saved(draftOf('North corridor', DESIGN, baked)), design: {} }
    expect(() => designingOf(broken)).toThrow(/takeoff/)
    expect(climbOf(broken)).toBeNull()
  })
})

describe("a wayline's words", () => {
  it('tells a duration in minutes and seconds', () => {
    expect(formatDuration(42.4)).toBe('42 s')
    expect(formatDuration(65)).toBe('1 min 05 s')
    expect(formatDuration(3599.6)).toBe('60 min 00 s')
  })

  it('names each primitive by its kind and size, and its own height when all its points share it', () => {
    expect(primitiveSummary({ kind: 'route', points: [at(0, 0), at(1, 1)] })).toBe(
      'Route · 2 points',
    )
    expect(primitiveSummary({ kind: 'points', points: [at(0, 0)] })).toBe('Points · 1')
    expect(
      primitiveSummary({
        kind: 'circle',
        centre: at(0, 0),
        radiusM: 30,
        clockwise: true,
        startBearingDeg: 0,
      }),
    ).toBe('Circle · 30 m radius')
    expect(
      primitiveSummary({
        kind: 'grid',
        area: [at(0, 0), at(1, 0), at(0, 1)],
        lineSpacingM: 20,
        pointSpacingM: 10,
      }),
    ).toBe('Grid · 20 m lines')
    expect(
      ownHeightOf({
        kind: 'points',
        points: [
          { ...at(0, 0), heightM: 25 },
          { ...at(1, 1), heightM: 25 },
        ],
      }),
    ).toBe(25)
    expect(
      ownHeightOf({ kind: 'points', points: [{ ...at(0, 0), heightM: 25 }, at(1, 1)] }),
    ).toBeNull()
    expect(
      ownHeightOf({
        kind: 'circle',
        centre: at(0, 0),
        radiusM: 30,
        clockwise: true,
        startBearingDeg: 0,
      }),
    ).toBeNull()
  })
})
