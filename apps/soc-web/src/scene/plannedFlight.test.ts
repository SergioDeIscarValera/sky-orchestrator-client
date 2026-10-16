// @vitest-environment node
import type { Assignment, Wayline } from '../backend/backend'
import { bake, type Design } from '../geometry/bake'
import { flightToJson } from '../geometry/designJson'
import { planFlight } from '../geometry/flight'
import { eastNorth, geodeticAt, type Geodetic } from '../geometry/projection'
import { draftOf } from '../plans/waylines'
import { assignedPath, designedPath, plannedPath, takeoffOf } from './plannedFlight'
import { FLAT_SITE } from './site'

const FARM: Geodetic = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
const at = (eastM: number, northM: number): Geodetic => geodeticAt(FARM, { eastM, northM })

const DESIGN: Design = {
  takeoff: at(0, 0),
  defaultHeightM: 30,
  primitives: [{ kind: 'route', points: [at(0, 50), at(100, 50)] }],
}
const BAKED = bake(DESIGN, { origin: FARM, maxArcSpacingM: 10 })

/** The flight the operation stores: a climb to 30 m over the takeoff, then the corridor at 10 m/s. */
const PLANNED = planFlight(DESIGN.takeoff, BAKED, {
  origin: FARM,
  takeoffSecurityHeightM: 30,
  speedMs: 10,
  finishAction: 'return_home',
  envelope: null,
})

function assignmentWith(flight: Assignment['flight'], fleetId = 'fleet-1'): Assignment {
  return {
    id: 'assignment-1',
    operationId: 'operation-1',
    waylineId: 'wayline-1',
    fleetId,
    speedMs: 10,
    flight,
  }
}

describe('the planned flight an assignment stores, as the scene draws it (FR-OPS-07)', () => {
  it('draws the climb to the takeoff security height, then each waypoint at its height over the takeoff', () => {
    const path = plannedPath(assignmentWith(flightToJson(PLANNED)), FARM, FLAT_SITE)
    expect(path).not.toBeNull()
    // The takeoff on the ground, the climb above it, then one place per waypoint, in order.
    expect(path?.points).toHaveLength(2 + PLANNED.waypoints.length)
    expect(path?.points[0]?.[1]).toBeCloseTo(0, 6)
    expect(path?.points[1]?.[1]).toBeCloseTo(30, 6)
    expect(path?.waypoints).toHaveLength(PLANNED.waypoints.length)
    for (const [index, waypoint] of PLANNED.waypoints.entries()) {
      const drawn = path?.waypoints[index]
      expect(drawn?.[1]).toBeCloseTo(waypoint.heightM, 6)
      expect(drawn?.[0]).toBeCloseTo(eastNorth(FARM, waypoint).eastM, 3)
    }
  })

  it('draws nothing where the assignment stores no flight, or one the console cannot read', () => {
    expect(plannedPath(assignmentWith(null), FARM, FLAT_SITE)).toBeNull()
    expect(plannedPath(assignmentWith({ waypoints: 'not a flight' }), FARM, FLAT_SITE)).toBeNull()
  })

  it("takes a fleet's takeoff from the reference point of its planned flight, and none without one", () => {
    const stored = assignmentWith(flightToJson(PLANNED), 'fleet-1')
    const takeoff = takeoffOf('fleet-1', [stored])
    expect(takeoff?.latitudeDeg).toBeCloseTo(DESIGN.takeoff.latitudeDeg, 9)
    expect(takeoff?.longitudeDeg).toBeCloseTo(DESIGN.takeoff.longitudeDeg, 9)
    expect(takeoffOf('fleet-2', [stored])).toBeNull()
    expect(takeoffOf('fleet-1', [assignmentWith(null, 'fleet-1')])).toBeNull()
  })
})

describe('where an assignment flies, as the scene draws it (FR-SCN-04)', () => {
  const WAYLINE: Wayline = {
    ...draftOf('North corridor', DESIGN, BAKED),
    id: 'wayline-1',
    createdAt: '2026-10-11T10:00:00Z',
    updatedAt: '2026-10-11T10:00:00Z',
  }

  it('draws a saved wayline from its takeoff straight to its waypoints, with no climb before them', () => {
    const path = designedPath(WAYLINE, FARM, FLAT_SITE)
    expect(path.points).toHaveLength(1 + BAKED.waypoints.length)
    expect(path.waypoints).toHaveLength(BAKED.waypoints.length)
    for (const [index, waypoint] of BAKED.waypoints.entries()) {
      expect(path.waypoints[index]?.[1]).toBeCloseTo(waypoint.heightM, 6)
    }
  })

  it('draws the stored planned flight when there is one, whatever the wayline is', () => {
    const assignment = assignmentWith(flightToJson(PLANNED))
    expect(assignedPath(assignment, [WAYLINE], FARM, FLAT_SITE)).toEqual(
      plannedPath(assignment, FARM, FLAT_SITE),
    )
    expect(assignedPath(assignment, [], FARM, FLAT_SITE)).toEqual(
      plannedPath(assignment, FARM, FLAT_SITE),
    )
  })

  it('draws the assigned wayline as designed until a flight is stored, or while it cannot be read', () => {
    const designed = designedPath(WAYLINE, FARM, FLAT_SITE)
    expect(assignedPath(assignmentWith(null), [WAYLINE], FARM, FLAT_SITE)).toEqual(designed)
    expect(
      assignedPath(assignmentWith({ waypoints: 'not a flight' }), [WAYLINE], FARM, FLAT_SITE),
    ).toEqual(designed)
  })

  it('draws nothing with no stored flight and its wayline not read, or not there', () => {
    expect(assignedPath(assignmentWith(null), [], FARM, FLAT_SITE)).toBeNull()
    expect(
      assignedPath(assignmentWith(null), [{ ...WAYLINE, id: 'wayline-2' }], FARM, FLAT_SITE),
    ).toBeNull()
  })
})
