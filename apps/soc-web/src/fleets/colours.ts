import { useCallback, useMemo } from 'react'

import { aircraftKey, type Device } from '../backend/backend'
import { AIRCRAFT_COLOURS } from '../theme/aircraft'
import { useDevices } from './data'

/**
 * Each aircraft's colour index: the order its stacks first announced it, so two
 * aircraft of the organization differ, up to six of them, and keep their colours
 * from one session to the next.
 */
export function colourIndexes(devices: readonly Device[]): ReadonlyMap<string, number> {
  const ordered = [...devices].sort(
    (a, b) =>
      a.firstSeenAt.localeCompare(b.firstSeenAt) ||
      aircraftKey(a.gatewaySn, a.aircraftSn).localeCompare(aircraftKey(b.gatewaySn, b.aircraftSn)),
  )
  return new Map(
    ordered.map((device, index) => [aircraftKey(device.gatewaySn, device.aircraftSn), index]),
  )
}

/** An aircraft no stack has announced yet takes a colour from its serials, the same each time. */
export function colourOf(indexes: ReadonlyMap<string, number>, key: string): number {
  const known = indexes.get(key)
  if (known !== undefined) return known % AIRCRAFT_COLOURS
  let hash = 0
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return hash % AIRCRAFT_COLOURS
}

/** The colour index of any aircraft of the open organization, by `aircraftKey`. */
export function useAircraftColours(): (key: string) => number {
  const devices = useDevices()
  const indexes = useMemo(() => colourIndexes(devices.data ?? []), [devices.data])
  return useCallback((key: string) => colourOf(indexes, key), [indexes])
}
