import type { PillTone } from '../app/styles'
import type {
  CheckState,
  CommandStatus,
  CommandVerb,
  EventSeverity,
  FlightMode,
  FlightStatus,
  Member,
  OperationState,
  OperatorRole,
  Transition,
  TransitionStatus,
} from '../backend/backend'

/*
 * The words an operation's inspector shows: its states, checks, moves, log entries and the values
 * inside them. Every map is typed over the whole union, so a value added to a type does not
 * compile until it has words.
 */

export const STATE_WORDS: Readonly<Record<OperationState, string>> = {
  draft: 'Defining',
  planned: 'Planned',
  preparing: 'Preparing',
  simulating: 'Simulating',
  simulated: 'Simulated',
  ready: 'Ready',
  launching: 'Launching',
  in_flight: 'In flight',
  paused: 'Paused',
  returning: 'Returning',
  completed: 'Completed',
  aborted: 'Aborted',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

/** Progress while the operation moves, good once it is ready or done, bad when it failed. */
export const STATE_TONE: Readonly<Record<OperationState, PillTone>> = {
  draft: 'neutral',
  planned: 'neutral',
  preparing: 'progress',
  simulating: 'progress',
  simulated: 'good',
  ready: 'good',
  launching: 'progress',
  in_flight: 'flying',
  paused: 'progress',
  returning: 'progress',
  completed: 'good',
  aborted: 'bad',
  failed: 'bad',
  cancelled: 'muted',
}

/** The preflight checks in FR-OPS-05's table order: the order the inspector lists them in. */
export const CHECK_ORDER = [
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
] as const

export type CheckId = (typeof CHECK_ORDER)[number]

export const CHECK_WORDS: Readonly<Record<CheckId, string>> = {
  'PF-LINK': 'Stack link',
  'PF-ONLINE': 'Aircraft online',
  'PF-FRESH': 'Fresh telemetry',
  'PF-GNSS': 'Positioning',
  'PF-BATTERY': 'Battery',
  'PF-GROUNDED': 'On the ground',
  'PF-INSIDE': 'Inside the geofence',
  'PF-TAKEOFF': 'At takeoff point',
  'PF-WAYLINE': 'Wayline valid',
  'PF-SO-DRYRUN': 'Dry run accepted',
  'PF-ENVELOPE': 'Inside the envelope',
  'PF-MODE': 'Simulator mode known',
  'PF-SIMULATOR': 'Simulator matches mode',
  'PF-ARMED': 'Phone armed',
  'PF-IDLE': 'Stack idle',
  'PF-CLOCK': 'Clock offset',
}

export const CHECK_STATE_WORDS: Readonly<Record<CheckState, string>> = {
  pass: 'Pass',
  fail: 'Fail',
  unknown: 'Unknown',
}

/** Unknown is muted, never green: a check that has not been judged does not look like a pass. */
export const CHECK_STATE_TONE: Readonly<Record<CheckState, PillTone>> = {
  pass: 'good',
  fail: 'bad',
  unknown: 'muted',
}

export const TRANSITION_WORDS: Readonly<Record<Transition, string>> = {
  plan: 'Plan',
  prepare: 'Prepare',
  unprepare: 'Stop preparing',
  simulate: 'Simulate',
  launch: 'Launch',
  stop: 'Stop',
  cancel: 'Cancel operation',
}

export const REQUEST_WORDS: Readonly<Record<TransitionStatus, string>> = {
  pending: 'Pending',
  running: 'Running',
  accepted: 'Accepted',
  refused: 'Refused',
  failed: 'Failed',
  expired: 'Expired',
}

export const REQUEST_TONE: Readonly<Record<TransitionStatus, PillTone>> = {
  pending: 'progress',
  running: 'progress',
  accepted: 'good',
  refused: 'bad',
  failed: 'bad',
  expired: 'muted',
}

/** Every kind the operation's log can hold: the closed list of contracts/events/events.json (IR-EVT-02). */
export type EventKind =
  | 'operation_created'
  | 'operation_state_changed'
  | 'operation_definition_changed'
  | 'transition_requested'
  | 'transition_refused'
  | 'checks_at_simulation'
  | 'checks_at_launch'
  | 'flight_prepared'
  | 'flight_status_changed'
  | 'flight_ended'
  | 'took_off'
  | 'automatic_return'
  | 'landed'
  | 'command_requested'
  | 'command_outcome'
  | 'geofence_warning'
  | 'geofence_breach'
  | 'telemetry_stale'
  | 'telemetry_fresh'
  | 'fleet_offline'
  | 'fleet_online'

export const EVENT_WORDS: Readonly<Record<EventKind, string>> = {
  operation_created: 'Created',
  operation_state_changed: 'State changed',
  operation_definition_changed: 'Definition changed',
  transition_requested: 'Move requested',
  transition_refused: 'Move refused',
  checks_at_simulation: 'Checks at simulation',
  checks_at_launch: 'Checks at launch',
  flight_prepared: 'Flight prepared',
  flight_status_changed: 'Flight status changed',
  flight_ended: 'Flight ended',
  took_off: 'Took off',
  automatic_return: 'Automatic return',
  landed: 'Landed',
  command_requested: 'Command requested',
  command_outcome: 'Command answered',
  geofence_warning: 'Geofence warning',
  geofence_breach: 'Geofence breach',
  telemetry_stale: 'Telemetry stale',
  telemetry_fresh: 'Telemetry fresh',
  fleet_offline: 'Fleet offline',
  fleet_online: 'Fleet online',
}

export const SEVERITY_WORDS: Readonly<Record<EventSeverity, string>> = {
  info: 'Info',
  warning: 'Warning',
  error: 'Error',
  safety: 'Safety',
}

export const COMMAND_VERB_WORDS: Readonly<Record<CommandVerb, string>> = {
  prepare: 'Prepare',
  execute: 'Execute',
  pause: 'Pause',
  recovery: 'Resume',
  return_home: 'Return home',
  undo: 'Undo',
}

export const COMMAND_STATUS_WORDS: Readonly<Record<CommandStatus, string>> = {
  pending: 'Pending',
  sent: 'Sent',
  accepted: 'Accepted',
  refused: 'Refused',
  failed: 'Failed',
  timed_out: 'Timed out',
  expired: 'Expired',
}

export const FLIGHT_STATUS_WORDS: Readonly<Record<FlightStatus, string>> = {
  sent: 'Sent',
  in_progress: 'In progress',
  paused: 'Paused',
  ok: 'Completed',
  failed: 'Failed',
  canceled: 'Cancelled',
  rejected: 'Rejected',
  timeout: 'Timed out',
  partially_done: 'Partly done',
}

/** A flight status's tone: flying while it flies, caution when it is paused or partly done, bad when it failed. */
export const FLIGHT_STATUS_TONE: Readonly<Record<FlightStatus, PillTone>> = {
  sent: 'progress',
  in_progress: 'flying',
  paused: 'caution',
  ok: 'good',
  failed: 'bad',
  canceled: 'muted',
  rejected: 'bad',
  timeout: 'bad',
  partially_done: 'caution',
}

/** A command's status tone: progress while it is sent, good once accepted, bad when refused, failed or timed out. */
export const COMMAND_STATUS_TONE: Readonly<Record<CommandStatus, PillTone>> = {
  pending: 'progress',
  sent: 'progress',
  accepted: 'good',
  refused: 'bad',
  failed: 'bad',
  timed_out: 'bad',
  expired: 'muted',
}

/** A flight's mode as words: a real flight in the danger tone, a simulated one in info (FR-SAF-04). */
/** A flight's mode in the console's banner: a word apart from the operation's states (FR-SAF-04). */
export const FLIGHT_MODE_WORDS: Readonly<Record<FlightMode, string>> = {
  simulated: 'Simulated flight',
  real: 'Real flight',
}

export const FLIGHT_MODE_TONE: Readonly<Record<FlightMode, PillTone>> = {
  simulated: 'progress',
  real: 'bad',
}

const FIGURE = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 })

/** A percent as words, such as `42.5%`. */
export function formatPercent(value: number): string {
  return `${FIGURE.format(value)}%`
}

/**
 * A reason as a sentence: soc-operations words its refusals as clauses, `the operation has no
 * height`, which read as `The operation has no height.` A reason already a sentence stays one.
 */
export function asSentence(reason: string): string {
  const clause = reason.trim()
  if (clause === '') return clause
  const capital = clause.charAt(0).toUpperCase() + clause.slice(1)
  return /[.!?]$/.test(capital) ? capital : `${capital}.`
}

export function isEventKind(kind: string): kind is EventKind {
  return Object.hasOwn(EVENT_WORDS, kind)
}

/** An event kind's words; a kind this console does not know reads as the database names it. */
export function eventWords(kind: string): string {
  return isEventKind(kind) ? EVENT_WORDS[kind] : kind
}

/** The words for a check: its name, or its id when the table does not name it. */
export function checkWords(id: string): string {
  return Object.hasOwn(CHECK_WORDS, id) ? CHECK_WORDS[id as CheckId] : id
}

/** Words that are a key of a map, or null: a payload value the console does not know shows nothing. */
function wordOf<T extends string>(
  words: Readonly<Record<T, string>>,
  value: unknown,
): string | null {
  return typeof value === 'string' && Object.hasOwn(words, value) ? words[value as T] : null
}

function joined(parts: readonly (string | null)[]): string | null {
  const present = parts.filter((part): part is string => part !== null)
  return present.length === 0 ? null : present.join(' · ')
}

/** A flight's percent as words, or null when soc-cloud did not report one. */
function percentWords(value: unknown): string | null {
  return typeof value === 'number' ? formatPercent(value) : null
}

/**
 * The payload's most telling value, as words, for the log's line: a state change as "from to to",
 * a command with its verb and status, a flight with its status and percent, a breach with the
 * distance outside. Every other kind shows none.
 */
export function inlineWords(
  kind: string,
  payload: Readonly<Record<string, unknown>>,
): string | null {
  switch (kind) {
    case 'operation_state_changed': {
      const from = wordOf(STATE_WORDS, payload.from)
      const to = wordOf(STATE_WORDS, payload.to)
      return from === null || to === null ? null : `${from} to ${to}`
    }
    case 'command_outcome':
      return joined([
        wordOf(COMMAND_VERB_WORDS, payload.verb),
        wordOf(COMMAND_STATUS_WORDS, payload.status),
      ])
    case 'flight_status_changed':
      return joined([wordOf(FLIGHT_STATUS_WORDS, payload.status), percentWords(payload.percent)])
    case 'geofence_breach':
      return typeof payload.distance_outside_m === 'number'
        ? `${FIGURE.format(payload.distance_outside_m)} m outside`
        : null
    default:
      return null
  }
}

/** A measured name with its unit: the suffix of the key says the unit (`_ms`, `_m`, `_s`). */
const SUFFIX_UNITS: ReadonlyArray<readonly [suffix: string, unit: string]> = [
  ['_ms', 'ms'],
  ['_m', 'm'],
  ['_s', 's'],
]

const KEY_WORDS: Readonly<Record<string, readonly [label: string, unit: string]>> = {
  percent: ['battery', '%'],
  gps_quality: ['GPS quality', ''],
}

function measured(key: string): readonly [label: string, unit: string] {
  const known = Object.hasOwn(KEY_WORDS, key) ? KEY_WORDS[key] : undefined
  if (known !== undefined) return known
  const suffix = SUFFIX_UNITS.find(([ending]) => key.endsWith(ending))
  if (suffix !== undefined) {
    return [key.slice(0, -suffix[0].length).replaceAll('_', ' '), suffix[1]]
  }
  return [key.replaceAll('_', ' '), '']
}

function figure(text: string, unit: string): string {
  if (unit === '') return text
  return unit === '%' ? `${text}%` : `${text} ${unit}`
}

function scalarWords(value: unknown, unit: string): string {
  if (value === null || value === undefined) return 'unknown'
  if (typeof value === 'number') return figure(FIGURE.format(value), unit)
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((item) => scalarWords(item, '')).join('; ')
  return JSON.stringify(value)
}

/**
 * A check's measured value as words, `satellites 14 · GPS quality 5`, or null when it measured
 * nothing. Keys read as their words; a null measurement reads as unknown, never as a figure.
 */
export function valueWords(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) return scalarWords(value, '')
  const pairs = Object.entries(value).map(([key, item]) => {
    const [label, unit] = measured(key)
    return `${label} ${scalarWords(item, unit)}`
  })
  return pairs.length === 0 ? null : pairs.join(' · ')
}

/** An event's time on this device as HH:MM:SS, the log's clock (FR-LOG-03). */
export function localClock(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '--:--:--'
  return [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
}

/** The muted line under an operation's name: its state, then its fleet's and wayline's names. */
export function operationSummary({
  state,
  fleet,
  wayline,
}: {
  readonly state: OperationState
  readonly fleet: string | null
  readonly wayline: string | null
}): string {
  return [STATE_WORDS[state], fleet, wayline]
    .filter((part): part is string => part !== null)
    .join(' · ')
}

const OPERATOR_ROLES: Readonly<Record<OperatorRole, string>> = {
  pilot: 'Pilot',
  observer: 'Observer',
}

export function operatorRoleWord(role: OperatorRole): string {
  return OPERATOR_ROLES[role]
}

/** A member's name, else their address, else their profile id: the first one there is. */
export function memberName(member: Member): string {
  const name = member.displayName?.trim() ?? ''
  if (name !== '') return name
  if (member.email !== null && member.email.trim() !== '') return member.email
  return member.profileId
}

/**
 * Who asked a command, as words: SOC for one with no requester (SOC's own), else the member's name, else
 * their profile id when the member is not among those read (a member who has left the organization).
 */
export function requesterWords(requestedBy: string | null, members: readonly Member[]): string {
  if (requestedBy === null) return 'SOC'
  const member = members.find(({ profileId }) => profileId === requestedBy)
  return member === undefined ? requestedBy : memberName(member)
}
