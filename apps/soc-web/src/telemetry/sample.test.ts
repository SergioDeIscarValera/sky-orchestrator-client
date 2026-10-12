// @vitest-environment node
import { readFileSync } from 'node:fs'

import ts from 'typescript'

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

/**
 * Each expression in `source` that could stand in for a missing value, by line: `??`,
 * `||`, a conditional falling back to something other than null, or a schema's
 * `default`, `prefault`, `catch` or `optional`.
 */
function fallbacks(source: string): string[] {
  const file = ts.createSourceFile('sample.ts', source, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const lineOf = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart()).line + 1
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind
      if (operator === ts.SyntaxKind.QuestionQuestionToken)
        found.push(`${String(lineOf(node))}: ??`)
      if (operator === ts.SyntaxKind.BarBarToken) found.push(`${String(lineOf(node))}: ||`)
    }
    if (ts.isConditionalExpression(node) && node.whenFalse.kind !== ts.SyntaxKind.NullKeyword) {
      found.push(`${String(lineOf(node))}: a conditional falling back to something other than null`)
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['default', 'prefault', 'catch', 'optional'].includes(node.expression.name.text)
    ) {
      found.push(`${String(lineOf(node))}: .${node.expression.name.text}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

describe('a sample never filled in (FR-SAF-03)', () => {
  it('has no way in its schema or its mapping to fill a missing value', () => {
    const source = readFileSync(new URL('sample.ts', import.meta.url), 'utf8')
    expect(fallbacks(source)).toEqual([])
  })

  it('finds each way to fill a missing value when one is planted', () => {
    const planted = [
      'const a = row.height_m ?? 0',
      'const b = row.battery_pct || 100',
      'const c = row.mode_code === null ? 0 : row.mode_code',
      'const d = z.number().default(0).catch(0).optional()',
      'const kept = row.mode_code === undefined ? row.mode_code : null',
    ].join('\n')
    expect(fallbacks(planted)).toEqual([
      '1: ??',
      '2: ||',
      '3: a conditional falling back to something other than null',
      '4: .optional',
      '4: .catch',
      '4: .default',
    ])
  })

  it('carries every measurement a sample lacks as null, for the console to say unavailable', () => {
    const lacking = Object.fromEntries(
      Object.entries(CONTRACT.properties).map(([name, property]) => [
        name,
        [property.type].flat().includes('null') ? null : PAYLOAD[name as keyof typeof PAYLOAD],
      ]),
    )
    const sample = sampleOf(lacking)
    expect(sample).not.toBeNull()
    const measurements = Object.entries(sample ?? {}).filter(([, value]) => value !== null)
    expect(measurements.map(([name]) => name)).toEqual([
      'stack',
      'gatewaySn',
      'aircraftSn',
      'takenAtMs',
      'sentAtMs',
    ])
  })
})
