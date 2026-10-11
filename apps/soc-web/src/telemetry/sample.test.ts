// @vitest-environment node
import { readFileSync } from 'node:fs'

import { PAYLOAD } from '../test/telemetry'
import { SAMPLE, sampleOf } from './sample'

interface Property {
  readonly type: string | readonly string[]
  readonly minimum?: number
  readonly maximum?: number
  readonly pattern?: string
}

const CONTRACT = JSON.parse(
  readFileSync(
    new URL('../../../../contracts/broadcast/telemetry.schema.json', import.meta.url),
    'utf8',
  ),
) as {
  readonly required: readonly string[]
  readonly properties: Readonly<Record<string, Property>>
  readonly additionalProperties: boolean
}

const accepts = (name: string, value: unknown) =>
  SAMPLE.safeParse({ ...PAYLOAD, [name]: value }).success

describe('a telemetry sample, as the contract says it (FR-TEL-01)', () => {
  it('has every property of the contract, all required, and no other', () => {
    expect(Object.keys(PAYLOAD).sort()).toEqual([...CONTRACT.required].sort())
    expect(Object.keys(CONTRACT.properties).sort()).toEqual([...CONTRACT.required].sort())
    expect(CONTRACT.additionalProperties).toBe(false)
    expect(SAMPLE.safeParse(PAYLOAD).success).toBe(true)
    expect(SAMPLE.safeParse({ ...PAYLOAD, extra: 1 }).success).toBe(false)
    for (const name of CONTRACT.required) {
      const missing = Object.fromEntries(Object.entries(PAYLOAD).filter(([key]) => key !== name))
      expect(SAMPLE.safeParse(missing).success, name).toBe(false)
    }
  })

  it.each(Object.entries(CONTRACT.properties))(
    'reads %s as the contract does',
    (name, property) => {
      const types = [property.type].flat()
      expect(accepts(name, null), 'null').toBe(types.includes('null'))
      if (types.includes('integer')) {
        expect(accepts(name, (property.minimum ?? 0) + 0.5), 'a fraction').toBe(false)
      }
      if (property.minimum !== undefined) {
        expect(accepts(name, property.minimum), 'its minimum').toBe(true)
        expect(accepts(name, property.minimum - 1), 'under its minimum').toBe(false)
      }
      if (property.maximum !== undefined) {
        expect(accepts(name, property.maximum), 'its maximum').toBe(true)
        expect(accepts(name, property.maximum + 1), 'over its maximum').toBe(false)
      }
      if (property.pattern !== undefined) {
        expect(accepts(name, 'not valid!'), 'off its pattern').toBe(false)
      }
      if (types.includes('string')) expect(accepts(name, 7), 'a number').toBe(false)
    },
  )

  it('carries every value under its own name, and nothing it lacks', () => {
    expect(sampleOf(PAYLOAD)).toEqual({
      stack: 'lab',
      gatewaySn: 'SOTESTDOCK01',
      aircraftSn: 'SOTESTUAV001',
      takenAtMs: PAYLOAD.taken_at_ms,
      sentAtMs: PAYLOAD.sent_at_ms,
      latitudeDeg: 41.652312,
      longitudeDeg: -4.724512,
      heightM: 12.3,
      headingDeg: -90,
      homeDistanceM: 34.5,
      batteryPct: 87,
      satellites: 14,
      gpsQuality: 5,
      modeCode: 5,
    })
    expect(sampleOf({ ...PAYLOAD, battery_pct: '87' })).toBeNull()
  })
})
