// @vitest-environment node
import type { Flight, Operation, OperationState, Operator } from '../backend/backend'
import { airborneOf, barPlan, type BarReads } from './safetyBar'

const ME = 'user-me'
const OTHER = 'user-other'

const STATES: readonly OperationState[] = [
  'draft',
  'planned',
  'preparing',
  'simulating',
  'simulated',
  'ready',
  'launching',
  'in_flight',
  'paused',
  'returning',
  'completed',
  'aborted',
  'failed',
  'cancelled',
]

/** The states whose aircraft launch or fly, which the controls command (FR-CMD-07). */
const AIRBORNE: readonly OperationState[] = ['launching', 'in_flight', 'paused', 'returning']

function operation(id: string, state: OperationState): Operation {
  return {
    id,
    organizationId: 'organization-1',
    name: id,
    geofenceId: null,
    takeoffSecurityHeightM: null,
    state,
    endReason: null,
    createdBy: null,
    createdAt: '2026-10-11T10:00:00Z',
    updatedAt: '2026-10-11T10:00:00Z',
    startedAt: null,
    endedAt: null,
  }
}

function flight(id: string, operationId: string, endedAt: string | null = null): Flight {
  return {
    id,
    operationId,
    mode: 'real',
    fleetId: 'fleet-1',
    gatewaySn: 'SOTESTDOCK01',
    aircraftSn: 'SOTESTUAV001',
    preparedAt: '2026-10-11T10:00:00Z',
    executedAt: '2026-10-11T10:01:00Z',
    tookOffAt: null,
    landedAt: null,
    endedAt,
    endReason: null,
    breachedAt: null,
  }
}

function operator(operationId: string, profileId: string, role: Operator['role'] = 'pilot') {
  return { operationId, profileId, role } satisfies Operator
}

/** What a member's controls have read, with nothing failed; the test changes what it needs. */
function reads(changes: Partial<BarReads> = {}): BarReads {
  return {
    role: 'owner',
    userId: ME,
    operations: [],
    operators: new Map(),
    flights: new Map(),
    failure: null,
    ...changes,
  }
}

describe('the operations the safety controls command (FR-CMD-07)', () => {
  it.each(STATES)('commands an operation in %s only while its aircraft launch or fly', (state) => {
    const airborne = airborneOf([operation('one', state)]).map((item) => item.state)
    expect(airborne).toEqual(AIRBORNE.includes(state) ? [state] : [])
  })
})

describe('what the safety controls send to (FR-CMD-01, FR-CMD-07)', () => {
  it('sends to every flight not ended of the operations the member pilots, and to none of the others', () => {
    const plan = barPlan(
      reads({
        operations: [
          operation('mine', 'in_flight'),
          operation('mine-too', 'paused'),
          operation('theirs', 'in_flight'),
          operation('ended-state', 'completed'),
        ],
        operators: new Map([
          ['mine', [operator('mine', ME)]],
          ['mine-too', [operator('mine-too', ME)]],
          ['theirs', [operator('theirs', OTHER)]],
          ['ended-state', [operator('ended-state', ME)]],
        ]),
        flights: new Map([
          [
            'mine',
            [flight('mine-open', 'mine'), flight('mine-ended', 'mine', '2026-10-11T10:30:00Z')],
          ],
          ['mine-too', [flight('mine-too-open', 'mine-too')]],
          ['theirs', [flight('theirs-open', 'theirs')]],
        ]),
      }),
    )
    expect(plan.reason).toBeNull()
    expect(plan.targets).toEqual([
      { operationId: 'mine', flightId: 'mine-open' },
      { operationId: 'mine-too', flightId: 'mine-too-open' },
    ])
  })

  it('holds the controls for an editor or owner who pilots none of the airborne operations, saying Pilots only', () => {
    const plan = barPlan(
      reads({
        operations: [operation('theirs', 'in_flight')],
        operators: new Map([['theirs', [operator('theirs', OTHER)]]]),
        flights: new Map([['theirs', [flight('theirs-open', 'theirs')]]]),
      }),
    )
    expect(plan).toEqual({ targets: [], reason: 'Pilots only' })
  })

  it('does not count an observer as a pilot, and holds the controls for one', () => {
    const plan = barPlan(
      reads({
        operations: [operation('mine', 'in_flight')],
        operators: new Map([['mine', [operator('mine', ME, 'observer')]]]),
        flights: new Map([['mine', [flight('mine-open', 'mine')]]]),
      }),
    )
    expect(plan).toEqual({ targets: [], reason: 'Pilots only' })
  })

  it('names the editor rule first, for a viewer who is a pilot of one', () => {
    const plan = barPlan(
      reads({
        role: 'viewer',
        operations: [operation('mine', 'in_flight')],
        operators: new Map([['mine', [operator('mine', ME)]]]),
        flights: new Map([['mine', [flight('mine-open', 'mine')]]]),
      }),
    )
    expect(plan).toEqual({ targets: [], reason: 'Editors only' })
  })

  it('sends nothing while an airborne operation has its operators or its flights still unread', () => {
    const onlyOperators = barPlan(
      reads({
        operations: [operation('mine', 'in_flight')],
        operators: new Map([['mine', [operator('mine', ME)]]]),
      }),
    )
    expect(onlyOperators).toEqual({ targets: [], reason: 'Reading the operations' })
    const onlyFlights = barPlan(
      reads({
        operations: [operation('mine', 'in_flight')],
        flights: new Map([['mine', [flight('mine-open', 'mine')]]]),
      }),
    )
    expect(onlyFlights).toEqual({ targets: [], reason: 'Reading the operations' })
  })

  it('sends nothing while a read has failed, and says what failed', () => {
    const plan = barPlan(
      reads({
        operations: [operation('mine', 'in_flight')],
        operators: new Map([['mine', [operator('mine', ME)]]]),
        flights: new Map([['mine', [flight('mine-open', 'mine')]]]),
        failure: 'The flights are down',
      }),
    )
    expect(plan).toEqual({ targets: [], reason: 'The flights are down' })
  })

  it('names that no flight is to command when the operations it pilots have none in the air', () => {
    const plan = barPlan(
      reads({
        operations: [operation('mine', 'in_flight')],
        operators: new Map([['mine', [operator('mine', ME)]]]),
        flights: new Map([['mine', [flight('mine-ended', 'mine', '2026-10-11T10:30:00Z')]]]),
      }),
    )
    expect(plan).toEqual({ targets: [], reason: 'No flight to command' })
  })

  it('names that no flight is to command when no operation is airborne', () => {
    expect(barPlan(reads({ operations: [operation('draft', 'draft')] }))).toEqual({
      targets: [],
      reason: 'No flight to command',
    })
  })

  it('holds the controls for an airborne operation that names no operator at all', () => {
    const plan = barPlan(
      reads({
        operations: [operation('mine', 'launching')],
        operators: new Map([['mine', []]]),
        flights: new Map([['mine', [flight('mine-open', 'mine')]]]),
      }),
    )
    expect(plan).toEqual({ targets: [], reason: 'Pilots only' })
  })
})
