// @vitest-environment node
import type { LinkState } from '../backend/backend'
import { device, MAVIC_AIR_2 } from '../test/FakeBackend'
import {
  formatDuration,
  formatMoment,
  presenceLabel,
  presenceOf,
  specRows,
  stackLabel,
} from './format'

describe("an aircraft's presence (FR-LNK-02)", () => {
  it.each<[LinkState, boolean, string]>([
    ['connected', true, 'Online'],
    ['connected', false, 'Offline'],
    ['unreachable', true, 'Stack unreachable'],
    ['displaced', true, 'Stack displaced'],
    ['connecting', false, 'Stack connecting'],
  ])('through a stack %s, reported online %s, reads %s', (linkState, online, label) => {
    const seen = { ...device('SOTESTUAV001', online), stack: { name: 'lab', linkState } }
    expect(presenceLabel(seen)).toBe(label)
    expect(presenceOf(seen) === 'unknown').toBe(linkState !== 'connected')
  })

  it('names the stack and why it says nothing about now', () => {
    const seen = device('SOTESTUAV001')
    expect(stackLabel({ ...seen, stack: { name: 'lab', linkState: 'displaced' } })).toBe(
      'lab, displaced by another cloud client',
    )
  })
})

describe('figures as an operator reads them', () => {
  it.each([
    [0, '0 min'],
    [45, '45 s'],
    [60, '1 min'],
    [2040, '34 min'],
    [3600, '1 h'],
    [5400, '1 h 30 min'],
    [90061, '25 h 1 min'],
  ])('%i s is %s', (seconds, text) => {
    expect(formatDuration(seconds)).toBe(text)
  })

  it("dates a moment in the organization's time zone, the device's if it is unknown", () => {
    const moment = '2026-10-11T10:05:00Z'
    expect(formatMoment(moment, 'Europe/Madrid')).toBe('11 Oct 2026, 12:05')
    expect(formatMoment(moment, 'Asia/Tokyo')).toBe('11 Oct 2026, 19:05')
    expect(formatMoment(moment, 'Mars/Olympus_Mons')).toBe(formatMoment(moment, null))
  })

  it('lists every figure of a model with its unit and the page it was read on', () => {
    const rows = specRows(MAVIC_AIR_2)
    expect(rows.find(({ label }) => label === 'Max horizontal speed')).toEqual({
      label: 'Max horizontal speed',
      value: '19 m/s',
      source: MAVIC_AIR_2.sources.max_horizontal_speed_ms,
    })
    expect(rows.find(({ label }) => label === 'Max wind resistance')?.value).toBe('8.5 m/s')
    expect(rows.find(({ label }) => label === 'Max flight time')?.value).toBe('34 min')
    expect(rows.find(({ label }) => label === 'Max service ceiling')?.value).toBe('5,000 m')
    expect(rows.find(({ label }) => label === 'Thermal camera')?.value).toBe('None')
  })

  it('keeps a figure DJI does not publish as unpublished, without a source', () => {
    const rows = specRows({ ...MAVIC_AIR_2, weightG: null, sources: {} })
    expect(rows.find(({ label }) => label === 'Weight')).toEqual({
      label: 'Weight',
      value: null,
      source: null,
    })
    expect(rows.map(({ label }) => label)).toHaveLength(12)
  })

  it("adds a thermal camera's resolution to how it is carried", () => {
    const thermal = { capability: 'integrated', resolution: '640×512' } as const
    const rows = specRows({ ...MAVIC_AIR_2, thermal })
    expect(rows.at(-1)?.value).toBe('Integrated, 640×512')
  })
})
