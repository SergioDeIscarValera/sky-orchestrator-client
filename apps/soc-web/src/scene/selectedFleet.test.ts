import type { Fleet } from '../backend/backend'
import { selectedFleetId } from './selectedFleet'

function fleetOf(id: string, aircraftSn: string): Fleet {
  return {
    id,
    name: `Fleet ${id}`,
    model: 'mavic-air-2',
    airframeSerial: '1WNBH9',
    controllerSerial: null,
    gatewaySn: 'SOTESTDOCK01',
    aircraftSn,
    flightTimeBeforeSocS: 5400,
    createdAt: '2026-10-11T10:00:00Z',
    updatedAt: '2026-10-11T10:00:00Z',
  }
}

const FLEETS = [fleetOf('fleet-a', 'SOTESTUAV001'), fleetOf('fleet-b', 'SOTESTUAV002')]

describe('the fleet a selection names (FR-SCN-04)', () => {
  it('is the fleet of a fleet selection, whether or not the fleets are read', () => {
    expect(selectedFleetId({ kind: 'fleet', fleetId: 'fleet-b' }, undefined)).toBe('fleet-b')
  })

  it('is the fleet registered for the aircraft an aircraft selection names', () => {
    expect(
      selectedFleetId(
        { kind: 'device', gatewaySn: 'SOTESTDOCK01', aircraftSn: 'SOTESTUAV002' },
        FLEETS,
      ),
    ).toBe('fleet-b')
  })

  it('is none for an aircraft no fleet registers, or while the fleets are not read', () => {
    const unregistered = {
      kind: 'device',
      gatewaySn: 'SOTESTDOCK01',
      aircraftSn: 'SOTESTUAV009',
    } as const
    expect(selectedFleetId(unregistered, FLEETS)).toBeNull()
    expect(
      selectedFleetId(
        { kind: 'device', gatewaySn: 'SOTESTDOCK01', aircraftSn: 'SOTESTUAV001' },
        undefined,
      ),
    ).toBeNull()
  })

  it('is none for any other selection, and for none', () => {
    expect(selectedFleetId({ kind: 'operation', operationId: 'op-1' }, FLEETS)).toBeNull()
    expect(selectedFleetId({ kind: 'geofence', geofenceId: 'fence-1' }, FLEETS)).toBeNull()
    expect(selectedFleetId({ kind: 'wayline', waylineId: 'wayline-1' }, FLEETS)).toBeNull()
    expect(selectedFleetId(null, FLEETS)).toBeNull()
  })
})
