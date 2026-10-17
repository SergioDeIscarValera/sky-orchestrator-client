// What soc-operations and soc-cloud do to an operation in the demo, played on the fake Supabase's
// tables (operation-tables.mjs). The decisions are soc-operations' own, ported from
// services/soc-operations/src/soc_operations/lifecycle.py: onRequest, onOutcome, onProgress and
// onChecks are pure functions of a snapshot of the operation, and the moves they make are the ones
// contracts/operations/lifecycle.json lists. The stack's side is soc-cloud's: it replies to each
// command, reports each flight's progress, and sees the aircraft take off and land. The stack's mode is
// state: its phone starts in simulator mode, turns to real mode once a simulation is ready (as its operator
// turns it), and back to simulator mode when its operation closes. The aircraft flies
// each task along the flight's stored route (aircraft.mjs has the pose), sends a sample every
// telemetryTickMs, heartbeat included, and a flight's samples are stored as its track. Those are timers,
// at the TIMINGS below, so a run is deterministic: a pose follows the elapsed times of the timers, and
// only the stamps of the samples read the clock.
import { createHash, randomUUID } from 'node:crypto'

import {
  groundMotion,
  landedMotion,
  MODES,
  progressedMotion,
  returnMotion,
  routeMotion,
  routeOf,
  sampleOf,
  tickedMotion,
} from './aircraft.mjs'
import { DatabaseError, TERMINAL } from './operation-tables.mjs'

/**
 * The demo's timings, in milliseconds from when each thing is asked or sent. A transition request is
 * claimed (running) and decided (accepted or refused) after claimMs and decideMs. A command intent is
 * sent and then answered, commandStepMs apart. A task runs from 0 to 100 percent in taskMs, its
 * progress written every progressTickMs, and the aircraft flies its route over the same time. The
 * aircraft sends a sample every telemetryTickMs. A flight's aircraft lands landMs after its task ends,
 * or returnHomeMs after a return home, simulated or real. A launch takes off takeOffMs after its
 * execute, real or in the simulator; a simulated pass never takes off. A simulated operation becomes ready readyMs after its simulation: until then its stack
 * stays in simulator mode, and the operation may launch in the simulator (FR-OPS-13).
 */
export const TIMINGS = Object.freeze({
  claimMs: 200,
  decideMs: 800,
  commandStepMs: 300,
  progressTickMs: 500,
  taskMs: 60_000,
  telemetryTickMs: 500,
  takeOffMs: 1_000,
  landMs: 20_000,
  returnHomeMs: 20_000,
  readyMs: 15_000,
})

/**
 * A flight's track keeps at most one sample a second, the first of each second, as soc-cloud keeps it
 * (IR-TEL-01, its HISTORY_SLOT_MS); the live samples carry every one.
 */
const HISTORY_SLOT_MS = 1000

/** The demo's configuration: the fingerprint its phone reports (soc-operations' config_fingerprint). */
const CONFIGURATION = 'demo-configuration'

/**
 * The status soc-cloud records for the demo's stack (soc.stacks.status): its mode, its phone's simulator
 * (on in simulator mode, off in real mode) and its configuration. The demo's stack starts in simulator mode.
 */
export function stackStatus(simulatorMode) {
  return {
    simulator_mode: simulatorMode,
    simulator_active: simulatorMode,
    config_fingerprint: CONFIGURATION,
  }
}

/** The moves this module makes. Each is one contracts/operations/lifecycle.json lists (a test holds it). */
export const MOVES = Object.freeze([
  ['draft', 'planned'],
  ['draft', 'cancelled'],
  ['planned', 'preparing'],
  ['planned', 'cancelled'],
  ['preparing', 'planned'],
  ['preparing', 'simulating'],
  ['preparing', 'cancelled'],
  ['simulating', 'simulated'],
  ['simulating', 'preparing'],
  ['simulated', 'ready'],
  ['simulated', 'cancelled'],
  ['simulated', 'launching'],
  ['ready', 'launching'],
  ['ready', 'cancelled'],
  ['launching', 'in_flight'],
  ['launching', 'ready'],
  ['launching', 'simulated'],
  ['in_flight', 'paused'],
  ['in_flight', 'returning'],
  ['paused', 'in_flight'],
  ['paused', 'returning'],
  ['returning', 'completed'],
  ['returning', 'aborted'],
  ['returning', 'simulated'],
])

/**
 * The fourteen preflight checks (FR-OPS-05) that do not depend on the stack's mode, with the values a
 * stack reads them at: each passes, against the config contract's own thresholds. PF-MODE and
 * PF-SIMULATOR are judged from the mode by modeChecks. PF-CLOCK is a warning and does not block.
 */
const PASSING = [
  [
    'PF-LINK',
    true,
    { link_state: 'connected', stack_link_state: 'up' },
    'The link to the stack is connected and up.',
  ],
  [
    'PF-ONLINE',
    true,
    { online: true, link_state: 'connected' },
    'The aircraft is online in the topology over a connected link.',
  ],
  [
    'PF-FRESH',
    true,
    { age_ms: 300 },
    'The latest telemetry sample was recorded 0.3 s ago, within telemetry_stale_after_ms 3000.',
  ],
  [
    'PF-GNSS',
    true,
    { satellites: 18, gps_quality: 5 },
    'Satellites 18 and positioning quality 5 reach min_satellites 12 and min_gps_quality 4.',
  ],
  [
    'PF-BATTERY',
    true,
    { battery_pct: 96 },
    'The battery is at 96%, at least min_battery_start_pct 50%.',
  ],
  ['PF-GROUNDED', true, { mode_code: 0 }, 'The aircraft is on the ground, in mode 0.'],
  [
    'PF-INSIDE',
    true,
    { distance_to_boundary_m: 412.5, distance_outside_m: null, above_ceiling_m: null },
    'The aircraft is inside the geofence, 412.5 m from its boundary.',
  ],
  [
    'PF-TAKEOFF',
    true,
    { distance_m: 0.4 },
    'The aircraft is 0.4 m from the takeoff point, within takeoff_tolerance_m 10.0 m.',
  ],
  ['PF-WAYLINE', true, { problems: [] }, "SOC's validation passes the wayline."],
  ['PF-SO-DRYRUN', true, null, "Sky Orchestrator's dry run accepts the flight file."],
  [
    'PF-ENVELOPE',
    true,
    { radius_m: 1000, envelope_max_height_m: 120, ceiling_m: 30 },
    "All 5 vertices lie within the envelope's 1000.0 m circle, and the 30.0 m ceiling is within its 120.0 m limit.",
  ],
  [
    'PF-ARMED',
    true,
    { armed: true, arming_remaining_s: 240 },
    'The phone is armed, with 240 s left, at least min_arming_left_s 120.',
  ],
  ['PF-IDLE', true, { stack_busy: false }, 'The stack has no unfinished flight.'],
  [
    'PF-CLOCK',
    false,
    { clock_offset_ms: 12, clock_warning: false },
    "The stack's clock is 12 ms off, with no clock warning.",
  ],
]

/** The sixteen check ids, in the console's order. */
export const PF_CHECK_IDS = Object.freeze([
  'PF-LINK',
  'PF-ONLINE',
  'PF-FRESH',
  'PF-GNSS',
  'PF-BATTERY',
  'PF-GROUNDED',
  'PF-INSIDE',
  'PF-TAKEOFF',
  'PF-WAYLINE',
  'PF-SO-DRYRUN',
  'PF-ENVELOPE',
  'PF-MODE',
  'PF-SIMULATOR',
  'PF-ARMED',
  'PF-IDLE',
  'PF-CLOCK',
])

/**
 * PF-MODE and PF-SIMULATOR as the stack's mode reads (soc-operations' _mode and _simulator): both name
 * the mode and pass in either mode, when the phone's simulator agrees with it. A mode the stack does not
 * report is unknown, and so is a simulator state it does not report; a disagreement fails and names the
 * one thing the operator must do on the phone. Both block, as every blocking check does.
 */
function modeChecks(stack, evaluatedAt) {
  const { simulatorMode: mode, simulatorActive: active } = stack
  const check = (check_id, state, value, detail) => ({
    check_id,
    state,
    blocking: true,
    value,
    detail,
    evaluated_at: evaluatedAt,
  })
  if (mode === null) {
    return [
      check('PF-MODE', 'unknown', { simulator_mode: null }, 'The stack reports no simulator mode.'),
      check(
        'PF-SIMULATOR',
        'unknown',
        { simulator_mode: null, simulator_active: active },
        "The stack's simulator mode is not known.",
      ),
    ]
  }
  const value = { simulator_mode: mode, simulator_active: active }
  const modeCheck = check(
    'PF-MODE',
    'pass',
    { simulator_mode: mode },
    mode ? 'The stack is in simulator mode.' : 'The stack is in real mode.',
  )
  if (active === null) {
    return [
      modeCheck,
      check('PF-SIMULATOR', 'unknown', value, "The phone's simulator state is not known."),
    ]
  }
  if (active !== mode) {
    const detail = mode
      ? "The stack is in simulator mode: turn the phone's simulator on"
      : "The stack is in real mode: turn the phone's simulator off"
    return [modeCheck, check('PF-SIMULATOR', 'fail', value, detail)]
  }
  const detail = mode
    ? "The phone's simulator is on, as simulator mode requires."
    : "The phone's simulator is off, as real mode requires."
  return [modeCheck, check('PF-SIMULATOR', 'pass', value, detail)]
}

/**
 * The checks as judged at `evaluatedAt`, for a stack in the state `stack` names: every check passes but
 * the two mode checks, which name the mode the stack is in (modeChecks), in the console's order.
 */
export function judgeChecks(evaluatedAt, stack) {
  const passing = PASSING.map(([check_id, blocking, value, detail]) => ({
    check_id,
    state: 'pass',
    blocking,
    value,
    detail,
    evaluated_at: evaluatedAt,
  }))
  const armed = passing.findIndex((check) => check.check_id === 'PF-ARMED')
  return [...passing.slice(0, armed), ...modeChecks(stack, evaluatedAt), ...passing.slice(armed)]
}

/** DJI's result for a return home the operator sent (soc-cloud's END_RESULTS: USER_SEND_RTH). */
const RETURN_HOME_RESULT = 322283
/** The modes of the two moments the log records: automatic takeoff, and idle once on the ground. */
const TOOK_OFF_MODE = MODES.automaticTakeoff
const LANDED_MODE = MODES.idle
/** The lowest return-to-home altitude Sky Orchestrator sends (soc-operations' LEAST_RTH_ALTITUDE_M). */
const LEAST_RTH_ALTITUDE_M = 20
/** The flight statuses that end a task (soc-cloud's TERMINAL). */
const TERMINAL_STATUSES = new Set([
  'ok',
  'failed',
  'canceled',
  'rejected',
  'timeout',
  'partially_done',
])
/** How an operation closes, by how its flight ended (soc-operations' CLOSING). */
const CLOSING = {
  completed: 'completed',
  operator_stop: 'aborted',
  operator_return: 'aborted',
  geofence_breach: 'aborted',
  cancelled: 'aborted',
}
const CANCELLABLE = new Set(['draft', 'planned', 'preparing', 'simulated', 'ready'])

const refuse = (...reasons) => ({ accepted: false, reasons, actions: [] })
const accept = (...actions) => ({ accepted: true, reasons: [], actions })
const move = (to, cause, endReason = null) => ({ type: 'move', to, cause, endReason })
const logged = (kind, payload) => ({ type: 'log', kind, payload })
const command = (verb, flight, payload) => ({ type: 'command', verb, flight, payload })
const executed = (flight) => ({ type: 'executed', flight })
const end = (flight, endReason) => ({ type: 'end', flight, endReason })

/** What keeps the operation from being planned (validation.py's plan_problems), each named. */
export function planProblems(snapshot) {
  const found = []
  if (snapshot.takeoffSecurityHeightM === null) found.push('the operation has no height')
  if (snapshot.assignments.length === 0) found.push('the operation assigns no wayline to a fleet')
  for (const assignment of snapshot.assignments) {
    if (assignment.speedMs === null) {
      found.push(`the fleet ${assignment.fleet.name} has no speed for its wayline`)
    }
    if (assignment.flight === null)
      found.push('the wayline has not been flown for this operation yet')
  }
  if (snapshot.pilots < 1)
    found.push('the operation has no pilot who is an editor of its organization')
  return found
}

const blockingReasons = (checks) =>
  checks
    .filter((check) => check.blocking && check.state !== 'pass')
    .map((check) => `${check.check_id}: ${check.detail}`)

/** The newest simulation of the current file that ended ok (soc-operations' Snapshot.simulation). */
function simulationOf(snapshot) {
  if (snapshot.file === null) return null
  return (
    snapshot.flights.find(
      (flight) =>
        flight.mode === 'simulated' && flight.fileId === snapshot.file.id && flight.status === 'ok',
    ) ?? null
  )
}

/** What keeps a simulated operation from being ready, each named (soc-operations' ready_problems). */
export function readyProblems(snapshot, checks) {
  const problems = blockingReasons(checks)
  const simulation = simulationOf(snapshot)
  if (simulation === null) problems.push('this file has not completed a simulation')
  if (snapshot.stack.simulatorMode !== false) problems.push('the stack is not in real mode')
  if (simulation !== null && simulation.configFingerprint !== snapshot.stack.configFingerprint) {
    problems.push(
      `the phone's configuration changed since the simulation: simulate again (simulated under ${String(simulation.configFingerprint)}, now ${snapshot.stack.configFingerprint})`,
    )
  }
  return problems
}

/** The checks as the log keeps them: each one's id, state, blocking and detail (no value). */
const summaries = (checks) =>
  checks.map(({ check_id, state, blocking, detail }) => ({ check_id, state, blocking, detail }))

/** DJI's prepare for a flight of the current file (soc-operations' _prepare_payload). */
function prepareOf(snapshot, mode) {
  const assignment = snapshot.assignments[0]
  const takeoff = assignment?.wayline.takeoff ?? [null, null]
  return {
    task_type: 0,
    wayline_type: 0,
    rth_altitude: Math.max(
      LEAST_RTH_ALTITUDE_M,
      Math.ceil(Number(snapshot.takeoffSecurityHeightM)),
    ),
    out_of_control_action: 0,
    exit_wayline_when_rc_lost: 0,
    simulate_mission: {
      is_enable: mode === 'simulated' ? 1 : 0,
      latitude: takeoff[1],
      longitude: takeoff[0],
    },
  }
}

const prepared = (snapshot, mode) => ({ type: 'prepare', mode, payload: prepareOf(snapshot, mode) })

function planned(snapshot, ...actions) {
  const problems = planProblems(snapshot)
  return problems.length > 0 ? refuse(...problems) : accept(...actions)
}

/** FR-OPS-06: every blocking check passing, with a flight of the assignment to simulate. */
function onSimulate(snapshot, checks) {
  if (snapshot.state !== 'preparing')
    return refuse(`the operation is ${snapshot.state}, not preparing`)
  const reasons = blockingReasons(checks)
  // A simulation runs in simulator mode, and only then (soc-operations' _simulate).
  if (snapshot.stack.simulatorMode !== true) {
    reasons.push(
      snapshot.stack.simulatorMode === false
        ? 'the stack is in real mode: a simulation needs simulator mode'
        : "the stack's mode is not known",
    )
  }
  const assignment = snapshot.assignments[0]
  if (snapshot.file === null) reasons.push('the operation has no flight file: prepare it again')
  if (snapshot.takeoffSecurityHeightM === null || assignment === undefined) {
    reasons.push('the operation has no height or no assignment')
  } else if (assignment.flight === null) {
    reasons.push('the wayline has not been flown for this operation yet')
  }
  if (reasons.length > 0) return refuse(...reasons)
  return accept(
    logged('checks_at_simulation', { checks: summaries(checks) }),
    prepared(snapshot, 'simulated'),
    move('simulating', 'simulate'),
  )
}

/**
 * FR-OPS-13: from simulated, in simulator mode, the file flown again in the simulator as a launch
 * (soc-operations' _launch_in_simulator).
 */
function onLaunchInSimulator(snapshot, checks) {
  const reasons = blockingReasons(checks)
  if (snapshot.stack.simulatorMode !== true) {
    reasons.push(
      snapshot.stack.simulatorMode === false
        ? 'the stack is in real mode: the operation becomes ready on its own'
        : "the stack's mode is not known",
    )
  }
  if (simulationOf(snapshot) === null) reasons.push('this file has not completed a simulation')
  if (snapshot.takeoffSecurityHeightM === null || snapshot.assignments.length === 0) {
    reasons.push('the operation has no height or no assignment')
  }
  if (reasons.length > 0) return refuse(...reasons)
  return accept(
    logged('checks_at_launch', { checks: summaries(checks), mode: 'simulated' }),
    prepared(snapshot, 'simulated'),
    move('launching', 'launch in the simulator'),
  )
}

/** FR-OPS-09: from ready, the same file prepared for real, once every condition of ready holds. */
function onLaunch(snapshot, checks) {
  if (snapshot.state === 'simulated') return onLaunchInSimulator(snapshot, checks)
  if (snapshot.state !== 'ready') return refuse(`the operation is ${snapshot.state}, not ready`)
  const reasons = readyProblems(snapshot, checks)
  if (snapshot.takeoffSecurityHeightM === null || snapshot.assignments.length === 0) {
    reasons.push('the operation has no height or no assignment')
  }
  if (reasons.length > 0) return refuse(...reasons)
  return accept(
    logged('checks_at_launch', { checks: summaries(checks) }),
    prepared(snapshot, 'real'),
    move('launching', 'launch'),
  )
}

/** FR-CMD-04: every aircraft of the operation home; the operation ends aborted on landing. */
function onStop(snapshot) {
  if (snapshot.state !== 'in_flight' && snapshot.state !== 'paused') {
    return refuse(`the operation is ${snapshot.state}: only one in flight stops`)
  }
  const flying = snapshot.flights.filter((flight) => !flight.ended)
  return accept(
    ...flying.map((flight) => command('return_home', flight.id, {})),
    move('returning', 'stop'),
  )
}

/** A member asks the operation to move: accepted with the actions it takes, or refused with every reason. */
export function onRequest(snapshot, transition, checks) {
  const { state } = snapshot
  switch (transition) {
    case 'plan':
      if (state !== 'draft') return refuse(`the operation is ${state}, not a draft`)
      return planned(snapshot, move('planned', 'plan'))
    case 'prepare':
      if (state !== 'planned') return refuse(`the operation is ${state}, not planned`)
      return planned(snapshot, { type: 'build' }, move('preparing', 'prepare'))
    case 'unprepare':
      if (state !== 'preparing') return refuse(`the operation is ${state}, not preparing`)
      return accept(move('planned', 'unprepare'))
    case 'cancel':
      if (!CANCELLABLE.has(state)) return refuse(`an operation ${state} cannot be cancelled`)
      return accept(move('cancelled', 'cancel'))
    case 'simulate':
      return onSimulate(snapshot, checks)
    case 'launch':
      return onLaunch(snapshot, checks)
    case 'stop':
      return onStop(snapshot)
    default:
      return refuse(`no transition ${transition}`)
  }
}

/**
 * A command the stack accepted: prepare then execute, as soc-operations sends them. The demo's stack
 * accepts every command, so the refused branch of soc-operations' on_outcome is not played.
 */
export function onOutcome(snapshot, { verb, flight, status }) {
  const found = snapshot.flights.find((each) => each.id === flight)
  if (found === undefined || found.ended) return accept()
  if (snapshot.state !== 'simulating' && snapshot.state !== 'launching') return accept()
  if (status !== 'accepted') return accept()
  if (verb === 'prepare') {
    // An undo asked while the prepare was outstanding cancels the flight: it is never executed.
    return accept(...(found.undoPending ? [] : [command('execute', flight, { flight_id: flight })]))
  }
  if (verb === 'execute') {
    return snapshot.state === 'launching'
      ? accept(executed(flight), move('in_flight', 'executing'))
      : accept(executed(flight))
  }
  return accept()
}

function endReasonOf(snapshot, flight) {
  if (snapshot.stopped) return 'operator_stop'
  if (flight.endReason !== null) return flight.endReason
  return flight.status === 'ok' ? 'completed' : 'aircraft_fault'
}

/** Moves the operation on what its flight reports (soc-operations' on_progress). */
export function onProgress(snapshot, flightId) {
  const flight = snapshot.flights.find((each) => each.id === flightId)
  if (flight === undefined || flight.status === null) return accept()
  const { status } = flight
  let { state } = snapshot
  // The simulated pass (FR-OPS-06); a launch in the simulator moves as a real one does (FR-OPS-13).
  if (state === 'simulating') {
    if (!TERMINAL_STATUSES.has(status) || flight.ended) return accept()
    if (status === 'ok')
      return accept(end(flightId, 'completed'), move('simulated', 'simulation ok'))
    const reason = flight.endReason ?? 'aircraft_fault'
    return accept(end(flightId, reason), move('preparing', `simulation ${status}: ${reason}`))
  }
  if (status === 'paused' && state === 'in_flight') return accept(move('paused', 'flight paused'))
  if (status === 'in_progress' && (state === 'launching' || state === 'paused')) {
    return accept(move('in_flight', 'flight in progress'))
  }
  if (!TERMINAL_STATUSES.has(status) || flight.ended) return accept()
  if (state === 'launching' && !flight.tookOff) {
    // The task ended before the aircraft flew: the launch did not settle into a flight.
    const reason = endReasonOf(snapshot, flight)
    return accept(
      end(flightId, reason),
      move(
        flight.mode === 'simulated' ? 'simulated' : 'ready',
        `the launch ended ${status} before take-off: ${reason}`,
      ),
    )
  }
  const actions = []
  if (state === 'launching') {
    actions.push(move('in_flight', 'flight in progress'))
    state = 'in_flight'
  }
  if (state === 'in_flight' || state === 'paused')
    actions.push(move('returning', `flight ${status}`))
  else if (state !== 'returning') return accept()
  // Closed once the aircraft stands on the ground: landed, or it never took off.
  if (flight.landed || !flight.tookOff) {
    const reason = endReasonOf(snapshot, flight)
    actions.push(
      end(flightId, reason),
      // FR-OPS-13: a launch in the simulator never closes the operation.
      flight.mode === 'simulated'
        ? move(
            'simulated',
            `on the ground in the simulator after the flight ended ${status}: ${reason}`,
          )
        : move(
            CLOSING[reason] ?? 'failed',
            `on the ground after the flight ended ${status}`,
            reason,
          ),
    )
  }
  return accept(...actions)
}

/** A simulated operation becomes ready while every condition holds (soc-operations' on_checks). */
export function onChecks(snapshot, checks) {
  if (snapshot.state === 'simulated' && readyProblems(snapshot, checks).length === 0) {
    return accept(move('ready', 'every condition of ready holds'))
  }
  return accept()
}

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * The play: soc-operations and soc-cloud on `db` (operation-tables.mjs), with the timers of TIMINGS.
 * `transitionAsked` and `commandAsked` are called once for each request the database inserted;
 * `close` clears every timer, so the process can exit. `onError` hears an error a timer met.
 *
 * `aircraft` is the demo's aircraft: its organization, its stack and gateway and aircraft, and its
 * takeoff point ([longitude, latitude]), where it stands before its first flight. With it, the aircraft
 * sends a sample every telemetryTickMs through `telemetry.send(organization, sample)`, and the samples
 * of a flight are handed to `telemetry.store(row)` as its track while the flight is unended. Without
 * it, the lifecycle sends no telemetry.
 */
export function createLifecycle({
  db,
  roles,
  timings: given = {},
  onError = (error) => console.error(error),
  aircraft = null,
  telemetry = { send: () => undefined, store: () => undefined },
}) {
  const timings = { ...TIMINGS, ...given }
  const pending = new Set()
  /** Each operation's flight file, built at its last prepare: its id and its md5. */
  const files = new Map()
  /** How many waypoints each flight's stored flight has: the waypoint its progress follows. */
  const waypointCounts = new Map()
  /** Each flight's route, as the aircraft flies it, built at its prepare (null when it has no waypoint). */
  const routes = new Map()
  /** Each flight's task: whether it runs, and the timers that drive it. */
  const tasks = new Map()
  /** The flights a launch prepared, real or in the simulator: they take off and land (FR-OPS-13). */
  const launched = new Set()
  /** The aircraft's motion: what it stands on, flies or returns along. Starts on the ground at home. */
  let motion = groundMotion(aircraft?.home ?? [0, 0])
  /** The flight the aircraft last started flying: its samples are stored while it is unended. */
  let flightInAir = null
  /** The second of the last sample stored as a track row: one a second at most (HISTORY_SLOT_MS). */
  let storedSlot = -Infinity
  /** How many returns home the aircraft has begun: each numbered, so only its own landing lands it. */
  let returns = 0
  let closed = false

  function schedule(ms, action) {
    if (closed) return null
    const timer = setTimeout(() => {
      pending.delete(timer)
      try {
        action()
      } catch (error) {
        onError(error)
      }
    }, ms)
    timer.unref?.()
    pending.add(timer)
    return timer
  }

  function cancel(timer) {
    if (timer === null || timer === undefined) return
    clearTimeout(timer)
    pending.delete(timer)
  }

  function snapshotOf(operationId) {
    const operation = db.rows('operations').find((row) => row.id === operationId)
    if (operation === undefined)
      throw new DatabaseError('P0002', `operation ${operationId} does not exist`)
    const fleets = db.rows('fleets')
    const waylines = db.rows('waylines')
    const commands = db.rows('command_intents')
    const states = db.rows('flight_states')
    const assignments = db
      .rows('assignments')
      .filter((row) => row.operation_id === operationId)
      .map((row) => {
        const fleet = fleets.find((each) => each.id === row.fleet_id)
        const wayline = waylines.find((each) => each.id === row.wayline_id)
        return {
          id: row.id,
          speedMs: row.speed_ms,
          flight: row.flight,
          fleet: {
            id: row.fleet_id,
            name: fleet?.name ?? '',
            gatewaySn: fleet?.gateway_sn ?? '',
            aircraftSn: fleet?.aircraft_sn ?? '',
          },
          wayline: { name: wayline?.name ?? '', takeoff: wayline?.takeoff ?? null },
        }
      })
    const pilots = db
      .rows('operators')
      .filter(
        (row) =>
          row.operation_id === operationId &&
          row.role === 'pilot' &&
          roles.canEdit(operation.organization_id, row.profile_id),
      ).length
    const newest = db
      .rows('flights')
      .filter((row) => row.operation_id === operationId)
      .at(-1)
    // Newest first, as soc-operations reads them.
    const flights = db
      .rows('flights')
      .filter((row) => row.operation_id === operationId)
      .reverse()
      .map((row) => {
        const state = states.find((each) => each.flight_id === row.id)
        return {
          id: row.id,
          mode: row.mode,
          fileId: row.file_id,
          configFingerprint: row.config_fingerprint,
          executed: row.executed_at !== null,
          tookOff: row.took_off_at !== null,
          landed: row.landed_at !== null,
          ended: row.ended_at !== null,
          status: state?.status ?? null,
          result: state?.result ?? null,
          endReason: state?.end_reason ?? null,
          undoPending: commands.some(
            (each) =>
              each.flight_id === row.id &&
              each.verb === 'undo' &&
              (each.status === 'pending' || each.status === 'sent'),
          ),
        }
      })
    return {
      operationId,
      organizationId: operation.organization_id,
      state: operation.state,
      takeoffSecurityHeightM: operation.takeoff_security_height_m,
      assignments,
      pilots,
      flights,
      file: files.get(operationId) ?? null,
      // A stop is its flight's: a launch in the simulator stopped says nothing of the next one.
      stopped: db
        .rows('transition_requests')
        .some(
          (row) =>
            row.operation_id === operationId &&
            row.transition === 'stop' &&
            row.status === 'accepted' &&
            newest !== undefined &&
            Date.parse(row.decided_at) >= Date.parse(newest.prepared_at),
        ),
      stack: stackOf(),
    }
  }

  function flightRow(flightId) {
    const flight = db.rows('flights').find((row) => row.id === flightId)
    if (flight === undefined) throw new DatabaseError('P0002', `flight ${flightId} does not exist`)
    return flight
  }

  /** The row of the demo's stack (soc.stacks), or undefined when there is no aircraft to fly. */
  function stackRow() {
    if (aircraft === null) return undefined
    return db.rows('stacks').find((row) => row.gateway_sn === aircraft.gatewaySn)
  }

  /** The stack as soc-operations reads it: its mode, its phone's simulator and its configuration; null where unknown. */
  function stackOf() {
    const status = stackRow()?.status ?? null
    return {
      simulatorMode: status?.simulator_mode ?? null,
      simulatorActive: status?.simulator_active ?? null,
      configFingerprint: status?.config_fingerprint ?? null,
    }
  }

  /**
   * The demo's phone turns to its simulator (`simulatorMode` true) or to real mode, as its operator turns
   * it. Its row is written, and the write is broadcast as a stack change; a phone already in that mode is left.
   */
  function setStackMode(simulatorMode) {
    const row = stackRow()
    if (row === undefined || row.status?.simulator_mode === simulatorMode) return
    db.updateRow('stacks', row, {
      status: { ...row.status, ...stackStatus(simulatorMode) },
      updated_at: new Date().toISOString(),
    })
  }

  function waypointAt(flightId, fraction) {
    const count = waypointCounts.get(flightId) ?? 0
    return count === 0 ? null : Math.min(count - 1, Math.floor(fraction * count))
  }

  /** The progress a flight stands at, as soc-cloud last recorded it: its percent and waypoint. */
  function standingOf(flightId) {
    const state = db.rows('flight_states').find((row) => row.flight_id === flightId)
    return { percent: state?.percent ?? 0, waypoint: state?.current_waypoint_index ?? null }
  }

  function progressTo(flightId, status, fields) {
    if (db.recordProgress(flightId, status, fields).changed) decideProgress(flightId)
  }

  /** soc-operations' on_progress for a flight, applied: the move and the end it makes. */
  function decideProgress(flightId) {
    const snapshot = snapshotOf(flightRow(flightId).operation_id)
    apply(snapshot, onProgress(snapshot, flightId).actions, null)
  }

  /** The database's write of each action soc-operations decided (store.py's apply). */
  function apply(snapshot, actions, actor) {
    const operation = snapshot.operationId
    for (const action of actions) {
      switch (action.type) {
        case 'move':
          db.move(operation, action.to, action.cause, 'soc-operations', actor, action.endReason)
          if (action.to === 'simulated') schedule(timings.readyMs, () => becomeReady(operation))
          // The operator readies the phone's simulator again once its operation is closed.
          if (TERMINAL.has(action.to)) setStackMode(true)
          break
        case 'build':
          buildFile(snapshot)
          break
        case 'prepare':
          startFlight(snapshot, action.mode, action.payload)
          break
        case 'command':
          createCommand(action.flight, action.verb, action.payload)
          break
        case 'executed':
          markExecuted(action.flight)
          break
        case 'end':
          endFlight(action.flight, action.endReason)
          break
        case 'log':
          db.log(operation, action.kind, 'soc-operations', action.payload)
          break
        default:
          throw new Error(`no action ${String(action.type)}`)
      }
    }
  }

  function buildFile(snapshot) {
    const assignment = snapshot.assignments[0]
    if (assignment === undefined || assignment.flight === null) {
      throw new DatabaseError('23514', 'the operation has no flight to build')
    }
    const md5 = createHash('md5').update(JSON.stringify(assignment.flight)).digest('hex')
    files.set(snapshot.operationId, { id: randomUUID(), md5 })
  }

  function startFlight(snapshot, mode, payload) {
    const assignment = snapshot.assignments[0]
    const file = files.get(snapshot.operationId)
    if (assignment === undefined || file === undefined) {
      throw new DatabaseError('23514', 'the flight has no assignment or no file')
    }
    const flight = db.insertRow('flights', {
      id: randomUUID(),
      organization_id: snapshot.organizationId,
      operation_id: snapshot.operationId,
      assignment_id: assignment.id,
      fleet_id: assignment.fleet.id,
      gateway_sn: assignment.fleet.gatewaySn,
      aircraft_sn: assignment.fleet.aircraftSn,
      mode,
      file_id: file.id,
      geofence_snapshot: null,
      envelope_snapshot: null,
      config_fingerprint: snapshot.stack.configFingerprint,
      prepared_at: new Date().toISOString(),
      executed_at: null,
      took_off_at: null,
      landed_at: null,
      breached_at: null,
      ended_at: null,
      end_reason: null,
    })
    const count = Array.isArray(assignment.flight.waypoints)
      ? assignment.flight.waypoints.length
      : 0
    waypointCounts.set(flight.id, count)
    routes.set(flight.id, routeOf(assignment.flight.waypoints))
    // A simulated pass is prepared from preparing; a launch from ready, or from simulated in the simulator.
    if (snapshot.state !== 'preparing') launched.add(flight.id)
    db.log(
      snapshot.operationId,
      'flight_prepared',
      'soc-operations',
      { mode, md5: file.md5 },
      { flight: flight.id, fleet: flight.fleet_id },
    )
    createCommand(flight.id, 'prepare', { flight_id: flight.id, ...payload })
  }

  /** A command soc-operations sends: pending, then sent and accepted on the stack's replies. */
  function createCommand(flightId, verb, payload) {
    const flight = flightRow(flightId)
    const intent = db.insertRow('command_intents', {
      id: randomUUID(),
      client_request_id: randomUUID(),
      organization_id: flight.organization_id,
      operation_id: flight.operation_id,
      flight_id: flightId,
      gateway_sn: flight.gateway_sn,
      verb,
      payload,
      status: 'pending',
      result: null,
      requested_by: null,
      requested_at: new Date().toISOString(),
      sent_at: null,
      replied_at: null,
    })
    commandSteps(intent.id)
    return intent
  }

  function commandSteps(intentId) {
    schedule(timings.commandStepMs, () => db.claimCommand(intentId))
    schedule(2 * timings.commandStepMs, () => answerCommand(intentId))
  }

  function answerCommand(intentId) {
    const intent = db.replyCommand(intentId, 0)
    if (intent !== null) effectOf(intent)
  }

  /** What an accepted command does on the stack: the flight it is for moves, as soc-cloud reports it. */
  function effectOf(intent) {
    const { verb, flight_id: flightId } = intent
    if (verb === 'prepare' || verb === 'execute') {
      const snapshot = snapshotOf(intent.operation_id)
      const decision = onOutcome(snapshot, { verb, flight: flightId, status: 'accepted' })
      apply(snapshot, decision.actions, null)
      if (verb === 'execute' && decision.actions.some((action) => action.type === 'executed')) {
        startTask(flightId)
      }
      return
    }
    if (verb === 'pause') pauseTask(flightId)
    else if (verb === 'recovery') resumeTask(flightId)
    else if (verb === 'return_home') returnHome(flightId)
    else if (verb === 'undo') undoTask(flightId)
  }

  function markExecuted(flightId) {
    const flight = flightRow(flightId)
    if (flight.executed_at === null)
      db.updateRow('flights', flight, { executed_at: new Date().toISOString() })
  }

  function startTask(flightId) {
    flyRoute(flightId)
    const task = { running: true, stopped: false, elapsedMs: 0, timer: null }
    tasks.set(flightId, task)
    progressTo(flightId, 'in_progress', {
      percent: 0,
      waypoint: waypointAt(flightId, 0),
      result: null,
    })
    task.timer = schedule(timings.progressTickMs, () => tick(flightId))
    if (launched.has(flightId)) schedule(timings.takeOffMs, () => takeOff(flightId))
  }

  function tick(flightId) {
    const task = tasks.get(flightId)
    if (task === undefined || !task.running || flightRow(flightId).ended_at !== null) return
    task.elapsedMs = Math.min(timings.taskMs, task.elapsedMs + timings.progressTickMs)
    motion = progressedMotion(motion, flightId, task.elapsedMs)
    if (task.elapsedMs >= timings.taskMs) {
      finishTask(flightId)
      return
    }
    db.recordProgress(flightId, 'in_progress', {
      percent: Math.floor((100 * task.elapsedMs) / timings.taskMs),
      waypoint: waypointAt(flightId, task.elapsedMs / timings.taskMs),
      result: null,
    })
    task.timer = schedule(timings.progressTickMs, () => tick(flightId))
  }

  function finishTask(flightId) {
    const task = tasks.get(flightId)
    if (task !== undefined) task.running = false
    motion = progressedMotion(motion, flightId, timings.taskMs)
    progressTo(flightId, 'ok', {
      result: 0,
      percent: 100,
      waypoint: waypointAt(flightId, 1),
      endReason: 'completed',
    })
    aircraftReturns(timings.landMs)
    if (launched.has(flightId)) schedule(timings.landMs, () => land(flightId))
  }

  function takeOff(flightId) {
    const task = tasks.get(flightId)
    if (task === undefined || task.stopped || flightRow(flightId).ended_at !== null) return
    db.recordMoment(flightId, 'took_off', new Date().toISOString(), TOOK_OFF_MODE)
  }

  function land(flightId) {
    const flight = flightRow(flightId)
    if (flight.landed_at !== null || flight.ended_at !== null) return
    db.recordMoment(flightId, 'landed', new Date().toISOString(), LANDED_MODE)
    decideProgress(flightId)
  }

  function stopTask(flightId) {
    const task = tasks.get(flightId)
    if (task === undefined) return
    task.running = false
    task.stopped = true
    cancel(task.timer)
  }

  function pauseTask(flightId) {
    const task = tasks.get(flightId)
    if (flightRow(flightId).ended_at !== null) return
    if (task !== undefined && task.running) {
      task.running = false
      cancel(task.timer)
    }
    progressTo(flightId, 'paused', standingOf(flightId))
  }

  function resumeTask(flightId) {
    const task = tasks.get(flightId)
    if (task === undefined || task.stopped || task.running || flightRow(flightId).ended_at !== null)
      return
    progressTo(flightId, 'in_progress', standingOf(flightId))
    task.running = true
    task.timer = schedule(timings.progressTickMs, () => tick(flightId))
  }

  function returnHome(flightId) {
    const flight = flightRow(flightId)
    if (flight.ended_at !== null) return
    stopTask(flightId)
    progressTo(flightId, 'canceled', {
      ...standingOf(flightId),
      result: RETURN_HOME_RESULT,
      endReason: 'operator_return',
    })
    aircraftReturns(timings.returnHomeMs)
    if (launched.has(flight.id)) schedule(timings.returnHomeMs, () => land(flightId))
  }

  function undoTask(flightId) {
    if (flightRow(flightId).ended_at !== null) return
    stopTask(flightId)
    progressTo(flightId, 'canceled', {
      percent: 0,
      waypoint: null,
      result: 0,
      endReason: 'cancelled',
    })
  }

  /** A flight's task starts: the aircraft takes its route, and the flight's samples are stored from now. */
  function flyRoute(flightId) {
    flightInAir = flightId
    storedSlot = -Infinity
    const route = routes.get(flightId) ?? null
    if (route !== null) motion = routeMotion(route, timings.taskMs, flightId)
  }

  /**
   * The aircraft returns home from where it is, over `durationMs`, and stands on its takeoff point once
   * that time is up. A return already under way is not begun again.
   */
  function aircraftReturns(durationMs) {
    if (motion.kind === 'return') return
    returns += 1
    const returnId = returns
    motion = returnMotion(motion, durationMs, returnId)
    schedule(durationMs, () => {
      if (motion.kind === 'return' && motion.returnId === returnId) motion = landedMotion(motion)
    })
  }

  /**
   * One telemetry tick: the aircraft's sample is sent, and it is stored as a row of the flight in the air
   * while that flight is unended. The next tick is set first, so an error in this one, which schedule
   * reports, does not stop the heartbeat.
   */
  function telemetryTick() {
    schedule(timings.telemetryTickMs, telemetryTick)
    const nowMs = Date.now()
    const sample = sampleOf(motion, aircraft, nowMs)
    telemetry.send(aircraft.organizationId, sample)
    const slot = Math.floor(nowMs / HISTORY_SLOT_MS)
    if (flightInAir !== null && flightRow(flightInAir).ended_at === null && slot > storedSlot) {
      storedSlot = slot
      telemetry.store({
        flight_id: flightInAir,
        sampled_at: new Date(nowMs).toISOString(),
        latitude: sample.latitude_deg,
        longitude: sample.longitude_deg,
        height_m: sample.height_m,
      })
    }
    motion = tickedMotion(motion, timings.telemetryTickMs)
  }

  function endFlight(flightId, reason) {
    const flight = flightRow(flightId)
    if (flight.ended_at !== null) return
    const state = db.rows('flight_states').find((row) => row.flight_id === flightId)
    db.updateRow('flights', flight, { ended_at: new Date().toISOString(), end_reason: reason })
    db.log(
      flight.operation_id,
      'flight_ended',
      'soc-operations',
      { status: state?.status ?? null, result: state?.result ?? null, end_reason: reason },
      { flight: flightId, fleet: flight.fleet_id },
    )
  }

  function becomeReady(operationId) {
    if (snapshotOf(operationId).state !== 'simulated') return
    // The operator turns the phone to real mode once its simulation is through: then the checks are judged.
    setStackMode(false)
    const snapshot = snapshotOf(operationId)
    const checks = judgeChecks(new Date().toISOString(), snapshot.stack)
    db.recordChecks(operationId, checks)
    apply(snapshot, onChecks(snapshot, checks).actions, null)
  }

  /** soc-operations' runner: the request is claimed, judged on the checks, decided, and applied. */
  function decideRequest(requestId) {
    const request = db.rows('transition_requests').find((row) => row.id === requestId)
    if (request === undefined || request.status !== 'running') return
    try {
      const snapshot = snapshotOf(request.operation_id)
      const checks = judgeChecks(new Date().toISOString(), snapshot.stack)
      db.recordChecks(request.operation_id, checks)
      const decision = onRequest(snapshot, request.transition, checks)
      apply(snapshot, decision.actions, request.requested_by)
      db.decideTransition(requestId, decision.accepted ? 'accepted' : 'refused', decision.reasons)
    } catch (error) {
      onError(error)
      db.decideTransition(requestId, 'failed', [
        `soc-operations could not decide it: ${messageOf(error)}`,
      ])
    }
  }

  if (aircraft !== null) schedule(timings.telemetryTickMs, telemetryTick)
  return {
    /** A transition request was asked: claimed after claimMs, decided after decideMs. */
    transitionAsked(requestId) {
      schedule(timings.claimMs, () => db.claimTransition(requestId))
      schedule(timings.decideMs, () => decideRequest(requestId))
    },
    /** A pilot's command was asked: sent, then accepted, commandStepMs apart. */
    commandAsked: commandSteps,
    /** Clears every timer: nothing runs after it, and the process may exit. */
    close() {
      closed = true
      for (const timer of pending) clearTimeout(timer)
      pending.clear()
      tasks.clear()
    },
  }
}
