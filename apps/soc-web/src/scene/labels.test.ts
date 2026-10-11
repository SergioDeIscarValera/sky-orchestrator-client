// @vitest-environment node
import type { TelemetrySample } from '../telemetry/sample'
import { MAX_RICH_LABELS, labelLines, richLabels } from './labels'

const sample = (changes: Partial<TelemetrySample> = {}): TelemetrySample => ({
  stack: 'lab',
  gatewaySn: 'D',
  aircraftSn: 'A',
  takenAtMs: 0,
  sentAtMs: 0,
  latitudeDeg: 41.65,
  longitudeDeg: -4.72,
  heightM: 42.34,
  headingDeg: 0,
  homeDistanceM: 0,
  batteryPct: 87,
  satellites: 14,
  gpsQuality: 5,
  modeCode: 5,
  ...changes,
})

describe('labels on aircraft (FR-SCN-06)', () => {
  it('labels the selected, then the hovered, then the alerting, once each', () => {
    const aircraft = [
      { key: 'D/a', freshness: 'live' },
      { key: 'D/b', freshness: 'stale' },
      { key: 'D/c', freshness: 'live' },
      { key: 'D/d', freshness: 'lost' },
    ] as const
    expect(richLabels(aircraft, 'D/c', 'D/b')).toEqual(['D/c', 'D/b', 'D/d'])
    expect(richLabels(aircraft, null, null)).toEqual(['D/b', 'D/d'])
    expect(richLabels(aircraft, 'D/gone', null)).toEqual(['D/b', 'D/d'])
  })

  it('never shows more than twenty rich labels', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      key: `D/${String(index)}`,
      freshness: 'stale' as const,
    }))
    expect(richLabels(many, 'D/39', null)).toHaveLength(MAX_RICH_LABELS)
    expect(richLabels(many, 'D/39', null)[0]).toBe('D/39')
  })

  it("shows a selected fleet's name, height and battery, and says what it lacks", () => {
    expect(labelLines('Norte 1', sample(), 'live')).toEqual({
      title: 'Norte 1',
      detail: '42.3 m · 87 %',
    })
    expect(labelLines('Norte 1', sample({ heightM: null, batteryPct: null }), 'stale')).toEqual({
      title: 'Norte 1',
      detail: 'no height · no battery · stale',
    })
  })
})
