// @vitest-environment node
import { formatArea, formatLength, refusalLabel } from './format'
import type { Refusal } from './geofenceDrawing'

describe("a geofence's figures", () => {
  it('reads an area in square metres up to a hectare, then in hectares', () => {
    expect(formatArea(0)).toBe('0 m²')
    expect(formatArea(8450.4)).toBe('8,450 m²')
    expect(formatArea(9999.4)).toBe('9,999 m²')
    expect(formatArea(10_000)).toBe('1.00 ha')
    expect(formatArea(23_456)).toBe('2.35 ha')
  })

  it('reads a length in metres up to a kilometre, then in kilometres', () => {
    expect(formatLength(450.4)).toBe('450 m')
    expect(formatLength(1000)).toBe('1.00 km')
    expect(formatLength(12_345)).toBe('12.35 km')
  })
})

describe('the reasons a geofence cannot be saved (FR-GEO-04)', () => {
  const ALL: readonly Refusal[] = [
    'name_missing',
    'too_few_vertices',
    'edges_meet',
    'zero_length_edge',
    'no_area',
    'ceiling_missing',
    'ceiling_not_positive',
    'ceiling_above_envelope',
  ]

  it('names each in its own words', () => {
    const labels = ALL.map((refusal) => refusalLabel(refusal, 120))
    expect(new Set(labels).size).toBe(ALL.length)
    expect(refusalLabel('ceiling_above_envelope', 120)).toBe("Ceiling above the stack's 120 m")
  })
})
