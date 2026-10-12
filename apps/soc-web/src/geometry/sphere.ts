import type { Geodetic } from './projection'

/**
 * Distances as Sky Orchestrator measures its limits (ADR-0009): the haversine on a
 * sphere of the IUGG mean radius, as its server and its phone, and as libs/soc-geo's
 * `soc_geo.sphere`. Only Sky Orchestrator's limits are measured here; everything else
 * goes through the local frame. Its own geodesy cases, vendored at
 * contracts/sky-orchestrator/msdk/geodesy-cases.json, hold this within 10⁻⁶ m.
 */

/** IUGG mean Earth radius, as Sky Orchestrator's so_wayline/geodesy.py and Geodesy.kt. */
export const EARTH_RADIUS_M = 6_371_008.8

/**
 * `point`, refused when it cannot be a position: a NaN makes every distance NaN, and NaN
 * compares false against every limit, so it would pass every check.
 */
export function checked(point: Geodetic): Geodetic {
  const { latitudeDeg, longitudeDeg } = point
  if (!(Number.isFinite(latitudeDeg) && latitudeDeg >= -90 && latitudeDeg <= 90)) {
    throw new RangeError(`latitude out of range: ${String(latitudeDeg)}`)
  }
  if (!(Number.isFinite(longitudeDeg) && longitudeDeg >= -180 && longitudeDeg <= 180)) {
    throw new RangeError(`longitude out of range: ${String(longitudeDeg)}`)
  }
  return point
}

function longitudeStepDeg(a: Geodetic, b: Geodetic): number {
  let step = b.longitudeDeg - a.longitudeDeg
  while (step > 180) step -= 360
  while (step <= -180) step += 360
  return step
}

const radians = (degrees: number) => (degrees * Math.PI) / 180

/** The great-circle distance by the haversine, stable at short range, as Sky Orchestrator's. */
export function distanceM(a: Geodetic, b: Geodetic): number {
  checked(a)
  checked(b)
  const lat1 = radians(a.latitudeDeg)
  const lat2 = radians(b.latitudeDeg)
  const dLat = lat2 - lat1
  const dLon = radians(longitudeStepDeg(a, b))
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}
