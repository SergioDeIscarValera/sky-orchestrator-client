import { QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

import type { Assignment, Fleet, Operation, OperationState } from '../backend/backend'
import { BackendContext } from '../backend/context'
import { bake, type Design } from '../geometry/bake'
import { geodeticAt, type Geodetic } from '../geometry/projection'
import { OrganizationContext } from '../organizations/context'
import { draftOf } from '../plans/waylines'
import { FakeBackend, MAVIC_AIR_2, NORTH, PILOT } from '../test/FakeBackend'
import { quietQueryClient } from '../test/render'
import { useOperations } from './data'
import {
  aircraftKeysOf,
  fleetIdsOf,
  involvementOf,
  isUnderway,
  useFleetInvolvement,
  useOperationAircraft,
  type OperationAssignments,
} from './involvement'

const UNDERWAY: readonly OperationState[] = [
  'preparing',
  'simulating',
  'simulated',
  'ready',
  'launching',
  'in_flight',
  'paused',
  'returning',
]
const NOT_UNDERWAY: readonly OperationState[] = [
  'draft',
  'planned',
  'completed',
  'aborted',
  'failed',
  'cancelled',
]

function operationOf(
  id: string,
  state: OperationState,
  createdAt = '2026-10-11T10:00:00Z',
): Operation {
  return {
    id,
    organizationId: NORTH.id,
    name: `Operation ${id}`,
    geofenceId: null,
    takeoffSecurityHeightM: 30,
    state,
    endReason: null,
    createdBy: null,
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    endedAt: null,
  }
}

function assignmentOf(id: string, operationId: string, fleetId: string): Assignment {
  return { id, operationId, waylineId: 'wayline-north', fleetId, speedMs: 10, flight: null }
}

function fleetOf(id: string, aircraftSn: string): Fleet {
  return {
    id,
    name: `Fleet ${id}`,
    model: MAVIC_AIR_2.model,
    airframeSerial: '1WNBH9',
    controllerSerial: null,
    gatewaySn: 'SOTESTDOCK01',
    aircraftSn,
    flightTimeBeforeSocS: 5400,
    createdAt: '2026-10-11T10:00:00Z',
    updatedAt: '2026-10-11T10:00:00Z',
  }
}

describe('the states an operation is underway in (FR-OPS-02)', () => {
  it.each(UNDERWAY)('counts %s as underway', (state) => {
    expect(isUnderway(state)).toBe(true)
  })

  it.each(NOT_UNDERWAY)('does not count %s as underway', (state) => {
    expect(isUnderway(state)).toBe(false)
  })
})

describe('the operation a fleet is in now (FR-SCN-04)', () => {
  it('is none for a fleet in no operation', () => {
    const operations: OperationAssignments[] = [
      {
        operation: operationOf('op-1', 'in_flight'),
        assignments: [assignmentOf('a-1', 'op-1', 'fleet-b')],
      },
    ]
    expect(involvementOf('fleet-a', operations)).toBeNull()
  })

  it('is the underway operation the fleet is assigned to, with its assignment', () => {
    const operation = operationOf('op-1', 'in_flight')
    const assignment = assignmentOf('a-1', 'op-1', 'fleet-a')
    expect(involvementOf('fleet-a', [{ operation, assignments: [assignment] }])).toEqual({
      operation,
      assignment,
    })
  })

  it.each(NOT_UNDERWAY)('ignores the fleets of an operation that is %s', (state) => {
    const operations: OperationAssignments[] = [
      {
        operation: operationOf('op-1', state),
        assignments: [assignmentOf('a-1', 'op-1', 'fleet-a')],
      },
    ]
    expect(involvementOf('fleet-a', operations)).toBeNull()
  })

  it('takes the newest of several underway operations by created_at, whatever their order', () => {
    const older = operationOf('op-old', 'in_flight', '2026-10-10T09:00:00Z')
    const newer = operationOf('op-new', 'preparing', '2026-10-11T09:00:00Z')
    const operations: OperationAssignments[] = [
      { operation: older, assignments: [assignmentOf('a-1', 'op-old', 'fleet-a')] },
      { operation: newer, assignments: [assignmentOf('a-2', 'op-new', 'fleet-a')] },
    ]
    expect(involvementOf('fleet-a', operations)?.operation.id).toBe('op-new')
    expect(involvementOf('fleet-a', [...operations].reverse())?.operation.id).toBe('op-new')
  })

  it('is none while the operation has no assignments read', () => {
    const operations: OperationAssignments[] = [
      { operation: operationOf('op-1', 'in_flight'), assignments: [] },
    ]
    expect(involvementOf('fleet-a', operations)).toBeNull()
  })
})

describe('the aircraft of an operation (FR-SCN-04)', () => {
  it('names each fleet once, however many assignments fly it', () => {
    const fleets = fleetIdsOf([
      assignmentOf('a-1', 'op-1', 'fleet-a'),
      assignmentOf('a-2', 'op-1', 'fleet-a'),
    ])
    expect([...fleets]).toEqual(['fleet-a'])
  })

  it('names the aircraft of the given fleets by their wire identity, and no other', () => {
    const fleets = [fleetOf('fleet-a', 'SOTESTUAV001'), fleetOf('fleet-b', 'SOTESTUAV002')]
    expect([...aircraftKeysOf(new Set(['fleet-b']), fleets)]).toEqual(['SOTESTDOCK01/SOTESTUAV002'])
    expect([...aircraftKeysOf(new Set(['fleet-c']), fleets)]).toEqual([])
  })
})

const FARM: Geodetic = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }

function fleetDraft(name: string, aircraftSn: string) {
  return {
    name,
    model: MAVIC_AIR_2.model,
    airframeSerial: '1WNBH9',
    controllerSerial: null,
    gatewaySn: 'SOTESTDOCK01',
    aircraftSn,
    flightTimeBeforeSocS: 5400,
  }
}

/** A farm with two fleets, one of them assigned to an operation the backend's own rules let it be. */
async function farmWith(backend: FakeBackend) {
  const design: Design = {
    takeoff: FARM,
    defaultHeightM: 30,
    primitives: [
      {
        kind: 'route',
        points: [
          geodeticAt(FARM, { eastM: 0, northM: 50 }),
          geodeticAt(FARM, { eastM: 100, northM: 50 }),
        ],
      },
    ],
  }
  const baked = bake(design, { origin: FARM, maxArcSpacingM: 10 })
  const wayline = await backend.createWayline(NORTH.id, draftOf('North corridor', design, baked))
  const flying = await backend.registerFleet(NORTH.id, fleetDraft('Norte 1', 'SOTESTUAV001'))
  const operation = await backend.createOperation(NORTH.id, {
    name: 'North corridor',
    geofenceId: null,
    takeoffSecurityHeightM: 30,
  })
  await backend.assign(operation.id, NORTH.id, {
    waylineId: wayline.id,
    fleetId: flying.id,
    speedMs: 10,
    flight: null,
  })
  return { flying, operation }
}

/** The console's providers for a hook: the backend, the query cache, and the open organization. */
function wrapperFor(backend: FakeBackend) {
  const queryClient = quietQueryClient()
  const choice = { organization: NORTH, organizations: [NORTH], choose: () => undefined }
  return {
    wrapper: ({ children }: { readonly children: ReactNode }) => (
      <BackendContext value={backend}>
        <QueryClientProvider client={queryClient}>
          <OrganizationContext value={choice}>{children}</OrganizationContext>
        </QueryClientProvider>
      </BackendContext>
    ),
  }
}

/** Moves an operation along the backend's own moves (FR-OPS-02), one state after another. */
function moveAlong(backend: FakeBackend, operationId: string, path: readonly OperationState[]) {
  for (const state of path) backend.moveOperation(operationId, state)
}

const TO_IN_FLIGHT: readonly OperationState[] = [
  'planned',
  'preparing',
  'simulating',
  'simulated',
  'ready',
  'launching',
  'in_flight',
]

describe('the involvement and the aircraft read from the backend (FR-SCN-04)', () => {
  it('draws every aircraft with no operation selected, and only the fleet of the one selected', async () => {
    const backend = new FakeBackend(PILOT)
    const { operation } = await farmWith(backend)
    const { wrapper } = wrapperFor(backend)
    const none = renderHook(() => useOperationAircraft(null), { wrapper })
    expect(none.result.current).toBeNull()
    const selected = renderHook(() => useOperationAircraft(operation.id), { wrapper })
    await waitFor(() => {
      expect([...(selected.result.current ?? [])]).toEqual(['SOTESTDOCK01/SOTESTUAV001'])
    })
  })

  it('names the fleet an underway operation has in it, and none for a draft or an ended one', async () => {
    const backend = new FakeBackend(PILOT)
    const { flying, operation } = await farmWith(backend)
    const { wrapper } = wrapperFor(backend)
    const draft = renderHook(
      () => ({ involved: useFleetInvolvement(flying.id), operations: useOperations() }),
      { wrapper },
    )
    await waitFor(() => {
      expect(draft.result.current.operations.data).toHaveLength(1)
    })
    expect(draft.result.current.involved).toBeNull()

    moveAlong(backend, operation.id, TO_IN_FLIGHT)
    const flight = renderHook(() => useFleetInvolvement(flying.id), { wrapper })
    await waitFor(() => {
      expect(flight.result.current?.operation.id).toBe(operation.id)
    })
    expect(flight.result.current?.assignment.fleetId).toBe(flying.id)

    moveAlong(backend, operation.id, ['returning', 'completed'])
    const ended = renderHook(
      () => ({ involved: useFleetInvolvement(flying.id), operations: useOperations() }),
      { wrapper },
    )
    await waitFor(() => {
      expect(ended.result.current.operations.data?.[0]?.state).toBe('completed')
    })
    expect(ended.result.current.involved).toBeNull()
  })

  it('names no operation for a fleet that no underway operation flies, and none without a fleet', async () => {
    const backend = new FakeBackend(PILOT)
    const { operation } = await farmWith(backend)
    moveAlong(backend, operation.id, TO_IN_FLIGHT)
    const idle = await backend.registerFleet(NORTH.id, fleetDraft('Oeste 3', 'SOTESTUAV003'))
    const { wrapper } = wrapperFor(backend)
    const probe = renderHook(
      () => ({
        idle: useFleetInvolvement(idle.id),
        none: useFleetInvolvement(null),
        operations: useOperations(),
      }),
      { wrapper },
    )
    await waitFor(() => {
      expect(probe.result.current.operations.data).toHaveLength(1)
    })
    expect(probe.result.current.idle).toBeNull()
    expect(probe.result.current.none).toBeNull()
  })
})
