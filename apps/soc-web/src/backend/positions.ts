import type { Geodetic } from '../geometry/projection'
import { z } from '../schema'
import { BackendError } from './backend'

/** A position as the database stores it (GeoJSON order): longitude, then latitude, in degrees. */
export type StoredPosition = readonly [longitude: number, latitude: number]

const RANGE = 'a longitude from -180 to 180 and a latitude from -90 to 90'

/**
 * Two finite numbers in range, longitude first. Anything else is refused, never guessed
 * (IR-GEO, IR-WAY): a read fails rather than show a position SOC made up.
 */
const POSITION = z.tuple([
  z.number().check(z.gte(-180), z.lte(180)),
  z.number().check(z.gte(-90), z.lte(90)),
])

/** The console's position from the database's pair, refused when the pair is not one. */
export function positionFromStorage(stored: unknown): Geodetic {
  const parsed = z.safeParse(POSITION, stored)
  if (!parsed.success) throw new BackendError(`soc cannot read a stored position: not ${RANGE}`)
  const [longitudeDeg, latitudeDeg] = parsed.data
  return { latitudeDeg, longitudeDeg }
}

/** The database's pair from the console's position, refused when the position is not one. */
export function positionToStorage(position: Geodetic): StoredPosition {
  const parsed = z.safeParse(POSITION, [position.longitudeDeg, position.latitudeDeg])
  if (!parsed.success) throw new BackendError(`soc cannot write a position: not ${RANGE}`)
  return parsed.data
}
