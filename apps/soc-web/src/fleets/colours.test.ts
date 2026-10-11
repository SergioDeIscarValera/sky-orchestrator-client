// @vitest-environment node
import type { Device } from '../backend/backend'
import { AIRCRAFT_COLOURS, aircraftColourToken, aircraftColourVar } from '../theme/aircraft'
import { colourIndexes, colourOf } from './colours'

function device(aircraftSn: string, firstSeenAt: string, gatewaySn = 'SOTESTDOCK01'): Device {
  return {
    gatewaySn,
    aircraftSn,
    wireModel: '0-67-0',
    online: true,
    firmwareVersion: null,
    firstSeenAt,
    lastSeenAt: firstSeenAt,
    stack: { name: 'lab', linkState: 'connected' },
  }
}

describe("each aircraft's colour", () => {
  it('follows the order the stacks first announced the aircraft, whatever order they are listed in', () => {
    const indexes = colourIndexes([
      device('C', '2026-10-11T10:00:00+00:00'),
      device('A', '2026-10-11T08:00:00+00:00'),
      device('B', '2026-10-11T09:00:00+00:00'),
    ])
    expect(['A', 'B', 'C'].map((sn) => colourOf(indexes, `SOTESTDOCK01/${sn}`))).toEqual([0, 1, 2])
  })

  it('tells six aircraft apart, and gives a seventh the first colour again', () => {
    const devices = Array.from({ length: 7 }, (_, index) =>
      device(`UAV${String(index)}`, `2026-10-11T0${String(index)}:00:00+00:00`),
    )
    const indexes = colourIndexes(devices)
    const colours = devices.map(({ aircraftSn }) => colourOf(indexes, `SOTESTDOCK01/${aircraftSn}`))
    expect(new Set(colours.slice(0, AIRCRAFT_COLOURS)).size).toBe(AIRCRAFT_COLOURS)
    expect(colours[6]).toBe(colours[0])
  })

  it('gives an aircraft no stack has announced the same colour every time', () => {
    const indexes = colourIndexes([])
    const colour = colourOf(indexes, 'REPLAYDOCK/REPLAYUAV')
    expect(colour).toBe(colourOf(indexes, 'REPLAYDOCK/REPLAYUAV'))
    expect(colour).toBeGreaterThanOrEqual(0)
    expect(colour).toBeLessThan(AIRCRAFT_COLOURS)
  })

  it("names the theme's token for each colour, wrapping round", () => {
    expect(aircraftColourToken(0)).toBe('--color-aircraft-1')
    expect(aircraftColourToken(6)).toBe('--color-aircraft-1')
    expect(aircraftColourVar(1)).toBe('var(--color-aircraft-2)')
  })
})
