// @vitest-environment node
import type {
  CommandIntent,
  CommandVerb,
  Flight,
  FlightState,
  FlightStatus,
  OperationState,
} from '../backend/backend'
import {
  clampPercent,
  currentFlight,
  newestFirst,
  offersOf,
  resultOf,
  stateOf,
  waypointNumber,
} from './flightConsole'
import { RESULT_DEFAULT } from './results'

function flight(changes: Partial<Flight> = {}): Flight {
  return {
    id: 'flight-1',
    operationId: 'operation-1',
    mode: 'simulated',
    fleetId: 'fleet-1',
    gatewaySn: 'SOTESTDOCK01',
    aircraftSn: 'SOTESTUAV001',
    preparedAt: '2026-10-11T10:00:00Z',
    executedAt: '2026-10-11T10:01:00Z',
    tookOffAt: null,
    landedAt: null,
    endedAt: null,
    endReason: null,
    breachedAt: null,
    ...changes,
  }
}

function command(changes: Partial<CommandIntent> = {}): CommandIntent {
  return {
    id: 'command-1',
    operationId: 'operation-1',
    flightId: 'flight-1',
    verb: 'pause',
    status: 'accepted',
    result: 0,
    requestedBy: null,
    requestedAt: '2026-10-11T10:00:00Z',
    sentAt: null,
    repliedAt: null,
    ...changes,
  }
}

describe('the flight the console shows (FR-SAF-04)', () => {
  it('is the newest flight prepared that has not ended, and none when every one has', () => {
    const older = flight({ id: 'older', preparedAt: '2026-10-11T09:00:00Z' })
    const newer = flight({ id: 'newer', preparedAt: '2026-10-11T10:30:00Z' })
    const ended = flight({
      id: 'ended',
      preparedAt: '2026-10-11T11:00:00Z',
      endedAt: '2026-10-11T11:20:00Z',
    })
    expect(currentFlight([older, newer, ended])?.id).toBe('newer')
    expect(currentFlight([ended])).toBeNull()
    expect(currentFlight([])).toBeNull()
  })

  it('does not depend on the order the flights come in', () => {
    const older = flight({ id: 'older', preparedAt: '2026-10-11T09:00:00Z' })
    const newer = flight({ id: 'newer', preparedAt: '2026-10-11T10:30:00Z' })
    expect(currentFlight([newer, older])?.id).toBe('newer')
    expect(currentFlight([older, newer])?.id).toBe('newer')
  })

  it("reads a flight's state by its id, and none for a flight the stack has not reported", () => {
    const states: FlightState[] = [
      {
        flightId: 'flight-1',
        status: 'paused',
        result: null,
        percent: 10,
        currentWaypointIndex: 1,
        endReason: null,
        updatedAt: '2026-10-11T10:02:00Z',
      },
    ]
    expect(stateOf(states, 'flight-1')?.status).toBe('paused')
    expect(stateOf(states, 'flight-2')).toBeNull()
  })
})

describe('the commands a flight offers in its state (FR-CMD-02 to FR-CMD-05)', () => {
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
  const STATUSES: readonly (FlightStatus | null)[] = [null, 'sent', 'in_progress', 'paused', 'ok']
  const EXECUTED = [true, false]

  // Each row: the operation's state, the status, whether the flight executes, and what it offers.
  it.each(
    STATES.flatMap((state) =>
      STATUSES.flatMap((status) =>
        EXECUTED.map((executed) => {
          const offers = offersOf(
            flight({ executedAt: executed ? '2026-10-11T10:01:00Z' : null }),
            status,
            state,
          )
          return [state, status, executed, offers] as const
        }),
      ),
    ),
  )(
    'offers %s with status %s, executed %s, the commands it is due',
    (state, status, executed, offers) => {
      expect(offers).toEqual({
        pause: status === 'in_progress',
        resume: status === 'paused',
        returnHome: executed,
        stop: state === 'in_flight' || state === 'paused',
        undo: !executed,
      })
    },
  )

  it('never offers undo once the flight executes, the stop of the operation aside', () => {
    expect(offersOf(flight(), 'in_progress', 'in_flight').undo).toBe(false)
    expect(offersOf(flight({ executedAt: null }), 'sent', 'launching').undo).toBe(true)
  })
})

describe("the progress bar's span (FR-SAF-03)", () => {
  it('holds a percent to the bar, 0 to 100', () => {
    expect(clampPercent(42)).toBe(42)
    expect(clampPercent(-5)).toBe(0)
    expect(clampPercent(140)).toBe(100)
  })
})

describe('the waypoint a flight is at (FR-SAF-03)', () => {
  it("counts DJI's index from 1, so the first waypoint is 1 and the last is the count", () => {
    expect(waypointNumber(0)).toBe(1)
    expect(waypointNumber(4)).toBe(5)
  })

  it('stays unavailable while the stack has not said', () => {
    expect(waypointNumber(null)).toBeNull()
  })
})

describe("the commands' feed (FR-CMD-06)", () => {
  it('orders the commands newest first by when each was asked, keeping ties in their order', () => {
    const early = command({ id: 'early', requestedAt: '2026-10-11T10:00:00Z' })
    const late = command({ id: 'late', requestedAt: '2026-10-11T10:09:00Z' })
    const tieA = command({ id: 'tie-a', requestedAt: '2026-10-11T10:05:00Z' })
    const tieB = command({ id: 'tie-b', requestedAt: '2026-10-11T10:05:00Z' })
    const sorted = newestFirst([early, tieA, late, tieB]).map(({ id }) => id)
    expect(sorted).toEqual(['late', 'tie-a', 'tie-b', 'early'])
  })

  it('does not change the list it was given', () => {
    const list = [command({ id: 'a', requestedAt: '2026-10-11T10:00:00Z' })]
    newestFirst(list)
    expect(list.map(({ id }) => id)).toEqual(['a'])
  })

  it('gives a refused command its meaning and its code, for the verb that drew it', () => {
    expect(resultOf(command({ verb: 'undo', status: 'refused', result: 318000 }))).toEqual({
      words: RESULT_DEFAULT,
      code: 318000,
    })
    expect(resultOf(command({ verb: 'recovery', status: 'refused', result: 319999 }))).toEqual({
      words: "The outcome is not known yet: SOC reads the flight's progress",
      code: 319999,
    })
  })

  it('gives no result for a reply with no code, or the zero of a success', () => {
    expect(resultOf(command({ result: null, status: 'timed_out' }))).toBeNull()
    expect(resultOf(command({ result: 0, status: 'accepted' }))).toBeNull()
  })

  it.each<CommandVerb>(['prepare', 'execute', 'pause', 'recovery', 'return_home', 'undo'])(
    'gives a %s command a code the contract does not name the default words, with its code',
    (verb) => {
      expect(resultOf(command({ verb, status: 'refused', result: 1 }))?.words).toBe(RESULT_DEFAULT)
    },
  )
})
