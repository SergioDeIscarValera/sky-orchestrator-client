import { eastNorth, geodeticAt, type Geodetic } from './projection'

/** The circle tool's drawing (FR-WAY-04): a centre, a radius, where it starts and which way. */
export interface Circle {
  readonly centre: Geodetic
  readonly radiusM: number
  readonly clockwise: boolean
  /** Clockwise from true north, where the first point is. */
  readonly startBearingDeg: number
}

/** A circle is three points at least, whatever its radius and spacing. */
export const LEAST_CIRCLE_POINTS = 3

/**
 * The circle's points on the organization's local frame at `origin`: at the radius
 * from the centre, the first at its start bearing, the rest round it in its direction,
 * as many as keep each arc within `maxArcSpacingM`, the last back at the first so the
 * circle closes. contracts/geometry/circle.json holds this to the same closed form in
 * Python, and pyproj's geodesic to the requirement.
 */
export function circlePoints(origin: Geodetic, circle: Circle, maxArcSpacingM: number): Geodetic[] {
  const middle = eastNorth(origin, circle.centre)
  const count = Math.max(
    LEAST_CIRCLE_POINTS,
    Math.ceil((2 * Math.PI * circle.radiusM) / maxArcSpacingM),
  )
  const turn = circle.clockwise ? 1 : -1
  return Array.from({ length: count + 1 }, (_, step) => {
    const bearing =
      ((circle.startBearingDeg + (turn * 360 * (step % count)) / count) * Math.PI) / 180
    return geodeticAt(origin, {
      eastM: middle.eastM + circle.radiusM * Math.sin(bearing),
      northM: middle.northM + circle.radiusM * Math.cos(bearing),
    })
  })
}
