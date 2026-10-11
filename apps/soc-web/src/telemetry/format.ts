/**
 * DJI's DroneModeCodeEnum in words (FR-TEL-03), worded as Sky Orchestrator's
 * so-gateway README words the codes it sends: 0, 3, 4, 5, 9, 10 and 16.
 */
const MODES: Readonly<Record<number, string>> = {
  0: 'Idle',
  1: 'Preparing to take off',
  2: 'Ready to take off',
  3: 'Manual',
  4: 'Automatic takeoff',
  5: 'Wayline',
  6: 'Panorama',
  7: 'Tracking',
  8: 'ADS-B avoidance',
  9: 'Automatic return',
  10: 'Automatic landing',
  11: 'Forced landing',
  12: 'Three-propeller landing',
  13: 'Upgrading',
  14: 'Not connected',
  15: 'APAS',
  16: 'Virtual joystick',
  17: 'Live flight controls',
  18: 'RTK fixing',
  19: 'Dock address selecting',
  20: 'Point of interest',
}

export function modeName(code: number | null): string | null {
  if (code === null) return null
  return MODES[code] ?? `Mode ${String(code)}`
}

/** Whole seconds, minutes past one, never a decimal that ticks. */
export function formatAge(ageMs: number): string {
  if (ageMs < 1000) return 'under 1 s'
  const seconds = Math.floor(ageMs / 1000)
  if (seconds < 60) return `${String(seconds)} s`
  return `${String(Math.floor(seconds / 60))} min ${String(seconds % 60)} s`
}

const ONE_DECIMAL = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 })

export function formatMetres(value: number | null): string | null {
  return value === null ? null : `${ONE_DECIMAL.format(value)} m`
}

/** DJI's -180 to 180 read as a compass: 0 to 359°. */
export function formatHeading(degrees: number | null): string | null {
  if (degrees === null) return null
  return `${String(Math.round((degrees + 360) % 360) % 360)}°`
}

/** Six decimals, about 0.1 m. */
export function formatCoordinates(
  latitude: number | null,
  longitude: number | null,
): string | null {
  if (latitude === null || longitude === null) return null
  const north = `${Math.abs(latitude).toFixed(6)}° ${latitude < 0 ? 'S' : 'N'}`
  const east = `${Math.abs(longitude).toFixed(6)}° ${longitude < 0 ? 'W' : 'E'}`
  return `${north}, ${east}`
}
