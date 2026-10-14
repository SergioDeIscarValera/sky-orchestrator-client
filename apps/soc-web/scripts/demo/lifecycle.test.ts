// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { sampleOf as consoleSampleOf } from '../../src/telemetry/sample'
import { MODES, type Sample } from './aircraft.mjs'
import { createLifecycle, judgeChecks, MOVES, PF_CHECK_IDS, STACK, TIMINGS } from './lifecycle.mjs'
import {
  createOperationTables,
  DatabaseError,
  EVENT_KINDS,
  OPERATION_MOVES,
  TERMINAL,
  type Db,
  type Row,
} from './operation-tables.mjs'

const NORTH = '11111111-1111-4111-8111-111111111111'
const USER = '6f1c2a52-34c5-4d7b-9a43-0b0f9e1d2c11'
const OPERATION = '66666666-6666-4666-8666-666666666666'
const ASSIGNMENT = '77777777-7777-4777-8777-777777777777'
const FLEET = '33333333-3333-4333-8333-333333333333'
const WAYLINE = '55555555-5555-4555-8555-555555555555'
/** The takeoff point of the wayline, where the aircraft stands before it flies. */
const HOME = [-4.7245, 41.6523] as const
/** The aircraft Norte 1 flies, as the demo names it: on stack lab, through its gateway. */
const AIRCRAFT = {
  organizationId: NORTH,
  stack: 'lab',
  gatewaySn: 'SOTESTDOCK01',
  aircraftSn: '1WNBH9E00A0042',
  home: HOME,
}

/** A contract file the demo reads, relative to this test. */
const contract = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))

interface Frame {
  readonly organization: string
  readonly event: string
  readonly payload: Row
}

/** A sample the aircraft sent, with the organization whose telemetry topic it went to. */
interface Sent {
  readonly organization: string
  readonly sample: Sample
}

interface Scenario {
  readonly db: Db
  readonly lifecycle: ReturnType<typeof createLifecycle>
  readonly frames: Frame[]
  readonly errors: unknown[]
  readonly tables: Record<string, Row[]>
  /** Each sample the aircraft sent, in order. */
  readonly sent: Sent[]
  /** Each row the lifecycle stored as a flight's track, in order. */
  readonly stored: Row[]
}

/** One draft operation of North corridor, flown by Norte 1 with its pilot, and nothing run yet. */
function scenario({ pilot = true }: { readonly pilot?: boolean } = {}): Scenario {
  const tables: Record<string, Row[]> = {
    operations: [
      {
        id: OPERATION,
        organization_id: NORTH,
        name: 'North corridor',
        geofence_id: null,
        takeoff_security_height_m: null,
        state: 'draft',
        end_reason: null,
        created_by: USER,
        created_at: '2026-10-11T08:20:00+00:00',
        updated_at: '2026-10-11T08:20:00+00:00',
        started_at: null,
        ended_at: null,
      },
    ],
    assignments: [
      {
        id: ASSIGNMENT,
        operation_id: OPERATION,
        organization_id: NORTH,
        wayline_id: WAYLINE,
        fleet_id: FLEET,
        speed_ms: null,
        flight: null,
        created_at: '2026-10-11T08:20:00+00:00',
      },
    ],
    operators: [
      {
        operation_id: OPERATION,
        organization_id: NORTH,
        profile_id: USER,
        role: pilot ? 'pilot' : 'observer',
      },
    ],
    operation_checks: [],
    operation_events: [],
    transition_requests: [],
    flights: [],
    flight_states: [],
    command_intents: [],
  }
  const fleets: Row[] = [
    {
      id: FLEET,
      organization_id: NORTH,
      name: 'Norte 1',
      gateway_sn: 'SOTESTDOCK01',
      aircraft_sn: '1WNBH9E00A0042',
    },
  ]
  const waylines: Row[] = [
    { id: WAYLINE, organization_id: NORTH, name: 'North corridor', takeoff: [-4.7245, 41.6523] },
  ]
  const frames: Frame[] = []
  const errors: unknown[] = []
  const sent: Sent[] = []
  const stored: Row[] = []
  const rows = (name: string): Row[] => {
    if (name === 'fleets') return fleets
    if (name === 'waylines') return waylines
    return tables[name] ?? []
  }
  const db = createOperationTables({
    rows,
    publish: (organization, event, payload) => {
      frames.push({ organization, event, payload })
    },
    roles: { canEdit: () => true },
  })
  const lifecycle = createLifecycle({
    db,
    roles: { canEdit: () => true },
    onError: (error) => errors.push(error),
    aircraft: AIRCRAFT,
    telemetry: {
      send: (organization, sample) => {
        sent.push({ organization, sample })
      },
      store: (row) => {
        stored.push(row)
      },
    },
  })
  return { db, lifecycle, frames, errors, tables, sent, stored }
}

/** The operation's row, which the database holds in one array. */
const operationOf = (s: Scenario): Row => s.tables.operations?.[0] ?? {}

/** Gives the operation what a plan needs: a height, a speed and a stored flight of three waypoints. */
function makeFlyable(s: Scenario): void {
  s.db.updateRow('operations', operationOf(s), { takeoff_security_height_m: 30 })
  s.db.updateRow('assignments', s.tables.assignments?.[0] ?? {}, {
    speed_ms: 5,
    flight: {
      schema_version: '2.2.0',
      waypoints: [
        { index: 0, position: [-4.7245, 41.6523], height_m: 30 },
        { index: 1, position: [-4.72, 41.653], height_m: 30 },
        { index: 2, position: [-4.7195, 41.654], height_m: 30 },
      ],
    },
  })
}

/** A member asks a transition, as the RPC does: the request is inserted and its decision scheduled. */
function ask(s: Scenario, transition: string, clientRequest: string = randomUUID()): Row {
  const { row, created } = s.db.requestTransition({
    operation: OPERATION,
    wanted: transition,
    clientRequest,
    me: USER,
  })
  if (created) s.lifecycle.transitionAsked(String(row.id))
  return row
}

/** A pilot asks a flight a verb, as the RPC does. */
function askCommand(s: Scenario, verb: string): Row {
  const flight = activeFlight(s)
  const { row, created } = s.db.requestCommand({
    flight: String(flight.id),
    wanted: verb,
    clientRequest: randomUUID(),
    me: USER,
  })
  if (created) s.lifecycle.commandAsked(String(row.id))
  return row
}

const advance = (ms: number): void => {
  vi.advanceTimersByTime(ms)
}

const stateOf = (s: Scenario): unknown => operationOf(s).state

/** The status the frames of one row took, in order, for a state topic's event. */
function statusesOf(s: Scenario, event: string, id: string): unknown[] {
  return s.frames
    .filter((frame) => frame.event === event && frame.payload.id === id)
    .map((frame) => frame.payload.status)
}

/** The log's kinds, in the order they were written. */
const kindsOf = (s: Scenario): string[] =>
  (s.tables.operation_events ?? []).map((event) => String(event.kind))

/** The moves the log records, as [from, to, cause]. */
function movesOf(s: Scenario): [string, string, string][] {
  return (s.tables.operation_events ?? [])
    .filter((event) => event.kind === 'operation_state_changed')
    .map((event) => {
      const payload = event.payload as Record<string, unknown>
      return [String(payload.from), String(payload.to), String(payload.cause)]
    })
}

/** The flights the run prepared, in the order it prepared them. */
const flightsOf = (s: Scenario): Row[] => s.tables.flights ?? []

/** The first flight the run prepared in a mode: the real one unless asked otherwise. */
const flightOf = (s: Scenario, mode: 'simulated' | 'real' = 'real'): Row =>
  flightsOf(s).find((flight) => flight.mode === mode) ?? {}

/** The flight a pilot's command is for: the one that has not ended. */
const activeFlight = (s: Scenario): Row =>
  flightsOf(s)
    .filter((flight) => flight.ended_at === null)
    .at(-1) ?? {}

/** A flight's latest progress, as soc-cloud recorded it. */
const progressOf = (s: Scenario, flight: Row): Row | undefined =>
  (s.tables.flight_states ?? []).find((state) => state.flight_id === flight.id)

/** The payload of a flight's flight_ended entry: how soc-operations closed it. */
const endedPayloadOf = (s: Scenario, flight: Row): unknown =>
  (s.tables.operation_events ?? []).find(
    (event) => event.kind === 'flight_ended' && event.flight_id === flight.id,
  )?.payload

/** Runs plan, prepare and simulate to the end of the simulation, and then ready. */
function simulateToReady(s: Scenario): void {
  makeFlyable(s)
  ask(s, 'plan')
  advance(TIMINGS.decideMs)
  ask(s, 'prepare')
  advance(TIMINGS.decideMs)
  ask(s, 'simulate')
  advance(TIMINGS.decideMs + 2 * TIMINGS.commandStepMs * 2 + TIMINGS.taskMs + TIMINGS.readyMs)
}

/** Runs plan, prepare and launch to the moment the aircraft is in flight. */
function launchToFlight(s: Scenario): void {
  simulateToReady(s)
  ask(s, 'launch')
  advance(TIMINGS.decideMs + 2 * TIMINGS.commandStepMs * 2)
}

/** The contract every entry of the log holds (contracts/events/events.json). */
function expectLogHoldsTheContract(entries: readonly Row[]): void {
  const severities = ['info', 'warning', 'error', 'safety']
  const kinds = (
    contract('../../../../contracts/events/events.json') as {
      kinds: Record<string, { severity: string; sources: string[]; payload: string[] }>
    }
  ).kinds
  for (const entry of entries) {
    const kind = String(entry.kind)
    const listed = kinds[kind]
    expect(listed, `kind ${kind} is listed`).toBeDefined()
    if (listed === undefined) continue
    expect(listed.sources, `${kind} source`).toContain(entry.source)
    const payload = entry.payload as Record<string, unknown>
    for (const key of listed.payload) expect(payload, `${kind} payload ${key}`).toHaveProperty(key)
    const rank = severities.indexOf(String(entry.severity))
    expect(rank, `${kind} severity`).toBeGreaterThanOrEqual(severities.indexOf(listed.severity))
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the requests soc-operations decides', () => {
  it('claims a request running after claimMs and decides it after decideMs, broadcasting each status', () => {
    const s = scenario()
    makeFlyable(s)
    const request = String(ask(s, 'plan').id)
    advance(TIMINGS.claimMs - 1)
    expect(statusesOf(s, 'transition_request', request)).toEqual(['pending'])
    advance(1)
    expect(statusesOf(s, 'transition_request', request)).toEqual(['pending', 'running'])
    advance(TIMINGS.decideMs - TIMINGS.claimMs)
    expect(statusesOf(s, 'transition_request', request)).toEqual(['pending', 'running', 'accepted'])
    expect(stateOf(s)).toBe('planned')
  })

  it('refuses a plan with each missing condition named as soc-operations names it', () => {
    const s = scenario()
    const request = ask(s, 'plan')
    advance(TIMINGS.decideMs)
    expect(request.status).toBe('refused')
    expect(request.reasons).toEqual([
      'the operation has no height',
      'the fleet Norte 1 has no speed for its wayline',
      'the wayline has not been flown for this operation yet',
    ])
    expect(stateOf(s)).toBe('draft')
    expect(kindsOf(s)).toEqual(['transition_requested', 'transition_refused'])
    const refused = s.tables.operation_events?.[1]
    expect(refused?.severity).toBe('warning')
    expect(refused?.payload).toMatchObject({ transition: 'plan', reasons: request.reasons })
  })

  it('refuses a plan with no pilot who is an editor, as the one missing condition', () => {
    const s = scenario({ pilot: false })
    makeFlyable(s)
    const request = ask(s, 'plan')
    advance(TIMINGS.decideMs)
    expect(request.reasons).toEqual([
      'the operation has no pilot who is an editor of its organization',
    ])
  })

  it('refuses each transition the state it finds does not allow, naming the state', () => {
    const s = scenario()
    const refusals = (['prepare', 'unprepare', 'simulate', 'launch', 'stop'] as const).map(
      (transition) => ({
        transition,
        request: ask(s, transition),
      }),
    )
    advance(TIMINGS.decideMs)
    expect(
      refusals.map(({ transition, request }) => [transition, request.status, request.reasons]),
    ).toEqual([
      ['prepare', 'refused', ['the operation is draft, not planned']],
      ['unprepare', 'refused', ['the operation is draft, not preparing']],
      ['simulate', 'refused', ['the operation is draft, not preparing']],
      ['launch', 'refused', ['the operation is draft, not ready']],
      ['stop', 'refused', ['the operation is draft: only one in flight stops']],
    ])
  })

  it('cancels from draft, planned, preparing, simulated and ready, and from nowhere else', () => {
    const s = scenario()
    const request = ask(s, 'cancel')
    advance(TIMINGS.decideMs)
    expect(request.status).toBe('accepted')
    expect(stateOf(s)).toBe('cancelled')
    expect(operationOf(s).end_reason).toBe('cancelled')
    expect(operationOf(s).ended_at).not.toBeNull()
    expect(movesOf(s)).toEqual([['draft', 'cancelled', 'cancel']])
  })

  it('refuses a request once the operation is closed, as the database does, before any decision', () => {
    const s = scenario()
    s.db.move(OPERATION, 'cancelled', 'cancel', 'operator', USER)
    expect(() => ask(s, 'plan')).toThrow(DatabaseError)
    expect(() => ask(s, 'plan')).toThrow('closed when it became cancelled')
  })

  it('answers the same client request id with the request it made first, asking once', () => {
    const s = scenario()
    const client = randomUUID()
    const first = ask(s, 'cancel', client)
    const again = ask(s, 'cancel', client)
    expect(again.id).toBe(first.id)
    advance(TIMINGS.decideMs)
    expect(s.tables.transition_requests).toHaveLength(1)
  })

  it('refuses a simulate by a member who is no pilot of the operation', () => {
    const s = scenario({ pilot: false })
    expect(() => ask(s, 'simulate')).toThrow(DatabaseError)
    expect(() => ask(s, 'simulate')).toThrow('only its pilots simulate')
  })

  it('records a request the database cannot decide as failed, with the reason, and says so', () => {
    const s = scenario()
    makeFlyable(s)
    ask(s, 'plan')
    advance(TIMINGS.decideMs)
    ask(s, 'prepare')
    advance(TIMINGS.decideMs)
    const simulate = ask(s, 'simulate')
    // The operation closes while the simulate waits: its checks can no longer be written.
    s.db.move(OPERATION, 'cancelled', 'cancel', 'operator', USER)
    advance(TIMINGS.decideMs)
    expect(simulate.status).toBe('failed')
    expect(String(simulate.reasons)).toContain('soc-operations could not decide it')
    expect(s.errors).toHaveLength(1)
  })
})

describe('a preparation and a simulation', () => {
  it('writes the sixteen checks passing at the first judged request, PF-CLOCK not blocking', () => {
    const s = scenario()
    makeFlyable(s)
    ask(s, 'plan')
    advance(TIMINGS.decideMs)
    ask(s, 'prepare')
    advance(TIMINGS.decideMs)
    expect(stateOf(s)).toBe('preparing')
    const checks = s.tables.operation_checks ?? []
    expect(checks.map((check) => check.check_id)).toEqual([...PF_CHECK_IDS])
    expect(checks.every((check) => check.state === 'pass')).toBe(true)
    expect(checks.filter((check) => !check.blocking).map((check) => check.check_id)).toEqual([
      'PF-CLOCK',
    ])
    const broadcast = s.frames.filter((frame) => frame.event === 'operation_check')
    expect(broadcast).toHaveLength(16)
  })

  it('simulates: logs the checks, prepares a simulated flight, plays its task, and ends ok', () => {
    const s = scenario()
    simulateToReady(s)
    expect(kindsOf(s).slice(0, 8)).toEqual([
      'transition_requested',
      'operation_state_changed',
      'transition_requested',
      'operation_state_changed',
      'transition_requested',
      'checks_at_simulation',
      'flight_prepared',
      'command_requested',
    ])
    expect(flightOf(s, 'simulated')).toMatchObject({ mode: 'simulated', end_reason: 'completed' })
    expect(flightOf(s, 'simulated').executed_at).not.toBeNull()
    const percents = s.frames
      .filter((frame) => frame.event === 'flight_state')
      .map((frame) => frame.payload.percent)
    expect(percents[0]).toBe(0)
    expect(percents.at(-1)).toBe(100)
    expect(percents).toEqual([...percents].sort((a, b) => Number(a) - Number(b)))
    expect(progressOf(s, flightOf(s, 'simulated'))).toMatchObject({
      status: 'ok',
      result: 0,
      end_reason: 'completed',
      percent: 100,
    })
    expect(movesOf(s).slice(-3)).toEqual([
      ['preparing', 'simulating', 'simulate'],
      ['simulating', 'simulated', 'simulation ok'],
      ['simulated', 'ready', 'every condition of ready holds'],
    ])
    expect(kindsOf(s)).toContain('flight_ended')
    expect(endedPayloadOf(s, flightOf(s, 'simulated'))).toEqual({
      status: 'ok',
      result: 0,
      end_reason: 'completed',
    })
  })

  it("follows the stored flight's waypoints with its current waypoint as the task runs", () => {
    const s = scenario()
    simulateToReady(s)
    const waypoints = s.frames
      .filter((frame) => frame.event === 'flight_state')
      .map((frame) => frame.payload.current_waypoint_index)
    expect(waypoints[0]).toBe(0)
    expect(waypoints.at(-1)).toBe(2)
    expect(new Set(waypoints)).toEqual(new Set([0, 1, 2]))
  })

  it('undoes a simulation asked before its execute: the operation goes back to preparing', () => {
    const s = scenario()
    makeFlyable(s)
    ask(s, 'plan')
    advance(TIMINGS.decideMs)
    ask(s, 'prepare')
    advance(TIMINGS.decideMs)
    ask(s, 'simulate')
    // The prepare is outstanding: the undo is asked, and the flight is cancelled before it executes.
    advance(TIMINGS.decideMs + 100)
    askCommand(s, 'undo')
    advance(TIMINGS.decideMs)
    expect(stateOf(s)).toBe('preparing')
    expect(flightOf(s, 'simulated')).toMatchObject({ end_reason: 'cancelled', executed_at: null })
    expect(s.tables.command_intents?.map((intent) => intent.verb)).toEqual(['prepare', 'undo'])
    expect(movesOf(s).slice(-1)).toEqual([
      ['simulating', 'preparing', 'simulation canceled: cancelled'],
    ])
    expect(kindsOf(s)).not.toContain('checks_at_launch')
  })

  it('refuses an undo once the flight executes, as the database names it', () => {
    const s = scenario()
    makeFlyable(s)
    ask(s, 'plan')
    advance(TIMINGS.decideMs)
    ask(s, 'prepare')
    advance(TIMINGS.decideMs)
    ask(s, 'simulate')
    advance(TIMINGS.decideMs + 2 * TIMINGS.commandStepMs * 2 + TIMINGS.progressTickMs)
    expect(flightOf(s, 'simulated').executed_at).not.toBeNull()
    expect(() => askCommand(s, 'undo')).toThrow('it executes, so it is no longer undone')
  })
})

describe('the flight of a launch', () => {
  it('launches, takes off, runs its task, lands and completes, with the log in order', () => {
    const s = scenario()
    simulateToReady(s)
    ask(s, 'launch')
    advance(TIMINGS.decideMs + 2 * TIMINGS.commandStepMs * 2 + TIMINGS.takeOffMs)
    expect(stateOf(s)).toBe('in_flight')
    advance(TIMINGS.taskMs)
    expect(stateOf(s)).toBe('returning')
    advance(TIMINGS.landMs)
    expect(stateOf(s)).toBe('completed')
    expect(operationOf(s)).toMatchObject({ end_reason: 'completed', state: 'completed' })
    expect(flightOf(s)).toMatchObject({ mode: 'real', end_reason: 'completed' })
    expect(flightOf(s).took_off_at).not.toBeNull()
    expect(flightOf(s).landed_at).not.toBeNull()
  })

  it('logs the whole path from draft to completed in the order its entries were written', () => {
    const s = scenario()
    simulateToReady(s)
    ask(s, 'launch')
    advance(
      TIMINGS.decideMs +
        2 * TIMINGS.commandStepMs * 2 +
        TIMINGS.takeOffMs +
        TIMINGS.taskMs +
        TIMINGS.landMs,
    )
    expect(stateOf(s)).toBe('completed')
    expect(kindsOf(s)).toEqual([
      'transition_requested',
      'operation_state_changed',
      'transition_requested',
      'operation_state_changed',
      'transition_requested',
      'checks_at_simulation',
      'flight_prepared',
      'command_requested',
      'operation_state_changed',
      'command_outcome',
      'command_requested',
      'command_outcome',
      'flight_status_changed',
      'flight_status_changed',
      'flight_ended',
      'operation_state_changed',
      'operation_state_changed',
      'transition_requested',
      'checks_at_launch',
      'flight_prepared',
      'command_requested',
      'operation_state_changed',
      'command_outcome',
      'command_requested',
      'command_outcome',
      'operation_state_changed',
      'flight_status_changed',
      'took_off',
      'flight_status_changed',
      'operation_state_changed',
      'landed',
      'flight_ended',
      'operation_state_changed',
    ])
  })

  it('undoes a launch before its execute: the operation goes back to ready, the flight cancelled', () => {
    const s = scenario()
    simulateToReady(s)
    ask(s, 'launch')
    advance(TIMINGS.decideMs + TIMINGS.commandStepMs)
    askCommand(s, 'undo')
    advance(TIMINGS.decideMs)
    expect(stateOf(s)).toBe('ready')
    // The simulation's prepare and execute, then the launch's prepare and its undo: the undo came
    // while the launch's prepare was outstanding, so no execute followed it.
    expect(s.tables.command_intents?.map((intent) => intent.verb)).toEqual([
      'prepare',
      'execute',
      'prepare',
      'undo',
    ])
    expect(flightOf(s)).toMatchObject({
      mode: 'real',
      end_reason: 'cancelled',
      executed_at: null,
      took_off_at: null,
    })
    expect(movesOf(s).slice(-1)).toEqual([
      ['launching', 'ready', 'the launch ended canceled before take-off: cancelled'],
    ])
    expect(endedPayloadOf(s, flightOf(s))).toEqual({
      status: 'canceled',
      result: 0,
      end_reason: 'cancelled',
    })
  })
})

describe('the pilot commands in flight', () => {
  it('pauses the progress and the operation, and resumes both on recovery', () => {
    const s = scenario()
    launchToFlight(s)
    advance(TIMINGS.takeOffMs + TIMINGS.progressTickMs * 3)
    askCommand(s, 'pause')
    advance(2 * TIMINGS.commandStepMs)
    expect(stateOf(s)).toBe('paused')
    const paused = progressOf(s, flightOf(s))?.percent
    advance(TIMINGS.taskMs)
    expect(stateOf(s)).toBe('paused')
    expect(progressOf(s, flightOf(s))?.percent).toBe(paused)
    askCommand(s, 'recovery')
    advance(2 * TIMINGS.commandStepMs)
    expect(stateOf(s)).toBe('in_flight')
    advance(TIMINGS.taskMs + TIMINGS.landMs)
    expect(stateOf(s)).toBe('completed')
  })

  it('returns home: the task ends canceled with operator_return, and the operation aborts on landing', () => {
    const s = scenario()
    launchToFlight(s)
    advance(TIMINGS.takeOffMs)
    askCommand(s, 'return_home')
    advance(2 * TIMINGS.commandStepMs)
    expect(stateOf(s)).toBe('returning')
    expect(progressOf(s, flightOf(s))).toMatchObject({
      status: 'canceled',
      result: 322283,
      end_reason: 'operator_return',
    })
    advance(TIMINGS.returnHomeMs)
    expect(stateOf(s)).toBe('aborted')
    expect(operationOf(s)).toMatchObject({ end_reason: 'operator_return' })
    expect(flightOf(s)).toMatchObject({ end_reason: 'operator_return' })
    expect(movesOf(s).slice(-2)).toEqual([
      ['in_flight', 'returning', 'flight canceled'],
      ['returning', 'aborted', 'on the ground after the flight ended canceled'],
    ])
  })

  it('stops: every flight not ended is sent home, and the operation aborts with operator_stop', () => {
    const s = scenario()
    launchToFlight(s)
    advance(TIMINGS.takeOffMs)
    const stop = ask(s, 'stop')
    advance(TIMINGS.decideMs)
    expect(stop.status).toBe('accepted')
    expect(stateOf(s)).toBe('returning')
    const home = (s.tables.command_intents ?? []).filter((intent) => intent.verb === 'return_home')
    expect(home).toHaveLength(1)
    advance(2 * TIMINGS.commandStepMs + TIMINGS.returnHomeMs)
    expect(stateOf(s)).toBe('aborted')
    expect(operationOf(s)).toMatchObject({ end_reason: 'operator_stop' })
    expect(flightOf(s)).toMatchObject({ end_reason: 'operator_stop' })
    expect(endedPayloadOf(s, flightOf(s))).toEqual({
      status: 'canceled',
      result: 322283,
      end_reason: 'operator_stop',
    })
  })

  it('refuses a stop while the operation is not in flight', () => {
    const s = scenario()
    simulateToReady(s)
    const stop = ask(s, 'stop')
    advance(TIMINGS.decideMs)
    expect(stop.reasons).toEqual(['the operation is ready: only one in flight stops'])
  })

  it('marks each command pending, sent and accepted with result 0, each step commandStepMs apart', () => {
    const s = scenario()
    launchToFlight(s)
    const pause = askCommand(s, 'pause')
    expect(statusesOf(s, 'command_intent', String(pause.id))).toEqual(['pending'])
    advance(TIMINGS.commandStepMs)
    expect(statusesOf(s, 'command_intent', String(pause.id))).toEqual(['pending', 'sent'])
    advance(TIMINGS.commandStepMs)
    expect(statusesOf(s, 'command_intent', String(pause.id))).toEqual([
      'pending',
      'sent',
      'accepted',
    ])
    expect(pause).toMatchObject({ status: 'accepted', result: 0 })
    expect(
      s.tables.operation_events?.filter((event) => event.kind === 'command_outcome').at(-1)
        ?.payload,
    ).toEqual({
      verb: 'pause',
      status: 'accepted',
      result: 0,
    })
  })
})

describe('the log and the contracts it holds to', () => {
  it('holds every move the module makes to contracts/operations/lifecycle.json', () => {
    const listed = new Set(
      (
        contract('../../../../contracts/operations/lifecycle.json') as {
          transitions: { from: string; to: string }[]
        }
      ).transitions.map(({ from, to }) => `${from}>${to}`),
    )
    for (const [from, to] of MOVES)
      expect(listed.has(`${from}>${to}`), `${from} to ${to}`).toBe(true)
    expect(OPERATION_MOVES).toEqual(listed)
  })

  it('makes only moves the lifecycle lists, across a run that launches, pauses and aborts', () => {
    const s = scenario()
    launchToFlight(s)
    askCommand(s, 'pause')
    advance(2 * TIMINGS.commandStepMs)
    askCommand(s, 'return_home')
    advance(TIMINGS.decideMs + TIMINGS.returnHomeMs)
    for (const [from, to] of movesOf(s)) {
      expect(OPERATION_MOVES.has(`${from}>${to}`), `${from} to ${to}`).toBe(true)
      expect(MOVES).toContainEqual([from, to])
    }
    expect(stateOf(s)).toBe('aborted')
    expect(TERMINAL.has(String(stateOf(s)))).toBe(true)
  })

  it('writes every log entry under a kind of contracts/events/events.json, with its payload keys', () => {
    const s = scenario()
    launchToFlight(s)
    askCommand(s, 'pause')
    advance(2 * TIMINGS.commandStepMs)
    askCommand(s, 'return_home')
    advance(TIMINGS.decideMs + TIMINGS.returnHomeMs)
    expectLogHoldsTheContract(s.tables.operation_events ?? [])
    expect(Object.keys(EVENT_KINDS)).toEqual(expect.arrayContaining(kindsOf(s)))
  })

  it('judges the sixteen checks in the order the console shows them (src/operations/format.ts)', () => {
    const source = readFileSync(new URL('../../src/operations/format.ts', import.meta.url), 'utf8')
    const block = /CHECK_ORDER = \[([\s\S]*?)\] as const/.exec(source)?.[1] ?? ''
    const ids = [...block.matchAll(/'(PF-[A-Z-]+)'/g)].map((match) => match[1])
    expect(ids).toEqual([...PF_CHECK_IDS])
    expect(judgeChecks('2026-10-13T10:00:00.000Z').map((check) => check.check_id)).toEqual(ids)
    expect(STACK.simulatorMode).toBe(false)
  })
})

/** The keys the telemetry contract requires of every sample (contracts/broadcast/telemetry.schema.json). */
const CONTRACT_KEYS = (
  contract('../../../../contracts/broadcast/telemetry.schema.json') as { required: string[] }
).required

/** The samples the aircraft sent from the `from`th on, in order. */
const sentSince = (s: Scenario, from: number): Sample[] =>
  s.sent.slice(from).map(({ sample }) => sample)

/** The track rows a flight stored, in the order they were stored. */
const rowsOf = (s: Scenario, flight: Row): Row[] =>
  s.stored.filter((row) => row.flight_id === flight.id)

describe('the aircraft in the air', () => {
  it('stands on the ground at its takeoff point before any flight, sending a sample each tick and storing none', () => {
    const s = scenario()
    advance(3 * TIMINGS.telemetryTickMs)
    expect(s.sent).toHaveLength(3)
    for (const { organization, sample } of s.sent) {
      expect(organization).toBe(NORTH)
      expect(sample).toMatchObject({
        stack: 'lab',
        gateway_sn: 'SOTESTDOCK01',
        aircraft_sn: '1WNBH9E00A0042',
        latitude_deg: HOME[1],
        longitude_deg: HOME[0],
        height_m: 0,
        heading_deg: 0,
        home_distance_m: 0,
        battery_pct: 96,
        mode_code: MODES.idle,
      })
    }
    expect(s.stored).toEqual([])
  })

  it("sends every sample on the telemetry contract, each with exactly the contract's keys", () => {
    const s = scenario()
    launchToFlight(s)
    advance(TIMINGS.takeOffMs + TIMINGS.taskMs + TIMINGS.landMs)
    expect(s.sent.length).toBeGreaterThan(100)
    for (const { sample } of s.sent) {
      expect(Object.keys(sample).sort()).toEqual([...CONTRACT_KEYS].sort())
      expect(consoleSampleOf(sample)).not.toBeNull()
    }
  })

  it('starts its task on the ground at the takeoff point, and climbs straight up in automatic takeoff', () => {
    const s = scenario()
    launchToFlight(s)
    advance(TIMINGS.progressTickMs + 4 * TIMINGS.telemetryTickMs)
    // The simulation before the launch stored its own track too: this is the launch's.
    const own = rowsOf(s, flightOf(s))
    expect(own.length).toBeGreaterThan(0)
    expect(own[0]).toMatchObject({ latitude: HOME[1], longitude: HOME[0] })
    expect(Number(own[0]?.height_m)).toBeLessThan(30)
    const climbing = sentSince(s, 0).filter((sample) => sample.mode_code === MODES.automaticTakeoff)
    expect(climbing.length).toBeGreaterThan(0)
    for (const sample of climbing) {
      expect(sample.latitude_deg).toBeCloseTo(HOME[1], 9)
      expect(sample.longitude_deg).toBeCloseTo(HOME[0], 9)
      expect(sample.height_m).toBeGreaterThan(0)
      expect(sample.height_m).toBeLessThan(30)
    }
  })

  it('flies the wayline, then returns from its last waypoint and lands on the takeoff point, the modes in order', () => {
    const s = scenario()
    launchToFlight(s)
    advance(TIMINGS.takeOffMs + TIMINGS.taskMs + TIMINGS.landMs)
    expect(stateOf(s)).toBe('completed')
    const modes = sentSince(s, 0).map((sample) => sample.mode_code)
    const first = (mode: number): number => modes.indexOf(mode)
    expect(first(MODES.automaticTakeoff)).toBeGreaterThanOrEqual(0)
    expect(first(MODES.wayline)).toBeGreaterThan(first(MODES.automaticTakeoff))
    expect(first(MODES.automaticReturn)).toBeGreaterThan(first(MODES.wayline))
    expect(first(MODES.automaticLanding)).toBeGreaterThan(first(MODES.automaticReturn))
    const landed = s.sent.at(-1)?.sample
    expect(landed).toMatchObject({ height_m: 0, mode_code: MODES.idle, home_distance_m: 0 })
    expect(landed?.latitude_deg).toBeCloseTo(HOME[1], 9)
    expect(landed?.longitude_deg).toBeCloseTo(HOME[0], 9)
  })

  it('holds its position across the ticks of a pause, and resumes from it', () => {
    const s = scenario()
    launchToFlight(s)
    advance(TIMINGS.takeOffMs + 10 * TIMINGS.progressTickMs)
    askCommand(s, 'pause')
    advance(2 * TIMINGS.commandStepMs)
    expect(stateOf(s)).toBe('paused')
    const held = s.sent.length
    advance(5 * TIMINGS.telemetryTickMs)
    const paused = sentSince(s, held)
    expect(paused).toHaveLength(5)
    for (const sample of paused) {
      expect(sample).toMatchObject({
        latitude_deg: paused[0]?.latitude_deg,
        longitude_deg: paused[0]?.longitude_deg,
        height_m: paused[0]?.height_m,
        heading_deg: paused[0]?.heading_deg,
        mode_code: MODES.wayline,
      })
    }
    askCommand(s, 'recovery')
    advance(2 * TIMINGS.commandStepMs)
    const resumed = s.sent.length
    advance(4 * TIMINGS.telemetryTickMs)
    const moved = sentSince(s, resumed).at(-1)
    expect(moved?.latitude_deg).not.toBe(paused[0]?.latitude_deg)
    expect(moved?.longitude_deg).not.toBe(paused[0]?.longitude_deg)
  })

  it('returns home from where it stands: back above the takeoff point, down onto it, on the ground when the return is over', () => {
    const s = scenario()
    launchToFlight(s)
    advance(TIMINGS.takeOffMs + 10 * TIMINGS.progressTickMs)
    askCommand(s, 'return_home')
    advance(2 * TIMINGS.commandStepMs)
    const returning = s.sent.length
    advance(TIMINGS.returnHomeMs + TIMINGS.telemetryTickMs)
    const home = sentSince(s, returning)
    const modes = home.map((sample) => sample.mode_code)
    expect(modes).toContain(MODES.automaticReturn)
    expect(modes).toContain(MODES.automaticLanding)
    expect(modes.indexOf(MODES.automaticLanding)).toBeGreaterThan(
      modes.indexOf(MODES.automaticReturn),
    )
    expect(home.at(-1)).toMatchObject({ height_m: 0, mode_code: MODES.idle, home_distance_m: 0 })
    expect(home.at(-1)?.latitude_deg).toBeCloseTo(HOME[1], 9)
    expect(home.at(-1)?.longitude_deg).toBeCloseTo(HOME[0], 9)
    expect(stateOf(s)).toBe('aborted')
    expect(flightOf(s).landed_at).not.toBeNull()
  })

  it('flies a simulated flight the same way, lands it, and stores its track only while it is unended', () => {
    const s = scenario()
    simulateToReady(s)
    advance(TIMINGS.landMs)
    const simulated = flightOf(s, 'simulated')
    expect(s.stored.length).toBeGreaterThan(0)
    expect(new Set(s.stored.map((row) => row.flight_id))).toEqual(new Set([simulated.id]))
    for (const row of s.stored) {
      expect(String(row.sampled_at) <= String(simulated.ended_at)).toBe(true)
    }
    expect(s.sent.at(-1)?.sample).toMatchObject({ height_m: 0, mode_code: MODES.idle })
  })

  it("stores a flight's samples from its execute until it ends, in time order, and none after", () => {
    const s = scenario()
    launchToFlight(s)
    advance(TIMINGS.takeOffMs + TIMINGS.taskMs + TIMINGS.landMs)
    const flight = flightOf(s)
    expect(flight.ended_at).not.toBeNull()
    const executed = String(flight.executed_at)
    const ended = String(flight.ended_at)
    const own = rowsOf(s, flight)
    expect(own.length).toBeGreaterThan(100)
    for (const row of own) {
      expect(String(row.sampled_at) >= executed).toBe(true)
      expect(String(row.sampled_at) <= ended).toBe(true)
    }
    const times = own.map((row) => Date.parse(String(row.sampled_at)))
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(new Set(times).size).toBe(times.length)
    const count = s.stored.length
    advance(10 * TIMINGS.telemetryTickMs)
    expect(s.stored).toHaveLength(count)
  })
})

describe('the timers', () => {
  it("stops every timer on close, the aircraft's heartbeat included, so nothing is written after the fake stops", () => {
    const s = scenario()
    makeFlyable(s)
    const request = ask(s, 'plan')
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    s.lifecycle.close()
    advance(10 * TIMINGS.decideMs)
    expect(request.status).toBe('pending')
    expect(vi.getTimerCount()).toBe(0)
  })

  it("decides on the timings it is given, and the demo's for the rest", () => {
    const s = scenario()
    const quick = createLifecycle({
      db: s.db,
      roles: { canEdit: () => true },
      timings: { claimMs: 1, decideMs: 2 },
    })
    makeFlyable(s)
    const request = ask(s, 'plan')
    quick.transitionAsked(String(request.id))
    advance(2)
    expect(request.status).toBe('accepted')
  })
})
