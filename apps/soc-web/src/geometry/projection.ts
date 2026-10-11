/**
 * The one local frame (ADR-0009, ADR-0014): the east-north tangent plane at the
 * organization's position on the WGS84 ellipsoid, in closed form. A point goes
 * through Earth-centred coordinates, both at the ellipsoid's surface, then into
 * east and north at the origin; heights never go through it. The golden vectors
 * of contracts/geometry/projection.json hold this, libs/soc-geo and PROJ
 * together within 10⁻⁶ m.
 */

const SEMI_MAJOR_AXIS_M = 6_378_137
const FLATTENING = 1 / 298.257223563
const ECCENTRICITY_SQUARED = FLATTENING * (2 - FLATTENING)

export interface Geodetic {
  readonly latitudeDeg: number
  readonly longitudeDeg: number
}

export interface EastNorth {
  readonly eastM: number
  readonly northM: number
}

const radians = (degrees: number) => (degrees * Math.PI) / 180

function earthCentred(point: Geodetic): readonly [number, number, number] {
  const latitude = radians(point.latitudeDeg)
  const longitude = radians(point.longitudeDeg)
  const sine = Math.sin(latitude)
  const primeVertical = SEMI_MAJOR_AXIS_M / Math.sqrt(1 - ECCENTRICITY_SQUARED * sine * sine)
  return [
    primeVertical * Math.cos(latitude) * Math.cos(longitude),
    primeVertical * Math.cos(latitude) * Math.sin(longitude),
    primeVertical * (1 - ECCENTRICITY_SQUARED) * sine,
  ]
}

/** Where `point` lies on the tangent plane at `origin`, in metres. */
export function eastNorth(origin: Geodetic, point: Geodetic): EastNorth {
  const [ox, oy, oz] = earthCentred(origin)
  const [px, py, pz] = earthCentred(point)
  const [dx, dy, dz] = [px - ox, py - oy, pz - oz]
  const latitude = radians(origin.latitudeDeg)
  const longitude = radians(origin.longitudeDeg)
  const [sinLat, cosLat] = [Math.sin(latitude), Math.cos(latitude)]
  const [sinLon, cosLon] = [Math.sin(longitude), Math.cos(longitude)]
  return {
    eastM: -sinLon * dx + cosLon * dy,
    northM: -sinLat * cosLon * dx - sinLat * sinLon * dy + cosLat * dz,
  }
}
