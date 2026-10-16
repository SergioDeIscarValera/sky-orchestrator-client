import { z } from '../schema'
import type {
  Assignment,
  CommandIntent,
  Flight,
  FlightState,
  Member,
  Operation,
  OperationCheck,
  OperationEvent,
  Operator,
  StackView,
  TrackPoint,
  TransitionRequest,
} from './backend'
import { positionFromStorage } from './positions'

// The operations' rows as the database sends them: on a read, and on a broadcast that carries
// the whole row (operation_check, operation_event). A row that does not parse is refused.
// Profile ids are text here: the account ids a fake signs in with are not UUIDs, and the
// database's own column is the stricter one.

const numeric = z.union([z.number(), z.string().check(z.regex(/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/))])
const LINK_STATE = z.enum(['connected', 'connecting', 'displaced', 'unreachable'])
const ROLE = z.enum(['owner', 'editor', 'viewer'])
const OPERATION_STATE = z.enum([
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
])
const END_REASON = z.enum([
  'completed',
  'operator_stop',
  'operator_return',
  'geofence_breach',
  'envelope_breach',
  'low_battery',
  'link_lost',
  'pilot_takeover',
  'aircraft_fault',
  'cancelled',
])
const OPERATOR_ROLE = z.enum(['pilot', 'observer'])
const FLIGHT_MODE = z.enum(['simulated', 'real'])
const FLIGHT_STATUS = z.enum([
  'sent',
  'in_progress',
  'paused',
  'ok',
  'failed',
  'canceled',
  'rejected',
  'timeout',
  'partially_done',
])
const EVENT_SEVERITY = z.enum(['info', 'warning', 'error', 'safety'])
const EVENT_SOURCE = z.enum(['operator', 'soc-operations', 'soc-cloud', 'aircraft'])
const TRANSITION = z.enum(['plan', 'prepare', 'unprepare', 'simulate', 'launch', 'stop', 'cancel'])
const TRANSITION_STATUS = z.enum(['pending', 'running', 'accepted', 'refused', 'failed', 'expired'])
const CHECK_STATE = z.enum(['pass', 'fail', 'unknown'])
const COMMAND_VERB = z.enum(['prepare', 'execute', 'pause', 'recovery', 'return_home', 'undo'])
const COMMAND_STATUS = z.enum([
  'pending',
  'sent',
  'accepted',
  'refused',
  'failed',
  'timed_out',
  'expired',
])
const JSON_OBJECT = z.record(z.string(), z.unknown())

export const OPERATION_ROW = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  name: z.string(),
  geofence_id: z.nullable(z.uuid()),
  takeoff_security_height_m: z.nullable(numeric),
  state: OPERATION_STATE,
  end_reason: z.nullable(END_REASON),
  created_by: z.nullable(z.string()),
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.nullable(z.string()),
  ended_at: z.nullable(z.string()),
})

export const ASSIGNMENT_ROW = z.object({
  id: z.uuid(),
  operation_id: z.uuid(),
  wayline_id: z.uuid(),
  fleet_id: z.uuid(),
  speed_ms: z.nullable(numeric),
  flight: z.nullable(JSON_OBJECT),
})

export const OPERATOR_ROW = z.object({
  operation_id: z.uuid(),
  profile_id: z.string(),
  role: OPERATOR_ROLE,
})

export const MEMBER_ROW = z.object({
  profile_id: z.string(),
  display_name: z.nullable(z.string()),
  email: z.nullable(z.string()),
  role: ROLE,
})

export const CHECK_ROW = z.object({
  operation_id: z.uuid(),
  organization_id: z.uuid(),
  check_id: z.string().check(z.regex(/^PF-[A-Z-]+$/)),
  state: CHECK_STATE,
  blocking: z.boolean(),
  value: z.unknown(),
  detail: z.nullable(z.string()),
  evaluated_at: z.string(),
})

export const EVENT_ROW = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  operation_id: z.uuid(),
  flight_id: z.nullable(z.uuid()),
  fleet_id: z.nullable(z.uuid()),
  command_id: z.nullable(z.uuid()),
  occurred_at: z.string(),
  recorded_at: z.string(),
  kind: z.string(),
  severity: EVENT_SEVERITY,
  source: EVENT_SOURCE,
  actor_id: z.nullable(z.string()),
  payload: JSON_OBJECT,
})

export const TRANSITION_REQUEST_ROW = z.object({
  id: z.uuid(),
  operation_id: z.uuid(),
  transition: TRANSITION,
  status: TRANSITION_STATUS,
  reasons: z.nullable(z.array(z.string())),
  requested_by: z.nullable(z.string()),
  requested_at: z.string(),
  decided_at: z.nullable(z.string()),
})

export const FLIGHT_ROW = z.object({
  id: z.uuid(),
  operation_id: z.uuid(),
  mode: FLIGHT_MODE,
  fleet_id: z.uuid(),
  gateway_sn: z.string(),
  aircraft_sn: z.string(),
  prepared_at: z.string(),
  executed_at: z.nullable(z.string()),
  took_off_at: z.nullable(z.string()),
  landed_at: z.nullable(z.string()),
  ended_at: z.nullable(z.string()),
  end_reason: z.nullable(END_REASON),
  // When soc-cloud sent its return home on a geofence breach (FR-SAF-01); null otherwise.
  breached_at: z.nullable(z.string()),
})

export const FLIGHT_STATE_ROW = z.object({
  flight_id: z.uuid(),
  status: FLIGHT_STATUS,
  result: z.nullable(z.number()),
  percent: z.nullable(z.number()),
  current_waypoint_index: z.nullable(z.number()),
  end_reason: z.nullable(END_REASON),
  updated_at: z.string(),
})

/** One sample of a flight's track: the columns the console reads from soc.telemetry_samples. */
export const TRACK_ROW = z.object({
  sampled_at: z.iso.datetime({ offset: true }),
  latitude: z.number(),
  longitude: z.number(),
  height_m: z.number(),
})

export const COMMAND_ROW = z.object({
  id: z.uuid(),
  operation_id: z.uuid(),
  flight_id: z.uuid(),
  verb: COMMAND_VERB,
  status: COMMAND_STATUS,
  result: z.nullable(z.number()),
  requested_by: z.nullable(z.string()),
  requested_at: z.string(),
  sent_at: z.nullable(z.string()),
  replied_at: z.nullable(z.string()),
})

export const STACK_ROW = z.object({
  gateway_sn: z.string(),
  name: z.string(),
  link_state: LINK_STATE,
  envelope: z.nullable(JSON_OBJECT),
  envelope_read_at: z.nullable(z.string()),
})

/** A stored numeric as the console's number, or null when it is not stored. */
function numberOrNull(value: number | string | null): number | null {
  return value === null ? null : Number(value)
}

export function operationOf(row: z.infer<typeof OPERATION_ROW>): Operation {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    geofenceId: row.geofence_id,
    takeoffSecurityHeightM: numberOrNull(row.takeoff_security_height_m),
    state: row.state,
    endReason: row.end_reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  }
}

export function assignmentOf(row: z.infer<typeof ASSIGNMENT_ROW>): Assignment {
  return {
    id: row.id,
    operationId: row.operation_id,
    waylineId: row.wayline_id,
    fleetId: row.fleet_id,
    speedMs: numberOrNull(row.speed_ms),
    flight: row.flight,
  }
}

export function operatorOf(row: z.infer<typeof OPERATOR_ROW>): Operator {
  return { operationId: row.operation_id, profileId: row.profile_id, role: row.role }
}

export function memberOf(row: z.infer<typeof MEMBER_ROW>): Member {
  return {
    profileId: row.profile_id,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
  }
}

export function checkOf(row: z.infer<typeof CHECK_ROW>): OperationCheck {
  return {
    checkId: row.check_id,
    state: row.state,
    blocking: row.blocking,
    value: row.value,
    detail: row.detail,
    evaluatedAt: row.evaluated_at,
  }
}

export function eventOf(row: z.infer<typeof EVENT_ROW>): OperationEvent {
  return {
    id: row.id,
    organizationId: row.organization_id,
    operationId: row.operation_id,
    flightId: row.flight_id,
    fleetId: row.fleet_id,
    commandId: row.command_id,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    kind: row.kind,
    severity: row.severity,
    source: row.source,
    actorId: row.actor_id,
    payload: row.payload,
  }
}

export function requestOf(row: z.infer<typeof TRANSITION_REQUEST_ROW>): TransitionRequest {
  return {
    id: row.id,
    operationId: row.operation_id,
    transition: row.transition,
    status: row.status,
    reasons: row.reasons,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
  }
}

export function flightOf(row: z.infer<typeof FLIGHT_ROW>): Flight {
  return {
    id: row.id,
    operationId: row.operation_id,
    mode: row.mode,
    fleetId: row.fleet_id,
    gatewaySn: row.gateway_sn,
    aircraftSn: row.aircraft_sn,
    preparedAt: row.prepared_at,
    executedAt: row.executed_at,
    tookOffAt: row.took_off_at,
    landedAt: row.landed_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
    breachedAt: row.breached_at,
  }
}

export function flightStateOf(row: z.infer<typeof FLIGHT_STATE_ROW>): FlightState {
  return {
    flightId: row.flight_id,
    status: row.status,
    result: row.result,
    percent: row.percent,
    currentWaypointIndex: row.current_waypoint_index,
    endReason: row.end_reason,
    updatedAt: row.updated_at,
  }
}

/** A track sample as the console holds it: the position through positions.ts, refused when out of range. */
export function trackOf(row: z.infer<typeof TRACK_ROW>): TrackPoint {
  return {
    sampledAt: row.sampled_at,
    position: positionFromStorage([row.longitude, row.latitude]),
    heightM: row.height_m,
  }
}

export function commandOf(row: z.infer<typeof COMMAND_ROW>): CommandIntent {
  return {
    id: row.id,
    operationId: row.operation_id,
    flightId: row.flight_id,
    verb: row.verb,
    status: row.status,
    result: row.result,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    sentAt: row.sent_at,
    repliedAt: row.replied_at,
  }
}

export function stackOf(row: z.infer<typeof STACK_ROW>): StackView {
  return {
    gatewaySn: row.gateway_sn,
    name: row.name,
    linkState: row.link_state,
    envelope: row.envelope,
    envelopeReadAt: row.envelope_read_at,
  }
}

/**
 * The check a broadcast carries, with the operation it judges; null when the payload is not a
 * check, so the console reads the checks again rather than writing a guess into them.
 */
export function checkBroadcast(
  payload: Readonly<Record<string, unknown>>,
): { readonly operationId: string; readonly check: OperationCheck } | null {
  const parsed = z.safeParse(CHECK_ROW, payload)
  if (!parsed.success) return null
  return { operationId: parsed.data.operation_id, check: checkOf(parsed.data) }
}

/** The log entry a broadcast carries; null when the payload is not one (the log is read again). */
export function eventBroadcast(payload: Readonly<Record<string, unknown>>): OperationEvent | null {
  const parsed = z.safeParse(EVENT_ROW, payload)
  return parsed.success ? eventOf(parsed.data) : null
}
