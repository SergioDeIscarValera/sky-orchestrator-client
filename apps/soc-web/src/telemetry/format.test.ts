// @vitest-environment node
import {
  batteryLevel,
  formatAge,
  formatCoordinates,
  formatHeading,
  formatMetres,
  modeName,
} from './format'
import { freshnessOf } from './freshness'

describe('live values in words (FR-TEL-03)', () => {
  it.each([
    [0, 'Idle'],
    [3, 'Manual'],
    [4, 'Automatic takeoff'],
    [5, 'Wayline'],
    [9, 'Automatic return'],
    [10, 'Automatic landing'],
    [16, 'Virtual joystick'],
    [42, 'Mode 42'],
  ])('reads mode %i, as Sky Orchestrator sends it, as %s', (code, words) => {
    expect(modeName(code)).toBe(words)
  })

  it.each([
    [100, 'ok'],
    [50, 'ok'],
    [49, 'low'],
    [20, 'low'],
    [19, 'critical'],
    [0, 'critical'],
  ])('reads a battery at %i %% as %s', (percent, level) => {
    expect(batteryLevel(percent)).toBe(level)
  })

  it.each([
    [0, 'under 1 s'],
    [999, 'under 1 s'],
    [1000, '1 s'],
    [59_999, '59 s'],
    [61_000, '1 min 1 s'],
  ])('says %i ms of age as %s', (ms, words) => {
    expect(formatAge(ms)).toBe(words)
  })

  it('reads a heading as a compass and a position to about 0.1 m', () => {
    expect([-90, 0, 179.6, -180, -0.4].map(formatHeading)).toEqual([
      '270°',
      '0°',
      '180°',
      '180°',
      '0°',
    ])
    expect(formatCoordinates(41.6523124, -4.7245)).toBe('41.652312° N, 4.724500° W')
    expect(formatMetres(12.345)).toBe('12.3 m')
  })

  it('leaves what the sample lacks as nothing, never zero', () => {
    expect([modeName(null), formatHeading(null), formatMetres(null)]).toEqual([null, null, null])
    expect(formatCoordinates(41.65, null)).toBeNull()
  })
})

describe("a value's freshness (FR-TEL-02)", () => {
  const thresholds = { telemetryStaleAfterMs: 3000, telemetryLostAfterMs: 10000 }

  it.each([
    [0, 'live'],
    [2999, 'live'],
    [3000, 'stale'],
    [9999, 'stale'],
    [10000, 'lost'],
  ] as const)('at %i ms is %s', (age, freshness) => {
    expect(freshnessOf(age, thresholds)).toBe(freshness)
  })
})
