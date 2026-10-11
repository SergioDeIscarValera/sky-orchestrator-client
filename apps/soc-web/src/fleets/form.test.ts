// @vitest-environment node
import type { Fleet } from '../backend/backend'
import { device } from '../test/FakeBackend'
import {
  blankValues,
  changesFleets,
  changesFrom,
  formFieldOf,
  readValues,
  valuesOf,
  type FleetFormValues,
} from './form'

const FILLED: FleetFormValues = {
  ...blankValues(device('SOTESTUAV001')),
  name: '  Norte 1 ',
  model: 'mavic-air-2',
  airframeSerial: ' 1WNBH9 ',
  hours: '12',
  minutes: '34',
}

const FLEET: Fleet = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Norte 1',
  model: 'mavic-air-2',
  airframeSerial: '1WNBH9',
  controllerSerial: null,
  gatewaySn: 'SOTESTDOCK01',
  aircraftSn: 'SOTESTUAV001',
  flightTimeBeforeSocS: 45240 + 7,
  createdAt: '2026-10-11T10:10:00Z',
  updatedAt: '2026-10-11T10:10:00Z',
}

function draftOf(values: FleetFormValues) {
  const read = readValues(values)
  if (!read.ok) throw new Error(JSON.stringify(read.errors))
  return read.draft
}

describe('reading the fleet form (FR-FLE-03)', () => {
  it('trims what was typed and counts the flight time in seconds', () => {
    expect(draftOf(FILLED)).toEqual({
      name: 'Norte 1',
      model: 'mavic-air-2',
      airframeSerial: '1WNBH9',
      controllerSerial: null,
      gatewaySn: 'SOTESTDOCK01',
      aircraftSn: 'SOTESTUAV001',
      flightTimeBeforeSocS: 12 * 3600 + 34 * 60,
    })
    expect(
      draftOf({ ...FILLED, controllerSerial: ' RC123 ', hours: '', minutes: ' ' }),
    ).toMatchObject({ controllerSerial: 'RC123', flightTimeBeforeSocS: 0 })
  })

  it('refuses, field by field, what the database would refuse', () => {
    expect(readValues(blankValues(device('SOTESTUAV001')))).toEqual({
      ok: false,
      errors: {
        name: 'A fleet needs a name.',
        model: "Choose the aircraft's model from the catalogue.",
        airframeSerial: 'A fleet needs the serial printed on the airframe.',
      },
    })
  })

  it.each([
    ['-1', '0'],
    ['1.5', '0'],
    ['1', '60'],
    ['two', '0'],
    ['1e3', '0'],
  ])('refuses %s h %s min as a flight time', (hours, minutes) => {
    expect(readValues({ ...FILLED, hours, minutes })).toMatchObject({
      ok: false,
      errors: { flightTime: 'Hours and minutes are whole numbers, the minutes under 60.' },
    })
  })

  it('refuses an aircraft it cannot read', () => {
    expect(readValues({ ...FILLED, aircraft: 'SOTESTUAV001' })).toMatchObject({
      ok: false,
      errors: { aircraft: 'Choose the aircraft on the wire this fleet flies as.' },
    })
  })
})

describe('editing a fleet (FR-FLE-05)', () => {
  it('writes nothing when nothing changed, even a flight time with seconds in it', () => {
    const before = draftOf(valuesOf(FLEET))
    expect(changesFrom(before, draftOf(valuesOf(FLEET)))).toEqual({})
  })

  it('writes only what changed, and the wire identity as a pair', () => {
    const before = draftOf(valuesOf(FLEET))
    const after = draftOf({
      ...valuesOf(FLEET),
      name: 'Norte Alfa',
      controllerSerial: 'RC123',
      aircraft: 'SOTESTDOCK01/SOTESTUAV002',
    })
    expect(changesFrom(before, after)).toEqual({
      name: 'Norte Alfa',
      controllerSerial: 'RC123',
      gatewaySn: 'SOTESTDOCK01',
      aircraftSn: 'SOTESTUAV002',
    })
  })

  it('reads a fleet back as the form shows it', () => {
    expect(valuesOf(FLEET)).toMatchObject({ hours: '12', minutes: '34', controllerSerial: '' })
  })
})

describe('who changes fleets, and where a refusal shows', () => {
  it('lets editors and owners change fleets, not viewers', () => {
    expect([changesFleets('owner'), changesFleets('editor'), changesFleets('viewer')]).toEqual([
      true,
      true,
      false,
    ])
  })

  it('shows a refusal of the wire identity on the aircraft, of the time on the time', () => {
    expect(
      [null, 'name', 'gatewaySn', 'aircraftSn', 'flightTimeBeforeSocS'].map((field) =>
        formFieldOf(field as Parameters<typeof formFieldOf>[0]),
      ),
    ).toEqual([null, 'name', 'aircraft', 'aircraft', 'flightTime'])
  })
})
