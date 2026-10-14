// The operations' tables as the database holds and broadcasts them (migrations 0004 and 0010): the
// functions soc-operations and soc-cloud call, the log entries the database writes with them, and
// the broadcast each change makes on the organization's state topic (ADR-0007). The demo's fake
// Supabase answers the tables and the two RPCs from here (fake-supabase.mjs), and lifecycle.mjs
// plays the two services on them. Each event name and payload is the one the database sends and
// the console parses (apps/soc-web/src/backend/operationRows.ts).
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const EVENTS = JSON.parse(
  readFileSync(new URL('../../../../contracts/events/events.json', import.meta.url), 'utf8'),
)
const LIFECYCLE = JSON.parse(
  readFileSync(new URL('../../../../contracts/operations/lifecycle.json', import.meta.url), 'utf8'),
)

/** The closed list of log kinds, each with its severity, its sources and its payload keys. */
export const EVENT_KINDS = EVENTS.kinds
/** Each move the lifecycle allows, as `from>to` (contracts/operations/lifecycle.json). */
export const OPERATION_MOVES = new Set(LIFECYCLE.transitions.map(({ from, to }) => `${from}>${to}`))
/** The states an operation ends in: it takes no move out of them (lifecycle.json). */
export const TERMINAL = new Set(LIFECYCLE.terminal)

const SEVERITIES = ['info', 'warning', 'error', 'safety']
const TRANSITIONS = new Set([
  'plan',
  'prepare',
  'unprepare',
  'simulate',
  'launch',
  'stop',
  'cancel',
])
const PILOT_ONLY = new Set(['simulate', 'launch', 'stop'])
const PILOT_VERBS = new Set(['pause', 'recovery', 'return_home', 'undo'])

/** A refusal the database raises, as PostgREST answers it: its SQLSTATE and the message it names. */
export class DatabaseError extends Error {
  /** @param {string} code the SQLSTATE the database raises */
  constructor(code, message) {
    super(message)
    this.name = 'DatabaseError'
    this.code = code
  }

  get status() {
    return this.code === '42501' ? 403 : 400
  }

  get payload() {
    return { code: this.code, message: this.message, details: null, hint: null }
  }
}

/** What the database sends on the state topic for a change to each table, as [event, payload]. */
const BROADCASTS = {
  flights: (row) => [
    'flight',
    {
      id: row.id,
      operation_id: row.operation_id,
      mode: row.mode,
      executed_at: row.executed_at,
      took_off_at: row.took_off_at,
      landed_at: row.landed_at,
      breached_at: row.breached_at,
      ended_at: row.ended_at,
      end_reason: row.end_reason,
    },
  ],
  flight_states: (row) => [
    'flight_state',
    {
      flight_id: row.flight_id,
      status: row.status,
      result: row.result,
      percent: row.percent,
      current_waypoint_index: row.current_waypoint_index,
      break_point: row.break_point,
      end_reason: row.end_reason,
      updated_at: row.updated_at,
    },
  ],
  operation_events: (row) => ['operation_event', { ...row }],
  operation_checks: (row) => ['operation_check', { ...row }],
  // soc.broadcast_stack (migration 0007): the stack's name and link, not its status.
  stacks: (row) => [
    'stack',
    {
      gateway_sn: row.gateway_sn,
      name: row.name,
      link_state: row.link_state,
      updated_at: row.updated_at,
    },
  ],
  transition_requests: (row) => [
    'transition_request',
    {
      id: row.id,
      operation_id: row.operation_id,
      transition: row.transition,
      status: row.status,
      reasons: row.reasons,
      requested_by: row.requested_by,
      requested_at: row.requested_at,
      decided_at: row.decided_at,
    },
  ],
  command_intents: (row) => [
    'command_intent',
    {
      id: row.id,
      operation_id: row.operation_id,
      flight_id: row.flight_id,
      verb: row.verb,
      status: row.status,
      result: row.result,
      requested_by: row.requested_by,
      requested_at: row.requested_at,
      sent_at: row.sent_at,
      replied_at: row.replied_at,
    },
  ],
}

/**
 * The database over the fake's rows. `rows(name)` returns a table's live array, `publish` sends a
 * broadcast on an organization's state topic, and `roles.canEdit(organization, profile)` says
 * whether a member may write there. `now` gives the database's time as an ISO string.
 */
export function createOperationTables({
  rows,
  publish,
  roles,
  now = () => new Date().toISOString(),
}) {
  /** The operation soc.move_operation is moving: its closing entry is the one a closed one takes. */
  let moving = null

  const find = (name, predicate) => rows(name).find(predicate)
  const operationOf = (id) => find('operations', (row) => row.id === id)
  /** soc.is_open: not ended, or the move that ends it is being written. */
  const isOpen = (operation) => {
    const row = operationOf(operation)
    return row !== undefined && (!TERMINAL.has(row.state) || moving === operation)
  }

  /** The broadcast a change to a row makes: the trigger of its table (migrations 0004, 0010). */
  function changed(name, row) {
    if (name === 'operations') return broadcastOperation(row)
    if (name === 'assignments' || name === 'operators') {
      const operation = operationOf(row.operation_id)
      if (operation !== undefined) broadcastOperation(operation)
      return undefined
    }
    const broadcast = BROADCASTS[name]
    if (broadcast === undefined) return undefined
    const [event, payload] = broadcast(row)
    return publish(row.organization_id, event, payload)
  }

  function broadcastOperation(row) {
    publish(row.organization_id, 'operation', {
      id: row.id,
      state: row.state,
      end_reason: row.end_reason,
      updated_at: row.updated_at,
    })
  }

  /** A row written into a table: its broadcast, and what its insert or change logs. */
  function insertRow(name, row) {
    rows(name).push(row)
    changed(name, row)
    if (name === 'command_intents') commandLogged(row, true)
    return row
  }

  function updateRow(name, row, changes) {
    const before = row.status
    Object.assign(row, changes)
    changed(name, row)
    if (name === 'command_intents' && row.status !== before) commandLogged(row, false)
    return row
  }

  /** command_intent_is_logged (migration 0010): asked, and its outcome once it settles (not sent). */
  function commandLogged(intent, inserted) {
    if (!isOpen(intent.operation_id)) return
    const flight = find('flights', (row) => row.id === intent.flight_id)
    const fleet = flight === undefined ? null : flight.fleet_id
    if (inserted) {
      const source =
        intent.requested_by !== null
          ? 'operator'
          : intent.status === 'sent'
            ? 'soc-cloud'
            : 'soc-operations'
      log(
        intent.operation_id,
        'command_requested',
        source,
        { verb: intent.verb },
        { actor: intent.requested_by, flight: intent.flight_id, fleet, command: intent.id },
      )
      return
    }
    if (intent.status === 'sent') return
    log(
      intent.operation_id,
      'command_outcome',
      'soc-cloud',
      { verb: intent.verb, status: intent.status, result: intent.result },
      {
        flight: intent.flight_id,
        fleet,
        command: intent.id,
        severity: intent.status === 'accepted' ? 'info' : 'warning',
      },
    )
  }

  /**
   * soc.log_event: appends an entry the event contract lists, with its source and every payload key
   * it names, at a severity no lower than its kind's. A closed operation takes only its closing move.
   */
  function log(operation, kind, source, payload = {}, options = {}) {
    const row = operationOf(operation)
    if (row === undefined)
      throw new DatabaseError('P0002', `operation ${String(operation)} does not exist`)
    if (!isOpen(operation)) {
      throw new DatabaseError('23514', `operation ${operation}: closed, its log takes nothing more`)
    }
    if (!Object.hasOwn(EVENT_KINDS, kind)) {
      throw new DatabaseError('23503', `event kind ${kind} is not one the contract lists`)
    }
    const listed = EVENT_KINDS[kind]
    if (!listed.sources.includes(source)) {
      throw new DatabaseError('23514', `event ${kind}: ${source} is not one of its sources`)
    }
    for (const key of listed.payload) {
      if (!Object.hasOwn(payload, key)) {
        throw new DatabaseError('23514', `event ${kind}: its payload lacks ${key}`)
      }
    }
    const severity = options.severity ?? listed.severity
    const rank = SEVERITIES.indexOf(severity)
    if (rank < SEVERITIES.indexOf(listed.severity)) {
      throw new DatabaseError('23514', `event ${kind}: ${severity} is below its severity`)
    }
    if ((severity === 'safety') !== (listed.severity === 'safety')) {
      throw new DatabaseError('23514', `event ${kind}: safety is reserved for safety events`)
    }
    const at = now()
    const entry = {
      id: randomUUID(),
      organization_id: row.organization_id,
      operation_id: operation,
      flight_id: options.flight ?? null,
      fleet_id: options.fleet ?? null,
      command_id: options.command ?? null,
      occurred_at: options.occurred ?? at,
      recorded_at: at,
      kind,
      severity,
      source,
      actor_id: options.actor ?? null,
      payload: { ...payload },
    }
    insertRow('operation_events', entry)
    return entry
  }

  /** soc.move_operation: the one way a state moves, listed in the lifecycle, logged in the same write. */
  function move(operation, to, cause, source, actor = null, reason = null) {
    const row = operationOf(operation)
    if (row === undefined)
      throw new DatabaseError('P0002', `operation ${String(operation)} does not exist`)
    const from = row.state
    if (!OPERATION_MOVES.has(`${from}>${to}`)) {
      throw new DatabaseError('23514', `operation ${operation}: ${from} cannot become ${to}`)
    }
    const ends = TERMINAL.has(to)
    const endReason = ends
      ? (reason ?? (to === 'completed' ? 'completed' : to === 'cancelled' ? 'cancelled' : null))
      : null
    if (ends && endReason === null) {
      throw new DatabaseError('23514', `operation ${operation}: ${to} ends with a reason`)
    }
    const at = now()
    moving = operation
    try {
      updateRow('operations', row, {
        state: to,
        end_reason: endReason,
        ended_at: ends ? at : null,
        started_at: to === 'launching' ? (row.started_at ?? at) : row.started_at,
        updated_at: at,
      })
      log(
        operation,
        'operation_state_changed',
        source,
        { from, to, cause, ...(endReason === null ? {} : { end_reason: endReason }) },
        { actor },
      )
    } finally {
      moving = null
    }
    return row
  }

  /** soc.record_checks: writes the checks that changed, and broadcasts each one written (IR-CHK). */
  function recordChecks(operation, checks) {
    const row = operationOf(operation)
    if (row === undefined) return 0
    if (!isOpen(operation)) {
      throw new DatabaseError('23514', `operation ${operation}: closed, it takes no new checks`)
    }
    let written = 0
    for (const check of checks) {
      const next = {
        operation_id: operation,
        organization_id: row.organization_id,
        check_id: check.check_id,
        state: check.state,
        blocking: check.blocking,
        value: check.value ?? null,
        detail: check.detail,
        evaluated_at: check.evaluated_at,
      }
      const current = find(
        'operation_checks',
        (each) => each.operation_id === operation && each.check_id === check.check_id,
      )
      if (current === undefined) {
        insertRow('operation_checks', next)
        written += 1
      } else if (
        current.state !== next.state ||
        current.blocking !== next.blocking ||
        current.detail !== next.detail ||
        JSON.stringify(current.value) !== JSON.stringify(next.value)
      ) {
        updateRow('operation_checks', current, next)
        written += 1
      }
    }
    return written
  }

  /**
   * soc.record_flight_progress: a flight's state as soc-cloud reads it. Its log entry is written only
   * when the status changes, as the database writes it; `changed` says whether it did.
   */
  function recordProgress(
    flightId,
    status,
    { result = null, percent = null, waypoint = null, breakPoint = null, endReason = null },
  ) {
    const flight = find('flights', (row) => row.id === flightId)
    if (flight === undefined) return { changed: false }
    const values = {
      status,
      result,
      percent,
      current_waypoint_index: waypoint,
      break_point: breakPoint,
      end_reason: endReason,
      updated_at: now(),
    }
    const current = find('flight_states', (row) => row.flight_id === flightId)
    const before = current === undefined ? null : current.status
    if (current === undefined) {
      insertRow('flight_states', {
        flight_id: flightId,
        organization_id: flight.organization_id,
        ...values,
      })
    } else {
      updateRow('flight_states', current, values)
    }
    if (before !== status && flight.ended_at === null && isOpen(flight.operation_id)) {
      log(
        flight.operation_id,
        'flight_status_changed',
        'soc-cloud',
        { status, percent, result, break_point: breakPoint, end_reason: endReason },
        { flight: flightId, fleet: flight.fleet_id },
      )
    }
    return { changed: before !== status }
  }

  /** soc.record_flight_moment: take-off or landing of a flight, from its mode (FR-LOG-02). */
  function recordMoment(flightId, moment, at, mode) {
    const flight = find('flights', (row) => row.id === flightId)
    if (flight === undefined) return
    if (moment === 'took_off') {
      updateRow('flights', flight, { took_off_at: flight.took_off_at ?? at })
    } else if (moment === 'landed') {
      updateRow('flights', flight, { landed_at: at })
    } else {
      throw new DatabaseError('22023', `a flight moment is took_off or landed, not ${moment}`)
    }
    if (!isOpen(flight.operation_id)) return
    log(
      flight.operation_id,
      moment,
      'aircraft',
      { mode_code: mode },
      { flight: flightId, fleet: flight.fleet_id, occurred: at },
    )
  }

  /** soc.claim_transition_request: pending to running, once. */
  function claimTransition(request) {
    const row = find('transition_requests', (each) => each.id === request)
    if (row === undefined || row.status !== 'pending') return null
    return updateRow('transition_requests', row, { status: 'running' })
  }

  /** soc.decide_transition_request: running to accepted, refused or failed, with its reasons. */
  function decideTransition(request, outcome, reasons = []) {
    const row = find('transition_requests', (each) => each.id === request)
    if (row === undefined || row.status !== 'running') return null
    updateRow('transition_requests', row, {
      status: outcome,
      reasons: outcome === 'accepted' ? null : [...reasons],
      decided_at: now(),
    })
    if ((outcome === 'refused' || outcome === 'failed') && isOpen(row.operation_id)) {
      log(
        row.operation_id,
        'transition_refused',
        'soc-operations',
        { transition: row.transition, request: row.id, reasons: row.reasons },
        { severity: outcome === 'failed' ? 'error' : undefined },
      )
    }
    return row
  }

  /** soc.claim_command_intent: a pending intent is sent to soc-cloud, once. */
  function claimCommand(intent) {
    const row = find('command_intents', (each) => each.id === intent)
    if (row === undefined || row.status !== 'pending') return null
    return updateRow('command_intents', row, { status: 'sent', sent_at: now() })
  }

  /** soc.record_command_reply: DJI's result, 0 accepted; the intent settles. */
  function replyCommand(intent, result) {
    const row = find('command_intents', (each) => each.id === intent)
    if (row === undefined || row.status !== 'sent') return null
    return updateRow('command_intents', row, {
      status: result === 0 ? 'accepted' : 'refused',
      result,
      replied_at: now(),
    })
  }

  const isPilot = (operation, profile) =>
    find(
      'operators',
      (row) => row.operation_id === operation && row.profile_id === profile && row.role === 'pilot',
    ) !== undefined

  /**
   * soc.request_transition: an editor asks an operation to move, and a pilot asks to simulate, launch
   * or stop. The client request id answers the request it made first (`created` is false then).
   */
  function requestTransition({ operation, wanted, clientRequest, me }) {
    const target = operationOf(operation)
    if (target === undefined || !roles.canEdit(target.organization_id, me)) {
      throw new DatabaseError(
        '42501',
        `operation ${String(operation)}: an editor of its organization asks it to move`,
      )
    }
    if (!TRANSITIONS.has(wanted)) {
      throw new DatabaseError(
        '22P02',
        `invalid input value for enum soc.transition: "${String(wanted)}"`,
      )
    }
    if (TERMINAL.has(target.state)) {
      throw new DatabaseError(
        '23514',
        `operation ${operation}: closed when it became ${target.state}`,
      )
    }
    if (PILOT_ONLY.has(wanted) && !isPilot(operation, me)) {
      throw new DatabaseError('42501', `operation ${operation}: only its pilots ${wanted}`)
    }
    const asked = find(
      'transition_requests',
      (row) =>
        row.organization_id === target.organization_id && row.client_request_id === clientRequest,
    )
    if (asked !== undefined) return { row: asked, created: false }
    const request = insertRow('transition_requests', {
      id: randomUUID(),
      client_request_id: clientRequest,
      organization_id: target.organization_id,
      operation_id: operation,
      transition: wanted,
      requested_by: me,
      requested_at: now(),
      status: 'pending',
      reasons: null,
      decided_at: null,
    })
    log(
      operation,
      'transition_requested',
      'operator',
      { transition: wanted, request: request.id },
      { actor: me },
    )
    return { row: request, created: true }
  }

  /**
   * soc.request_command: a pilot asks a flight's aircraft a verb. An undo is refused once the flight
   * executes, or once its execute is asked (the demo's stricter rule: the database's own check is on
   * executed_at, which an execute in flight does not yet set).
   */
  function requestCommand({ flight, wanted, clientRequest, me }) {
    if (!PILOT_VERBS.has(wanted)) {
      throw new DatabaseError(
        '22023',
        `a pilot asks pause, recovery, return_home or undo, not ${String(wanted)}`,
      )
    }
    const target = find('flights', (row) => row.id === flight)
    if (target === undefined || !isPilot(target.operation_id, me)) {
      throw new DatabaseError(
        '42501',
        `flight ${String(flight)}: only a pilot of its operation commands it`,
      )
    }
    if (target.ended_at !== null) throw new DatabaseError('23514', `flight ${flight}: it has ended`)
    const executes =
      find('command_intents', (row) => row.flight_id === flight && row.verb === 'execute') !==
      undefined
    if (wanted === 'undo' && (target.executed_at !== null || executes)) {
      throw new DatabaseError('23514', `flight ${flight}: it executes, so it is no longer undone`)
    }
    const asked = find(
      'command_intents',
      (row) =>
        row.organization_id === target.organization_id && row.client_request_id === clientRequest,
    )
    if (asked !== undefined) return { row: asked, created: false }
    const intent = insertRow('command_intents', {
      id: randomUUID(),
      client_request_id: clientRequest,
      organization_id: target.organization_id,
      operation_id: target.operation_id,
      flight_id: target.id,
      gateway_sn: target.gateway_sn,
      verb: wanted,
      payload: wanted === 'undo' ? { flight_ids: [target.id] } : {},
      status: 'pending',
      result: null,
      requested_by: me,
      requested_at: now(),
      sent_at: null,
      replied_at: null,
    })
    return { row: intent, created: true }
  }

  return {
    rows,
    isOpen,
    changed,
    insertRow,
    updateRow,
    log,
    move,
    recordChecks,
    recordProgress,
    recordMoment,
    claimTransition,
    decideTransition,
    claimCommand,
    replyCommand,
    requestTransition,
    requestCommand,
  }
}
