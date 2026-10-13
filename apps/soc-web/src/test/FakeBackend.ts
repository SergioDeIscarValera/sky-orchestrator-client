import {
  BackendError,
  FieldRefusedError,
  type Account,
  type AircraftModel,
  type Assignment,
  type AssignmentChanges,
  type AssignmentDraft,
  type Backend,
  type CommandIntent,
  type Device,
  type EndReason,
  type EventSeverity,
  type EventSource,
  type Fleet,
  type FleetChanges,
  type FleetDraft,
  type Flight,
  type FlightState,
  type Geofence,
  type GeofenceChanges,
  type GeofenceDraft,
  type Member,
  type Operation,
  type OperationChanges,
  type OperationCheck,
  type OperationDraft,
  type OperationEvent,
  type OperationState,
  type Operator,
  type OperatorRole,
  type Organization,
  type PilotCommandVerb,
  type SignInFailure,
  type StackView,
  type StateEvent,
  type Transition,
  type TransitionRequest,
  type TransitionStatus,
  type Wayline,
  type WaylineChanges,
  type WaylineDraft,
} from '../backend/backend'
import type { Link } from '../backend/link'
import { untouched } from '../backend/supabaseFleets'
import * as operationRefusals from '../backend/supabaseOperations'
import type { Geodetic } from '../geometry/projection'
import {
  notAllowedRefusal,
  retiredRefusal,
  refusedBy,
  untouched as untouchedPlan,
} from '../backend/supabasePlans'
import type { LoadedSite } from '../scene/siteModel'
import type { TelemetrySample } from '../telemetry/sample'
import { PASSWORD_FOR_TESTS } from './keys'

export const PILOT: Account = { userId: 'user-pilot', email: 'pilot@farm.test' }
export const NEIGHBOUR: Account = { userId: 'user-neighbour', email: 'neighbour@farm.test' }

export const NORTH: Organization = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Finca Norte',
  role: 'owner',
  position: { latitude: 41.6523, longitude: -4.7245 },
  timeZone: 'Europe/Madrid',
}

export const ORCHARD: Organization = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Almendral',
  role: 'viewer',
  position: null,
  timeZone: null,
}

const SPECS = 'https://www.dji.com/support/product/mavic-air-2'

export const MAVIC_AIR_2: AircraftModel = {
  model: 'mavic-air-2',
  displayName: 'DJI Mavic Air 2',
  msdkV4Support: 'partial',
  supportNotes: 'Not supported by Mavic Air 2: the flight orientation setting.',
  maxHorizontalSpeedMs: 19,
  maxAscentSpeedMs: 4,
  maxDescentSpeedMs: 5,
  maxFlightTimeS: 2040,
  maxServiceCeilingM: 5000,
  maxWindResistanceMs: 8.5,
  weightG: 570,
  camera: {
    sensor: '1/2" CMOS, 48 MP',
    photoResolution: '8000×6000',
    videoResolution: '3840×2160 @ 60 fps',
    zoom: null,
  },
  thermal: { capability: 'none', resolution: null },
  sources: { max_horizontal_speed_ms: SPECS, weight_g: SPECS, 'camera.sensor': SPECS },
}

export const MINI_2: AircraftModel = {
  ...MAVIC_AIR_2,
  model: 'dji-mini-2',
  displayName: 'DJI Mini 2',
  weightG: null,
}

export function device(aircraftSn: string, online = true): Device {
  return {
    gatewaySn: 'SOTESTDOCK01',
    aircraftSn,
    wireModel: '0-67-0',
    online,
    firmwareVersion: '10.1.0',
    firstSeenAt: '2026-10-11T10:00:00Z',
    lastSeenAt: '2026-10-11T10:05:00Z',
    stack: { name: 'lab', linkState: 'connected' },
  }
}

function byName<T extends { readonly name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name)
}

/** The row with this id, and the organization it belongs to. */
function locate<T extends { readonly id: string }>(
  rows: ReadonlyMap<string, readonly T[]>,
  id: string,
): [string, T] | undefined {
  for (const [organizationId, found] of rows) {
    const row = found.find((candidate) => candidate.id === id)
    if (row !== undefined) return [organizationId, row]
  }
  return undefined
}

/** Whether a ring repeats its first position at its end, which the database refuses (FR-GEO-04). */
function closed(ring: readonly Geodetic[]): boolean {
  const first = ring[0]
  const last = ring.at(-1)
  return (
    first !== undefined &&
    last !== undefined &&
    first.latitudeDeg === last.latitudeDeg &&
    first.longitudeDeg === last.longitudeDeg
  )
}

/** The first constraint a geofence breaks, as the database would name it (FR-GEO-04). */
function geofenceRefusal(draft: GeofenceDraft): FieldRefusedError | null {
  if (draft.name.trim() === '') return refusedBy('geofence_name_given')
  if (draft.polygon.length < 3 || closed(draft.polygon)) {
    return refusedBy('geofence_polygon_ring')
  }
  if (!(draft.maxHeightM > 0)) return refusedBy('geofence_max_height_positive')
  const margin = draft.marginM
  const fits =
    draft.origin === 'generated' ? margin !== null && margin >= 5 && margin <= 100 : margin === null
  return fits ? null : refusedBy('geofence_margin_when_generated')
}

/** The first constraint a wayline breaks, as the database would name it (FR-WAY-06, FR-WAY-09). */
function waylineRefusal(draft: WaylineDraft): FieldRefusedError | null {
  if (draft.name.trim() === '') return refusedBy('wayline_name_given')
  if (!(draft.defaultHeightM > 0)) return refusedBy('wayline_default_height_positive')
  const baked = draft.waypoints.length > 0 && draft.waypoints.every(({ heightM }) => heightM > 0)
  if (!baked) return refusedBy('wayline_waypoints_baked')
  if (draft.bakeVersion.trim() === '') return refusedBy('wayline_bake_version_given')
  return null
}

/** What the database broadcasts for a geofence (IR-GEO), with its retirement time if retired. */
function geofencePayload(
  geofence: Geofence,
  deletedAt: string | null,
): Readonly<Record<string, unknown>> {
  return {
    id: geofence.id,
    name: geofence.name,
    origin: geofence.origin,
    updated_at: geofence.updatedAt,
    deleted_at: deletedAt,
  }
}

/** What the database broadcasts for a wayline (IR-WAY), with the time it was retired, if it was. */
function waylinePayload(
  wayline: Wayline,
  deletedAt: string | null,
): Readonly<Record<string, unknown>> {
  return {
    id: wayline.id,
    name: wayline.name,
    updated_at: wayline.updatedAt,
    deleted_at: deletedAt,
  }
}

/** The moves an operation makes: contracts/operations/lifecycle.json, as migration 0010 holds it. */
const MOVES: ReadonlyArray<readonly [OperationState, OperationState]> = [
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
  ['simulated', 'planned'],
  ['simulated', 'cancelled'],
  ['ready', 'simulated'],
  ['ready', 'launching'],
  ['ready', 'planned'],
  ['ready', 'cancelled'],
  ['launching', 'in_flight'],
  ['launching', 'ready'],
  ['launching', 'failed'],
  ['in_flight', 'paused'],
  ['in_flight', 'returning'],
  ['paused', 'in_flight'],
  ['paused', 'returning'],
  ['returning', 'completed'],
  ['returning', 'aborted'],
  ['returning', 'failed'],
]

const TERMINAL = new Set<OperationState>(['completed', 'aborted', 'failed', 'cancelled'])
/** From simulating on, what the operation flies is fixed (IR-OPS-02, FR-OPS-07). */
const FROZEN = new Set<OperationState>([
  'simulating',
  'launching',
  'in_flight',
  'paused',
  'returning',
  ...TERMINAL,
])
/** Operators are fixed from launching on, and once the operation has ended. */
const OPERATORS_FIXED = new Set<OperationState>([
  'launching',
  'in_flight',
  'paused',
  'returning',
  ...TERMINAL,
])
const PILOT_ONLY: ReadonlySet<Transition> = new Set<Transition>(['simulate', 'launch', 'stop'])

/** One entry the database writes to an operation's log, with the ids it names. */
interface LogEntry {
  readonly kind: string
  readonly severity: EventSeverity
  readonly source: EventSource
  readonly payload: Readonly<Record<string, unknown>>
  readonly actor?: string | null
  readonly flight?: string | null
  readonly fleet?: string | null
  readonly command?: string | null
}

/** The key a client request id is kept under: the database keys it per organization. */
function askKey(organizationId: string, clientRequestId: string): string {
  return `${organizationId}/${clientRequestId}`
}

/** The severity the database gives a kind it names (contracts/events): warnings for refusals. */
function severityOf(kind: string): EventSeverity {
  return kind === 'transition_refused' ? 'warning' : 'info'
}

/** The state of an operation as the database broadcasts it (IR-OPS-01): no definition, no names. */
function operationPayload(operation: Operation): Readonly<Record<string, unknown>> {
  return {
    id: operation.id,
    state: operation.state,
    end_reason: operation.endReason,
    updated_at: operation.updatedAt,
  }
}

/** A check as the database broadcasts it: the whole row, the operation it judges included. */
function checkPayload(organizationId: string, operationId: string, check: OperationCheck) {
  return {
    operation_id: operationId,
    organization_id: organizationId,
    check_id: check.checkId,
    state: check.state,
    blocking: check.blocking,
    value: check.value,
    detail: check.detail,
    evaluated_at: check.evaluatedAt,
  }
}

/** A log entry as the database broadcasts it: the whole row (FR-LOG-03). */
function eventPayload(event: OperationEvent): Readonly<Record<string, unknown>> {
  return {
    id: event.id,
    organization_id: event.organizationId,
    operation_id: event.operationId,
    flight_id: event.flightId,
    fleet_id: event.fleetId,
    command_id: event.commandId,
    occurred_at: event.occurredAt,
    recorded_at: event.recordedAt,
    kind: event.kind,
    severity: event.severity,
    source: event.source,
    actor_id: event.actorId,
    payload: event.payload,
  }
}

function flightPayload(flight: Flight): Readonly<Record<string, unknown>> {
  return {
    id: flight.id,
    operation_id: flight.operationId,
    mode: flight.mode,
    executed_at: flight.executedAt,
    took_off_at: flight.tookOffAt,
    landed_at: flight.landedAt,
    ended_at: flight.endedAt,
    end_reason: flight.endReason,
  }
}

function flightStatePayload(state: FlightState): Readonly<Record<string, unknown>> {
  return {
    flight_id: state.flightId,
    status: state.status,
    result: state.result,
    percent: state.percent,
    current_waypoint_index: state.currentWaypointIndex,
    break_point: null,
    end_reason: state.endReason,
    updated_at: state.updatedAt,
  }
}

function requestPayload(request: TransitionRequest): Readonly<Record<string, unknown>> {
  return {
    id: request.id,
    operation_id: request.operationId,
    transition: request.transition,
    status: request.status,
    reasons: request.reasons,
    requested_by: request.requestedBy,
    requested_at: request.requestedAt,
    decided_at: request.decidedAt,
  }
}

function commandPayload(intent: CommandIntent): Readonly<Record<string, unknown>> {
  return {
    id: intent.id,
    operation_id: intent.operationId,
    flight_id: intent.flightId,
    verb: intent.verb,
    status: intent.status,
    result: intent.result,
    requested_by: intent.requestedBy,
    requested_at: intent.requestedAt,
    sent_at: intent.sentAt,
    replied_at: intent.repliedAt,
  }
}

/** The backend in memory: accounts, their organizations, and the failures a test asks for. */
export class FakeBackend implements Backend {
  readonly address = 'http://192.168.1.40:8000'
  readonly memberships = new Map<string, Organization[]>([
    [PILOT.userId, [NORTH, ORCHARD]],
    [NEIGHBOUR.userId, [NORTH]],
  ])
  signInFailure: SignInFailure | null = null
  organizationsFailure: BackendError | null = null
  organizationReads = 0
  readonly models: AircraftModel[] = [MAVIC_AIR_2, MINI_2]
  readonly seen = new Map<string, Device[]>([[NORTH.id, [device('SOTESTUAV001')]]])
  readonly registered = new Map<string, Fleet[]>()
  /** Geofences and waylines by organization, retired ones included: `retired` says which. */
  readonly geofenceRows = new Map<string, Geofence[]>()
  readonly waylineRows = new Map<string, Wayline[]>()
  private account: Account | null
  private readonly listeners = new Set<(account: Account | null) => void>()
  private readonly stateListeners = new Map<string, Set<(event: StateEvent) => void>>()
  private readonly telemetryListeners = new Map<string, Set<(sample: TelemetrySample) => void>>()
  private fleetsMade = 0
  private plansMade = 0
  private clock = Date.parse('2026-10-11T10:10:00Z')
  /** The plans retired here: each stays in the database and refuses every change (FR-GEO-02). */
  private readonly retired = new Set<string>()
  /** Operations by organization; their parts by operation, as the database keys them. */
  readonly operationRows = new Map<string, Operation[]>()
  readonly assignmentRows = new Map<string, Assignment[]>()
  readonly operatorRows = new Map<string, Operator[]>()
  readonly checkRows = new Map<string, OperationCheck[]>()
  readonly eventRows = new Map<string, OperationEvent[]>()
  readonly requestRows = new Map<string, TransitionRequest[]>()
  readonly flightRows = new Map<string, Flight[]>()
  readonly flightStateRows = new Map<string, FlightState>()
  readonly commandRows = new Map<string, CommandIntent[]>()
  /** The stacks by organization, each with the envelope it last reported (IR-STK). */
  readonly stacksOf = new Map<string, StackView[]>()
  /** The request each client request id made, per organization: the database's idempotency key. */
  private readonly transitionsAsked = new Map<string, TransitionRequest>()
  private readonly commandsAsked = new Map<string, CommandIntent>()
  private operationsMade = 0

  constructor(signedIn: Account | null = null) {
    this.account = signedIn
  }

  onAccountChange(listener: (account: Account | null) => void): () => void {
    this.listeners.add(listener)
    queueMicrotask(() => {
      listener(this.account)
    })
    return () => this.listeners.delete(listener)
  }

  signIn(email: string, password: string): Promise<SignInFailure | null> {
    if (this.signInFailure !== null) return Promise.resolve(this.signInFailure)
    const account = [PILOT, NEIGHBOUR].find((known) => known.email === email)
    if (account === undefined || password !== PASSWORD_FOR_TESTS) {
      return Promise.resolve({ reason: 'credentials', detail: 'Invalid login credentials' })
    }
    this.become(account)
    return Promise.resolve(null)
  }

  signOut(): Promise<void> {
    this.become(null)
    return Promise.resolve()
  }

  /** The session ends on the server's side: revoked, or its refresh token expired. */
  endSession(): void {
    this.become(null)
  }

  memberOrganizations(): Promise<Organization[]> {
    this.organizationReads += 1
    if (this.organizationsFailure !== null) return Promise.reject(this.organizationsFailure)
    if (this.account === null) return Promise.reject(new BackendError('JWT expired', 'PGRST301'))
    return Promise.resolve(this.memberships.get(this.account.userId) ?? [])
  }

  aircraftModels(): Promise<AircraftModel[]> {
    return Promise.resolve([...this.models])
  }

  devices(organizationId: string): Promise<Device[]> {
    return Promise.resolve([...(this.seen.get(organizationId) ?? [])])
  }

  fleets(organizationId: string): Promise<Fleet[]> {
    return Promise.resolve([...(this.registered.get(organizationId) ?? [])])
  }

  registerFleet(organizationId: string, draft: FleetDraft): Promise<Fleet> {
    const refused = this.refusal(organizationId, draft)
    if (refused !== null) return Promise.reject(refused)
    this.fleetsMade += 1
    const fleet: Fleet = {
      id: `00000000-0000-4000-8000-${String(this.fleetsMade).padStart(12, '0')}`,
      ...draft,
      createdAt: '2026-10-11T10:10:00Z',
      updatedAt: '2026-10-11T10:10:00Z',
    }
    this.registered.set(organizationId, [...(this.registered.get(organizationId) ?? []), fleet])
    this.emit(organizationId, { kind: 'fleet', payload: { id: fleet.id } })
    return Promise.resolve(fleet)
  }

  changeFleet(fleetId: string, changes: FleetChanges): Promise<Fleet> {
    const [organizationId, fleet] = this.locate(fleetId)
    if (!this.writes(organizationId)) return Promise.reject(untouched())
    const changed = { ...fleet, ...changes }
    const refused = this.refusal(organizationId, changed, fleetId)
    if (refused !== null) return Promise.reject(refused)
    this.replace(organizationId, fleetId, changed)
    this.emit(organizationId, { kind: 'fleet', payload: { id: fleetId } })
    return Promise.resolve(changed)
  }

  retireFleet(fleetId: string): Promise<void> {
    const [organizationId] = this.locate(fleetId)
    if (!this.writes(organizationId)) return Promise.reject(untouched())
    this.replace(organizationId, fleetId, null)
    this.emit(organizationId, { kind: 'fleet', payload: { id: fleetId } })
    return Promise.resolve()
  }

  geofences(organizationId: string): Promise<Geofence[]> {
    return Promise.resolve(this.live(this.geofenceRows, organizationId).sort(byName))
  }

  createGeofence(organizationId: string, draft: GeofenceDraft): Promise<Geofence> {
    if (!this.writes(organizationId)) return Promise.reject(notAllowedRefusal('geofence'))
    const refused = geofenceRefusal(draft)
    if (refused !== null) return Promise.reject(refused)
    const at = this.stamp()
    const geofence: Geofence = {
      id: this.planId(),
      name: draft.name,
      polygon: [...draft.polygon],
      maxHeightM: draft.maxHeightM,
      origin: draft.origin,
      marginM: draft.marginM,
      createdAt: at,
      updatedAt: at,
    }
    this.geofenceRows.set(organizationId, [
      ...(this.geofenceRows.get(organizationId) ?? []),
      geofence,
    ])
    this.emit(organizationId, { kind: 'geofence', payload: geofencePayload(geofence, null) })
    return Promise.resolve(geofence)
  }

  changeGeofence(geofenceId: string, changes: GeofenceChanges): Promise<Geofence> {
    const located = locate(this.geofenceRows, geofenceId)
    if (located === undefined) return Promise.reject(new BackendError(`no geofence ${geofenceId}`))
    const [organizationId, geofence] = located
    if (!this.writes(organizationId)) return Promise.reject(untouchedPlan('geofence'))
    if (this.retired.has(geofenceId)) return Promise.reject(retiredRefusal('geofence'))
    const changed: Geofence = { ...geofence, ...changes, updatedAt: this.stamp() }
    const refused = geofenceRefusal(changed)
    if (refused !== null) return Promise.reject(refused)
    this.replaceIn(this.geofenceRows, organizationId, changed)
    this.emit(organizationId, { kind: 'geofence', payload: geofencePayload(changed, null) })
    return Promise.resolve(changed)
  }

  retireGeofence(geofenceId: string): Promise<void> {
    const located = locate(this.geofenceRows, geofenceId)
    if (located === undefined) return Promise.reject(new BackendError(`no geofence ${geofenceId}`))
    const [organizationId, geofence] = located
    if (!this.writes(organizationId)) return Promise.reject(untouchedPlan('geofence'))
    if (this.retired.has(geofenceId)) return Promise.reject(retiredRefusal('geofence'))
    const at = this.stamp()
    this.retired.add(geofenceId)
    this.emit(organizationId, {
      kind: 'geofence',
      payload: geofencePayload({ ...geofence, updatedAt: at }, at),
    })
    return Promise.resolve()
  }

  waylines(organizationId: string): Promise<Wayline[]> {
    return Promise.resolve(this.live(this.waylineRows, organizationId).sort(byName))
  }

  createWayline(organizationId: string, draft: WaylineDraft): Promise<Wayline> {
    if (!this.writes(organizationId)) return Promise.reject(notAllowedRefusal('wayline'))
    const refused = waylineRefusal(draft)
    if (refused !== null) return Promise.reject(refused)
    const at = this.stamp()
    const wayline: Wayline = {
      id: this.planId(),
      name: draft.name,
      takeoff: draft.takeoff,
      defaultHeightM: draft.defaultHeightM,
      design: draft.design,
      waypoints: [...draft.waypoints],
      metrics: draft.metrics,
      bakeVersion: draft.bakeVersion,
      createdAt: at,
      updatedAt: at,
    }
    this.waylineRows.set(organizationId, [...(this.waylineRows.get(organizationId) ?? []), wayline])
    this.emit(organizationId, { kind: 'wayline', payload: waylinePayload(wayline, null) })
    return Promise.resolve(wayline)
  }

  changeWayline(waylineId: string, changes: WaylineChanges): Promise<Wayline> {
    const located = locate(this.waylineRows, waylineId)
    if (located === undefined) return Promise.reject(new BackendError(`no wayline ${waylineId}`))
    const [organizationId, wayline] = located
    if (!this.writes(organizationId)) return Promise.reject(untouchedPlan('wayline'))
    if (this.retired.has(waylineId)) return Promise.reject(retiredRefusal('wayline'))
    const changed: Wayline = { ...wayline, ...changes, updatedAt: this.stamp() }
    const refused = waylineRefusal(changed)
    if (refused !== null) return Promise.reject(refused)
    this.replaceIn(this.waylineRows, organizationId, changed)
    this.emit(organizationId, { kind: 'wayline', payload: waylinePayload(changed, null) })
    return Promise.resolve(changed)
  }

  retireWayline(waylineId: string): Promise<void> {
    const located = locate(this.waylineRows, waylineId)
    if (located === undefined) return Promise.reject(new BackendError(`no wayline ${waylineId}`))
    const [organizationId, wayline] = located
    if (!this.writes(organizationId)) return Promise.reject(untouchedPlan('wayline'))
    if (this.retired.has(waylineId)) return Promise.reject(retiredRefusal('wayline'))
    const at = this.stamp()
    this.retired.add(waylineId)
    this.emit(organizationId, {
      kind: 'wayline',
      payload: waylinePayload({ ...wayline, updatedAt: at }, at),
    })
    return Promise.resolve()
  }

  operations(organizationId: string): Promise<Operation[]> {
    return Promise.resolve([...(this.operationRows.get(organizationId) ?? [])].reverse())
  }

  /** A new operation is a draft, made by whoever inserts it (migration 0010, FR-OPS-01). */
  createOperation(organizationId: string, draft: OperationDraft): Promise<Operation> {
    if (!this.writes(organizationId)) return Promise.reject(operationRefusals.notAllowedRefusal())
    const refused = this.operationRefusal(organizationId, draft)
    if (refused !== null) return Promise.reject(refused)
    const at = this.stamp()
    const operation: Operation = {
      id: this.mintOperation(),
      organizationId,
      name: draft.name,
      geofenceId: draft.geofenceId,
      takeoffSecurityHeightM: draft.takeoffSecurityHeightM,
      state: 'draft',
      endReason: null,
      createdBy: this.account?.userId ?? null,
      createdAt: at,
      updatedAt: at,
      startedAt: null,
      endedAt: null,
    }
    this.operationRows.set(organizationId, [
      ...(this.operationRows.get(organizationId) ?? []),
      operation,
    ])
    this.log(operation.id, {
      kind: 'operation_created',
      severity: 'info',
      source: 'operator',
      payload: { name: draft.name },
      actor: operation.createdBy,
    })
    this.emit(organizationId, { kind: 'operation', payload: operationPayload(operation) })
    return Promise.resolve(operation)
  }

  /**
   * Changes an operation's definition or name. Closed refuses everything; from simulating on the
   * geofence and the height are fixed (IR-OPS-02). A change to them plans a prepared operation again.
   */
  changeOperation(operationId: string, changes: OperationChanges): Promise<Operation> {
    const located = locate(this.operationRows, operationId)
    if (located === undefined || !this.writes(located[0])) {
      return Promise.reject(operationRefusals.untouched('operation'))
    }
    const [organizationId, operation] = located
    if (TERMINAL.has(operation.state)) {
      return Promise.reject(operationRefusals.refusedBy('operation_closed'))
    }
    const changed: Operation = { ...operation, ...changes }
    const geofenceMoved = changed.geofenceId !== operation.geofenceId
    const heightMoved = changed.takeoffSecurityHeightM !== operation.takeoffSecurityHeightM
    if ((geofenceMoved || heightMoved) && FROZEN.has(operation.state)) {
      return Promise.reject(operationRefusals.refusedBy('operation_definition_frozen'))
    }
    const refused = this.operationRefusal(organizationId, changed)
    if (refused !== null) return Promise.reject(refused)
    this.replaceIn(this.operationRows, organizationId, { ...changed, updatedAt: this.stamp() })
    if (geofenceMoved || heightMoved) {
      this.definitionChanged(operationId, geofenceMoved ? 'geofence' : 'height')
    }
    const now = this.operationNow(operationId)
    this.emit(organizationId, { kind: 'operation', payload: operationPayload(now) })
    return Promise.resolve(now)
  }

  assignments(operationId: string): Promise<Assignment[]> {
    return Promise.resolve([...(this.assignmentRows.get(operationId) ?? [])])
  }

  /** One wayline with one fleet in the MVP (FR-OPS-01): a second assignment is refused. */
  assign(operationId: string, organizationId: string, draft: AssignmentDraft): Promise<Assignment> {
    if (!this.writes(organizationId)) return Promise.reject(operationRefusals.notAllowedRefusal())
    const operation = locate(this.operationRows, operationId)?.[1]
    if (operation === undefined) {
      return Promise.reject(new BackendError(`no operation ${operationId}`))
    }
    const existing = this.assignmentRows.get(operationId) ?? []
    if (existing.length > 0) {
      return Promise.reject(operationRefusals.refusedBy('assignment_one_in_mvp'))
    }
    if (FROZEN.has(operation.state)) {
      return Promise.reject(operationRefusals.refusedBy('operation_definition_frozen'))
    }
    const refused = this.assignmentRefusal(organizationId, draft)
    if (refused !== null) return Promise.reject(refused)
    const assignment: Assignment = {
      id: this.mintOperation(),
      operationId,
      waylineId: draft.waylineId,
      fleetId: draft.fleetId,
      speedMs: draft.speedMs,
      flight: draft.flight,
    }
    this.assignmentRows.set(operationId, [...existing, assignment])
    this.definitionChanged(operationId, 'assignment')
    this.emit(organizationId, {
      kind: 'operation',
      payload: operationPayload(this.operationNow(operationId)),
    })
    return Promise.resolve(assignment)
  }

  changeAssignment(assignmentId: string, changes: AssignmentChanges): Promise<Assignment> {
    const located = this.findAssignment(assignmentId)
    if (located === undefined || !this.writes(located.operation.organizationId)) {
      return Promise.reject(operationRefusals.untouched('assignment'))
    }
    const { operation, assignment } = located
    if (FROZEN.has(operation.state)) {
      return Promise.reject(operationRefusals.refusedBy('operation_definition_frozen'))
    }
    const changed: Assignment = { ...assignment, ...changes }
    const refused = this.assignmentRefusal(operation.organizationId, changed)
    if (refused !== null) return Promise.reject(refused)
    this.replaceAssignment(operation.id, changed)
    this.definitionChanged(operation.id, 'assignment')
    this.emit(operation.organizationId, {
      kind: 'operation',
      payload: operationPayload(this.operationNow(operation.id)),
    })
    return Promise.resolve(changed)
  }

  unassign(assignmentId: string): Promise<void> {
    const located = this.findAssignment(assignmentId)
    if (located === undefined || !this.writes(located.operation.organizationId)) {
      return Promise.reject(operationRefusals.untouched('assignment'))
    }
    const { operation, assignment } = located
    if (FROZEN.has(operation.state)) {
      return Promise.reject(operationRefusals.refusedBy('operation_definition_frozen'))
    }
    this.assignmentRows.set(
      operation.id,
      (this.assignmentRows.get(operation.id) ?? []).filter(({ id }) => id !== assignment.id),
    )
    this.definitionChanged(operation.id, 'assignment')
    this.emit(operation.organizationId, {
      kind: 'operation',
      payload: operationPayload(this.operationNow(operation.id)),
    })
    return Promise.resolve()
  }

  operators(operationId: string): Promise<Operator[]> {
    return Promise.resolve(
      [...(this.operatorRows.get(operationId) ?? [])].sort((a, b) =>
        a.profileId.localeCompare(b.profileId),
      ),
    )
  }

  /** The organization's live members, by name or else address, as the database orders them. */
  members(organizationId: string): Promise<Member[]> {
    const members: Member[] = []
    for (const [profileId, organizations] of this.memberships) {
      const organization = organizations.find(({ id }) => id === organizationId)
      if (organization !== undefined) {
        members.push({
          profileId,
          displayName: null,
          email: [PILOT, NEIGHBOUR].find((account) => account.userId === profileId)?.email ?? null,
          role: organization.role,
        })
      }
    }
    return Promise.resolve(
      members.sort((a, b) => (a.email ?? a.profileId).localeCompare(b.email ?? b.profileId)),
    )
  }

  /** Names an operator: a member of the organization, once, while the operation may still change. */
  nameOperator(
    operationId: string,
    organizationId: string,
    profileId: string,
    role: OperatorRole,
  ): Promise<Operator> {
    if (!this.writes(organizationId)) return Promise.reject(operationRefusals.notAllowedRefusal())
    const operation = locate(this.operationRows, operationId)?.[1]
    if (operation === undefined)
      return Promise.reject(new BackendError(`no operation ${operationId}`))
    if (OPERATORS_FIXED.has(operation.state)) {
      return Promise.reject(operationRefusals.refusedBy('operation_definition_frozen'))
    }
    const isMember = (this.memberships.get(profileId) ?? []).some(({ id }) => id === organizationId)
    if (!isMember) {
      return Promise.reject(
        operationRefusals.refusedBy('operators_organization_id_profile_id_fkey', '23503'),
      )
    }
    const named = this.operatorRows.get(operationId) ?? []
    if (named.some((operator) => operator.profileId === profileId)) {
      return Promise.reject(operationRefusals.refusedBy('operators_pkey', '23505'))
    }
    const operator: Operator = { operationId, profileId, role }
    this.operatorRows.set(operationId, [...named, operator])
    this.emit(organizationId, { kind: 'operation', payload: operationPayload(operation) })
    return Promise.resolve(operator)
  }

  changeOperator(operationId: string, profileId: string, role: OperatorRole): Promise<Operator> {
    const located = locate(this.operationRows, operationId)
    const current = this.findOperator(operationId, profileId)
    if (located === undefined || current === undefined || !this.writes(located[0])) {
      return Promise.reject(operationRefusals.untouched('operator'))
    }
    if (OPERATORS_FIXED.has(located[1].state)) {
      return Promise.reject(operationRefusals.refusedBy('operation_definition_frozen'))
    }
    const changed: Operator = { ...current, role }
    this.operatorRows.set(
      operationId,
      (this.operatorRows.get(operationId) ?? []).map((operator) =>
        operator.profileId === profileId ? changed : operator,
      ),
    )
    this.emit(located[0], { kind: 'operation', payload: operationPayload(located[1]) })
    return Promise.resolve(changed)
  }

  removeOperator(operationId: string, profileId: string): Promise<void> {
    const located = locate(this.operationRows, operationId)
    if (located === undefined || this.findOperator(operationId, profileId) === undefined) {
      return Promise.reject(operationRefusals.untouched('operator'))
    }
    if (!this.writes(located[0])) return Promise.reject(operationRefusals.untouched('operator'))
    if (OPERATORS_FIXED.has(located[1].state)) {
      return Promise.reject(operationRefusals.refusedBy('operation_definition_frozen'))
    }
    this.operatorRows.set(
      operationId,
      (this.operatorRows.get(operationId) ?? []).filter(
        ({ profileId: named }) => named !== profileId,
      ),
    )
    this.emit(located[0], { kind: 'operation', payload: operationPayload(located[1]) })
    return Promise.resolve()
  }

  checks(operationId: string): Promise<OperationCheck[]> {
    return Promise.resolve(
      [...(this.checkRows.get(operationId) ?? [])].sort((a, b) =>
        a.checkId.localeCompare(b.checkId),
      ),
    )
  }

  /** The log, oldest first, as it was written (FR-LOG-01). */
  events(operationId: string): Promise<OperationEvent[]> {
    return Promise.resolve([...(this.eventRows.get(operationId) ?? [])])
  }

  requests(operationId: string): Promise<TransitionRequest[]> {
    return Promise.resolve([...(this.requestRows.get(operationId) ?? [])].reverse())
  }

  /**
   * Asks an operation to move (soc.request_transition). A pilot's verbs need a pilot of the
   * operation; the same client request id gives back the request it made, whatever it names now.
   */
  requestTransition(
    operationId: string,
    transition: Transition,
    clientRequestId: string,
  ): Promise<TransitionRequest> {
    const located = locate(this.operationRows, operationId)
    if (located === undefined || !this.writes(located[0])) {
      return Promise.reject(operationRefusals.roleRefusal(operationRefusals.ROLE_MESSAGES.editor))
    }
    const [organizationId] = located
    if (PILOT_ONLY.has(transition) && !this.isPilot(operationId)) {
      return Promise.reject(operationRefusals.roleRefusal(operationRefusals.ROLE_MESSAGES.pilot))
    }
    const key = askKey(organizationId, clientRequestId)
    const asked = this.transitionsAsked.get(key)
    if (asked !== undefined) return Promise.resolve(asked)
    const request: TransitionRequest = {
      id: this.mintOperation(),
      operationId,
      transition,
      status: 'pending',
      reasons: null,
      requestedBy: this.account?.userId ?? null,
      requestedAt: this.stamp(),
      decidedAt: null,
    }
    this.transitionsAsked.set(key, request)
    this.requestRows.set(operationId, [...(this.requestRows.get(operationId) ?? []), request])
    this.log(operationId, {
      kind: 'transition_requested',
      severity: 'info',
      source: 'operator',
      payload: { transition, request: request.id },
      actor: request.requestedBy,
    })
    this.emit(organizationId, { kind: 'transition_request', payload: requestPayload(request) })
    return Promise.resolve(request)
  }

  flights(operationId: string): Promise<Flight[]> {
    return Promise.resolve([...(this.flightRows.get(operationId) ?? [])].reverse())
  }

  flightStates(operationId: string): Promise<FlightState[]> {
    const states = (this.flightRows.get(operationId) ?? []).flatMap((flight) => {
      const state = this.flightStateRows.get(flight.id)
      return state === undefined ? [] : [state]
    })
    return Promise.resolve(states)
  }

  commands(operationId: string): Promise<CommandIntent[]> {
    return Promise.resolve([...(this.commandRows.get(operationId) ?? [])].reverse())
  }

  /**
   * Asks a flight's aircraft to do a pilot's verb (soc.request_command). A flight that has ended
   * refuses even a repeat: the database checks that before it looks the client request id up.
   */
  requestCommand(
    flightId: string,
    verb: PilotCommandVerb,
    clientRequestId: string,
  ): Promise<CommandIntent> {
    const found = this.findFlight(flightId)
    if (
      found === undefined ||
      !this.writes(found.organizationId) ||
      !this.isPilot(found.flight.operationId)
    ) {
      return Promise.reject(operationRefusals.roleRefusal(operationRefusals.ROLE_MESSAGES.command))
    }
    const { organizationId, flight } = found
    if (flight.endedAt !== null)
      return Promise.reject(operationRefusals.refusedBy('command_flight_ended'))
    const key = askKey(organizationId, clientRequestId)
    const asked = this.commandsAsked.get(key)
    if (asked !== undefined) return Promise.resolve(asked)
    const intent: CommandIntent = {
      id: this.mintOperation(),
      operationId: flight.operationId,
      flightId,
      verb,
      status: 'pending',
      result: null,
      requestedBy: this.account?.userId ?? null,
      requestedAt: this.stamp(),
      sentAt: null,
      repliedAt: null,
    }
    this.commandsAsked.set(key, intent)
    this.commandRows.set(flight.operationId, [
      ...(this.commandRows.get(flight.operationId) ?? []),
      intent,
    ])
    this.log(flight.operationId, {
      kind: 'command_requested',
      severity: 'info',
      source: 'operator',
      payload: { verb },
      actor: intent.requestedBy,
      flight: flightId,
      fleet: flight.fleetId,
      command: intent.id,
    })
    this.emit(organizationId, { kind: 'command_intent', payload: commandPayload(intent) })
    return Promise.resolve(intent)
  }

  stacks(organizationId: string): Promise<StackView[]> {
    return Promise.resolve(
      [...(this.stacksOf.get(organizationId) ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    )
  }

  /** soc-operations moves an operation the way the lifecycle allows (FR-OPS-02): a test's stand-in. */
  moveOperation(
    operationId: string,
    to: OperationState,
    endReason: EndReason | null = null,
  ): Operation {
    const current = this.operationNow(operationId)
    if (!MOVES.some(([from, target]) => from === current.state && target === to)) {
      throw new BackendError(
        `operation ${operationId}: ${current.state} cannot become ${to}`,
        '23514',
      )
    }
    return this.moveState(operationId, to, 'moved by the test', 'soc-operations', endReason, null)
  }

  /** A flight soc-operations prepared for an operation (IR-FLT). */
  addFlight(flight: Flight): void {
    const located = locate(this.operationRows, flight.operationId)
    if (located === undefined) throw new BackendError(`no operation ${flight.operationId}`)
    this.flightRows.set(flight.operationId, [
      ...(this.flightRows.get(flight.operationId) ?? []),
      flight,
    ])
    this.emit(located[0], { kind: 'flight', payload: flightPayload(flight) })
  }

  /** A flight's latest progress, as soc-cloud reports it (IR-FST). */
  setFlightState(state: FlightState): void {
    const found = this.findFlight(state.flightId)
    if (found === undefined) throw new BackendError(`no flight ${state.flightId}`)
    this.flightStateRows.set(state.flightId, state)
    this.emit(found.organizationId, { kind: 'flight_state', payload: flightStatePayload(state) })
  }

  /** The latest judgement of a check, replacing the one before it (IR-CHK, ADR-0025). */
  addCheck(operationId: string, check: OperationCheck): void {
    const located = locate(this.operationRows, operationId)
    if (located === undefined) throw new BackendError(`no operation ${operationId}`)
    const [organizationId] = located
    const others = (this.checkRows.get(operationId) ?? []).filter(
      ({ checkId }) => checkId !== check.checkId,
    )
    this.checkRows.set(operationId, [...others, check])
    this.emit(organizationId, {
      kind: 'operation_check',
      payload: checkPayload(organizationId, operationId, check),
    })
  }

  /** A log entry the database wrote, with the severity the kind has unless one is given. */
  addEvent(
    operationId: string,
    kind: string,
    source: EventSource,
    payload: Readonly<Record<string, unknown>> = {},
    severity: EventSeverity = severityOf(kind),
  ): OperationEvent {
    return this.log(operationId, { kind, severity, source, payload })
  }

  /** soc-operations' verdict on a transition request: pending to running or expired, then decided. */
  settleRequest(
    requestId: string,
    to: TransitionStatus,
    reasons: readonly string[] = [],
  ): TransitionRequest {
    const found = this.findRequest(requestId)
    if (found === undefined) throw new BackendError(`no transition request ${requestId}`)
    const { organizationId, request } = found
    const moves =
      (request.status === 'pending' && (to === 'running' || to === 'expired')) ||
      (request.status === 'running' && (to === 'accepted' || to === 'refused' || to === 'failed'))
    if (!moves) {
      throw new BackendError(
        `transition request ${requestId}: ${request.status} cannot become ${to}`,
        '23514',
      )
    }
    const refusedOrFailed = to === 'refused' || to === 'failed'
    const settled: TransitionRequest = {
      ...request,
      status: to,
      reasons: refusedOrFailed ? [...reasons] : null,
      decidedAt: to === 'running' ? null : this.stamp(),
    }
    this.replaceRequest(request.operationId, settled)
    if (refusedOrFailed) {
      this.log(request.operationId, {
        kind: 'transition_refused',
        severity: to === 'failed' ? 'error' : 'warning',
        source: 'soc-operations',
        payload: { transition: request.transition, request: request.id, reasons: [...reasons] },
      })
    }
    this.emit(organizationId, { kind: 'transition_request', payload: requestPayload(settled) })
    return settled
  }

  onState(organizationId: string, listener: (event: StateEvent) => void): () => void {
    const listeners = this.stateListeners.get(organizationId) ?? new Set()
    listeners.add(listener)
    this.stateListeners.set(organizationId, listeners)
    return () => listeners.delete(listener)
  }

  onTelemetry(organizationId: string, listener: (sample: TelemetrySample) => void): () => void {
    const listeners = this.telemetryListeners.get(organizationId) ?? new Set()
    listeners.add(listener)
    this.telemetryListeners.set(organizationId, listeners)
    return () => listeners.delete(listener)
  }

  private linked: Link = 'up'
  private readonly linkListeners = new Set<(link: Link) => void>()

  link(): Link {
    return this.linked
  }

  onLink(listener: (link: Link) => void): () => void {
    this.linkListeners.add(listener)
    return () => this.linkListeners.delete(listener)
  }

  /** The console's link to Realtime lost, joined again, or joining (NFR-REL-07). */
  setLink(link: Link): void {
    this.linked = link
    for (const listener of this.linkListeners) listener(link)
  }

  /** The site models served beside the console, by organization: none unless a test adds one. */
  readonly sites = new Map<string, LoadedSite>()
  siteFailure: Error | null = null

  siteModel(organizationId: string): Promise<LoadedSite | null> {
    if (this.siteFailure !== null) return Promise.reject(this.siteFailure)
    return Promise.resolve(this.sites.get(organizationId) ?? null)
  }

  /** What soc-cloud broadcasts on the organization's telemetry topic. */
  sample(organizationId: string, sample: TelemetrySample): void {
    for (const listener of this.telemetryListeners.get(organizationId) ?? []) listener(sample)
  }

  watchingTelemetry(organizationId: string): number {
    return this.telemetryListeners.get(organizationId)?.size ?? 0
  }

  /** What the database broadcasts on the organization's state topic. */
  emit(organizationId: string, event: StateEvent): void {
    for (const listener of this.stateListeners.get(organizationId) ?? []) listener(event)
  }

  watching(organizationId: string): number {
    return this.stateListeners.get(organizationId)?.size ?? 0
  }

  private refusal(organizationId: string, draft: FleetDraft, keeping?: string): Error | null {
    if (!this.writes(organizationId)) return this.notAllowed()
    if (draft.name.trim() === '') return new FieldRefusedError('A fleet needs a name.', 'name')
    if (!this.models.some(({ model }) => model === draft.model)) {
      return new FieldRefusedError("Choose the aircraft's model from the catalogue.", 'model')
    }
    if (draft.airframeSerial.trim() === '') {
      return new FieldRefusedError(
        'A fleet needs the serial printed on the airframe.',
        'airframeSerial',
      )
    }
    const taken = (this.registered.get(organizationId) ?? []).some(
      (fleet) =>
        fleet.id !== keeping &&
        fleet.gatewaySn === draft.gatewaySn &&
        fleet.aircraftSn === draft.aircraftSn,
    )
    if (taken) {
      return new FieldRefusedError('This aircraft already belongs to a live fleet.', 'aircraftSn')
    }
    return null
  }

  /** The organization's rows the database holds live: a retired one is in no list. */
  private live<T extends { readonly id: string }>(
    rows: ReadonlyMap<string, readonly T[]>,
    organizationId: string,
  ): T[] {
    return (rows.get(organizationId) ?? []).filter(({ id }) => !this.retired.has(id))
  }

  private replaceIn<T extends { readonly id: string }>(
    rows: Map<string, T[]>,
    organizationId: string,
    row: T,
  ): void {
    rows.set(
      organizationId,
      (rows.get(organizationId) ?? []).map((existing) => (existing.id === row.id ? row : existing)),
    )
  }

  /** The next plan's id: a UUID, numbered in a range of its own apart from the fleets'. */
  private planId(): string {
    this.plansMade += 1
    return `00000000-0000-4000-a000-${String(this.plansMade).padStart(12, '0')}`
  }

  /** The time of the next write, a second after the last, as the database stamps each one. */
  private stamp(): string {
    this.clock += 1000
    return new Date(this.clock).toISOString()
  }

  private writes(organizationId: string): boolean {
    const organization = (this.memberships.get(this.account?.userId ?? '') ?? []).find(
      ({ id }) => id === organizationId,
    )
    return organization !== undefined && organization.role !== 'viewer'
  }

  private notAllowed(): FieldRefusedError {
    return new FieldRefusedError('Only editors and owners change fleets.', null, '42501')
  }

  private locate(fleetId: string): [string, Fleet] {
    for (const [organizationId, fleets] of this.registered) {
      const fleet = fleets.find(({ id }) => id === fleetId)
      if (fleet !== undefined) return [organizationId, fleet]
    }
    throw new BackendError(`no fleet ${fleetId}`)
  }

  private replace(organizationId: string, fleetId: string, fleet: Fleet | null): void {
    const fleets = this.registered.get(organizationId) ?? []
    this.registered.set(
      organizationId,
      fleet === null
        ? fleets.filter(({ id }) => id !== fleetId)
        : fleets.map((existing) => (existing.id === fleetId ? fleet : existing)),
    )
  }

  /** The first constraint an operation's definition breaks, refused as the database names it. */
  private operationRefusal(
    organizationId: string,
    draft: OperationDraft,
  ): FieldRefusedError | null {
    if (draft.name.trim() === '') return operationRefusals.refusedBy('operation_name_given')
    const height = draft.takeoffSecurityHeightM
    if (height !== null && !(height > 0)) {
      return operationRefusals.refusedBy('operation_height_positive')
    }
    const { geofenceId } = draft
    const named = this.live(this.geofenceRows, organizationId).some(({ id }) => id === geofenceId)
    if (geofenceId !== null && !named) {
      return operationRefusals.refusedBy('operations_geofence_id_organization_id_fkey', '23503')
    }
    return null
  }

  /** The first constraint an assignment breaks: its speed, then what it names in the organization. */
  private assignmentRefusal(
    organizationId: string,
    draft: AssignmentDraft,
  ): FieldRefusedError | null {
    if (draft.speedMs !== null && !(draft.speedMs > 0)) {
      return operationRefusals.refusedBy('assignment_speed_positive')
    }
    if (!this.live(this.waylineRows, organizationId).some(({ id }) => id === draft.waylineId)) {
      return operationRefusals.refusedBy('assignments_wayline_id_organization_id_fkey', '23503')
    }
    if (!(this.registered.get(organizationId) ?? []).some(({ id }) => id === draft.fleetId)) {
      return operationRefusals.refusedBy('assignments_fleet_id_organization_id_fkey', '23503')
    }
    return null
  }

  /** The operation as it stands now: asking for one that is not there is a test's mistake. */
  private operationNow(operationId: string): Operation {
    const located = locate(this.operationRows, operationId)
    if (located === undefined) throw new BackendError(`no operation ${operationId}`)
    return located[1]
  }

  private findAssignment(
    assignmentId: string,
  ): { readonly operation: Operation; readonly assignment: Assignment } | undefined {
    for (const assignments of this.assignmentRows.values()) {
      const assignment = assignments.find(({ id }) => id === assignmentId)
      const located =
        assignment === undefined ? undefined : locate(this.operationRows, assignment.operationId)
      if (assignment !== undefined && located !== undefined) {
        return { operation: located[1], assignment }
      }
    }
    return undefined
  }

  private replaceAssignment(operationId: string, assignment: Assignment): void {
    this.assignmentRows.set(
      operationId,
      (this.assignmentRows.get(operationId) ?? []).map((existing) =>
        existing.id === assignment.id ? assignment : existing,
      ),
    )
  }

  private findOperator(operationId: string, profileId: string): Operator | undefined {
    return (this.operatorRows.get(operationId) ?? []).find(
      (operator) => operator.profileId === profileId,
    )
  }

  /** A flight and the organization of its operation, wherever it is held. */
  private findFlight(
    flightId: string,
  ): { readonly organizationId: string; readonly flight: Flight } | undefined {
    for (const flights of this.flightRows.values()) {
      const flight = flights.find(({ id }) => id === flightId)
      const located =
        flight === undefined ? undefined : locate(this.operationRows, flight.operationId)
      if (flight !== undefined && located !== undefined) {
        return { organizationId: located[0], flight }
      }
    }
    return undefined
  }

  private findRequest(
    requestId: string,
  ): { readonly organizationId: string; readonly request: TransitionRequest } | undefined {
    for (const requests of this.requestRows.values()) {
      const request = requests.find(({ id }) => id === requestId)
      const located =
        request === undefined ? undefined : locate(this.operationRows, request.operationId)
      if (request !== undefined && located !== undefined) {
        return { organizationId: located[0], request }
      }
    }
    return undefined
  }

  private replaceRequest(operationId: string, request: TransitionRequest): void {
    this.requestRows.set(
      operationId,
      (this.requestRows.get(operationId) ?? []).map((existing) =>
        existing.id === request.id ? request : existing,
      ),
    )
  }

  /** Whether the signed-in account is a pilot of the operation (FR-CMD-01). */
  private isPilot(operationId: string): boolean {
    return (this.operatorRows.get(operationId) ?? []).some(
      ({ profileId, role }) => role === 'pilot' && profileId === this.account?.userId,
    )
  }

  /** A definition changed: logged, and a preparing, simulated or ready operation planned again. */
  private definitionChanged(operationId: string, what: string): void {
    const actor = this.account?.userId ?? null
    const { state } = this.operationNow(operationId)
    this.log(operationId, {
      kind: 'operation_definition_changed',
      severity: 'info',
      source: 'operator',
      payload: { what },
      actor,
    })
    if (state === 'preparing' || state === 'simulated' || state === 'ready') {
      this.moveState(operationId, 'planned', `${what}_changed`, 'operator', null, actor)
    }
  }

  /** The one way an operation's state moves here: its log entry is written in the same step. */
  private moveState(
    operationId: string,
    to: OperationState,
    cause: string,
    source: EventSource,
    reason: EndReason | null,
    actor: string | null,
  ): Operation {
    const current = this.operationNow(operationId)
    const ends = TERMINAL.has(to)
    const endReason = ends
      ? (reason ?? (to === 'completed' ? 'completed' : to === 'cancelled' ? 'cancelled' : null))
      : null
    if (ends && endReason === null) {
      throw new BackendError(
        `operation ${operationId}: an operation that ends needs its reason`,
        '23514',
      )
    }
    const at = this.stamp()
    const moved: Operation = {
      ...current,
      state: to,
      endReason,
      endedAt: ends ? at : null,
      startedAt: to === 'launching' ? (current.startedAt ?? at) : current.startedAt,
      updatedAt: at,
    }
    this.replaceIn(this.operationRows, current.organizationId, moved)
    this.log(operationId, {
      kind: 'operation_state_changed',
      severity: 'info',
      source,
      payload: {
        from: current.state,
        to,
        cause,
        ...(endReason === null ? {} : { end_reason: endReason }),
      },
      actor,
    })
    this.emit(current.organizationId, { kind: 'operation', payload: operationPayload(moved) })
    return moved
  }

  /** Writes a log entry and announces it on the state topic, as the database does at commit. */
  private log(operationId: string, entry: LogEntry): OperationEvent {
    const { organizationId } = this.operationNow(operationId)
    const at = this.stamp()
    const event: OperationEvent = {
      id: this.mintOperation(),
      organizationId,
      operationId,
      flightId: entry.flight ?? null,
      fleetId: entry.fleet ?? null,
      commandId: entry.command ?? null,
      occurredAt: at,
      recordedAt: at,
      kind: entry.kind,
      severity: entry.severity,
      source: entry.source,
      actorId: entry.actor ?? null,
      payload: entry.payload,
    }
    this.eventRows.set(operationId, [...(this.eventRows.get(operationId) ?? []), event])
    this.emit(organizationId, { kind: 'operation_event', payload: eventPayload(event) })
    return event
  }

  /** The next operation-side id, a UUID in a range of its own apart from the fleets' and plans'. */
  private mintOperation(): string {
    this.operationsMade += 1
    return `00000000-0000-4000-b000-${String(this.operationsMade).padStart(12, '0')}`
  }

  private become(account: Account | null): void {
    this.account = account
    for (const listener of this.listeners) listener(account)
  }
}
