import { z } from '../schema'

/**
 * One aircraft OSD as soc-cloud broadcast it (`contracts/broadcast/telemetry.schema.json`
 * 1.0.0, FR-TEL-01): a value the OSD lacked is null, never the previous sample's. A test
 * holds this schema equal to the contract.
 */
export const SAMPLE = z.strictObject({
  stack: z.string().check(z.regex(/^[a-z][a-z0-9-]{0,30}$/)),
  gateway_sn: z.string().check(z.regex(/^[A-Za-z0-9]+$/)),
  aircraft_sn: z.string().check(z.regex(/^[A-Za-z0-9]+$/)),
  taken_at_ms: z.int().check(z.gte(0)),
  sent_at_ms: z.int().check(z.gte(0)),
  latitude_deg: z.nullable(z.number().check(z.gte(-90), z.lte(90))),
  longitude_deg: z.nullable(z.number().check(z.gte(-180), z.lte(180))),
  height_m: z.nullable(z.number()),
  heading_deg: z.nullable(z.number()),
  home_distance_m: z.nullable(z.number().check(z.gte(0))),
  battery_pct: z.nullable(z.int().check(z.gte(0), z.lte(100))),
  satellites: z.nullable(z.int().check(z.gte(0))),
  gps_quality: z.nullable(z.int().check(z.gte(0))),
  mode_code: z.nullable(z.int().check(z.gte(0))),
})

export interface TelemetrySample {
  readonly stack: string
  readonly gatewaySn: string
  readonly aircraftSn: string
  /** When the aircraft took it, Unix milliseconds on its own clock. */
  readonly takenAtMs: number
  /** When soc-cloud broadcast it, Unix milliseconds on the mini-PC's clock. */
  readonly sentAtMs: number
  readonly latitudeDeg: number | null
  readonly longitudeDeg: number | null
  /** Above the takeoff point. */
  readonly heightM: number | null
  /** From true north, clockwise, -180 to 180 as DJI reports it. */
  readonly headingDeg: number | null
  readonly homeDistanceM: number | null
  readonly batteryPct: number | null
  readonly satellites: number | null
  readonly gpsQuality: number | null
  readonly modeCode: number | null
}

/** The sample a payload holds, or null when it does not follow the contract. */
export function sampleOf(payload: unknown): TelemetrySample | null {
  const parsed = SAMPLE.safeParse(payload)
  if (!parsed.success) return null
  const row = parsed.data
  return {
    stack: row.stack,
    gatewaySn: row.gateway_sn,
    aircraftSn: row.aircraft_sn,
    takenAtMs: row.taken_at_ms,
    sentAtMs: row.sent_at_ms,
    latitudeDeg: row.latitude_deg,
    longitudeDeg: row.longitude_deg,
    heightM: row.height_m,
    headingDeg: row.heading_deg,
    homeDistanceM: row.home_distance_m,
    batteryPct: row.battery_pct,
    satellites: row.satellites,
    gpsQuality: row.gps_quality,
    modeCode: row.mode_code,
  }
}
