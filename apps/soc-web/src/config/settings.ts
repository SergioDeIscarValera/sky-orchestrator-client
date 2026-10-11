import { createContext, use } from 'react'

import { z } from '../schema'

/**
 * The console's keys of the configuration contract (IR-CFG, ADR-0019): each with
 * its type and range as `contracts/config/soc-config.schema.json` gives them, a
 * test holding the two equal. `soc-config check soc-web` refuses a bad file
 * before the console starts (ADR-0023); this is the browser's own guard.
 */
export const WEB_KEYS = {
  telemetry_stale_after_ms: { type: 'integer', minimum: 500, maximum: 60000 },
  telemetry_lost_after_ms: { type: 'integer', minimum: 1000, maximum: 300000 },
  geofence_warning_band_m: { type: 'number', minimum: 1, maximum: 50 },
  geofence_max_vertices: { type: 'integer', minimum: 3, maximum: 256 },
  max_arc_spacing_m: { type: 'number', minimum: 1, maximum: 50 },
} as const

/** The contract's relations between the console's keys, worded as it words them. */
export const WEB_CONSTRAINTS = ['telemetry_stale_after_ms < telemetry_lost_after_ms'] as const

type Key = keyof typeof WEB_KEYS

const figure = (key: Key) => {
  const { type, minimum, maximum } = WEB_KEYS[key]
  return (type === 'integer' ? z.int() : z.number()).check(z.gte(minimum), z.lte(maximum))
}

export const settingsSchema = z
  .strictObject({
    telemetry_stale_after_ms: figure('telemetry_stale_after_ms'),
    telemetry_lost_after_ms: figure('telemetry_lost_after_ms'),
    geofence_warning_band_m: figure('geofence_warning_band_m'),
    geofence_max_vertices: figure('geofence_max_vertices'),
    max_arc_spacing_m: figure('max_arc_spacing_m'),
  })
  .check(
    z.refine((file) => file.telemetry_stale_after_ms < file.telemetry_lost_after_ms, {
      message: 'must hold telemetry_stale_after_ms < telemetry_lost_after_ms',
      path: ['telemetry_lost_after_ms'],
    }),
  )

export interface Settings {
  readonly telemetryStaleAfterMs: number
  readonly telemetryLostAfterMs: number
  readonly geofenceWarningBandM: number
  readonly geofenceMaxVertices: number
  readonly maxArcSpacingM: number
}

export function settingsOf(file: z.infer<typeof settingsSchema>): Settings {
  return {
    telemetryStaleAfterMs: file.telemetry_stale_after_ms,
    telemetryLostAfterMs: file.telemetry_lost_after_ms,
    geofenceWarningBandM: file.geofence_warning_band_m,
    geofenceMaxVertices: file.geofence_max_vertices,
    maxArcSpacingM: file.max_arc_spacing_m,
  }
}

export const SettingsContext = createContext<Settings | null>(null)

export function useSettings(): Settings {
  const settings = use(SettingsContext)
  if (settings === null) throw new Error('useSettings outside a SettingsContext')
  return settings
}
