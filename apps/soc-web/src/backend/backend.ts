import type { Link } from './link'
import type { Geodetic } from '../geometry/projection'
import type { LoadedSite } from '../scene/siteModel'
import type { TelemetrySample } from '../telemetry/sample'

export interface Account {
  readonly userId: string
  readonly email: string
}

export type Role = 'owner' | 'editor' | 'viewer'

export interface Position {
  readonly latitude: number
  readonly longitude: number
}

export interface Organization {
  readonly id: string
  readonly name: string
  readonly role: Role
  readonly position: Position | null
  readonly timeZone: string | null
}

export type SignInRefusal = 'credentials' | 'unconfirmed' | 'rate_limited' | 'unreachable' | 'other'

export interface SignInFailure {
  readonly reason: SignInRefusal
  readonly detail: string
}

export class BackendError extends Error {
  readonly code: string | null

  constructor(message: string, code: string | null = null) {
    super(message)
    this.code = code
  }
}

/** A model of the catalogue (IR-MOD): each published figure, or null, and where it was read. */
export interface AircraftModel {
  readonly model: string
  readonly displayName: string
  readonly msdkV4Support: 'full' | 'partial'
  readonly supportNotes: string
  readonly maxHorizontalSpeedMs: number | null
  readonly maxAscentSpeedMs: number | null
  readonly maxDescentSpeedMs: number | null
  readonly maxFlightTimeS: number | null
  readonly maxServiceCeilingM: number | null
  readonly maxWindResistanceMs: number | null
  readonly weightG: number | null
  readonly camera: Readonly<
    Record<'sensor' | 'photoResolution' | 'videoResolution' | 'zoom', string | null>
  >
  readonly thermal: {
    readonly capability: 'integrated' | 'payload' | 'none'
    readonly resolution: string | null
  }
  readonly sources: Readonly<Record<string, string>>
}

export type LinkState = 'connected' | 'connecting' | 'displaced' | 'unreachable'

/** One aircraft on the wire: its gateway's serial and its own (IR-DEV's key). */
export function aircraftKey(gatewaySn: string, aircraftSn: string): string {
  return `${gatewaySn}/${aircraftSn}`
}

/** An aircraft a stack of the organization has announced (IR-DEV). */
export interface Device {
  readonly gatewaySn: string
  readonly aircraftSn: string
  /** DJI's model key on the wire, `domain-type-sub_type`: `0-67-0` is a Mavic Air 2 through SO. */
  readonly wireModel: string
  readonly online: boolean
  readonly firmwareVersion: string | null
  readonly firstSeenAt: string
  readonly lastSeenAt: string
  readonly stack: { readonly name: string; readonly linkState: LinkState }
}

/** A registered aircraft (IR-FLE). */
export interface Fleet {
  readonly id: string
  readonly name: string
  readonly model: string
  readonly airframeSerial: string
  readonly controllerSerial: string | null
  readonly gatewaySn: string
  readonly aircraftSn: string
  readonly flightTimeBeforeSocS: number
  readonly createdAt: string
  readonly updatedAt: string
}

export interface FleetDraft {
  readonly name: string
  readonly model: string
  readonly airframeSerial: string
  readonly controllerSerial: string | null
  readonly gatewaySn: string
  readonly aircraftSn: string
  readonly flightTimeBeforeSocS: number
}

/** Any field, the wire identity too while the fleet has no unfinished flight (FR-FLE-05). */
export type FleetChanges = Partial<FleetDraft>

export type FleetField = keyof FleetDraft

/** A geofence the organization drew, or generated around its waylines (IR-GEO, FR-GEO-02). */
export type GeofenceOrigin = 'drawn' | 'generated'

export interface Geofence {
  readonly id: string
  readonly name: string
  /** The ring in order, not closed, at least three vertices (FR-GEO-04). */
  readonly polygon: readonly Geodetic[]
  /** Above the takeoff point. */
  readonly maxHeightM: number
  readonly origin: GeofenceOrigin
  /** Set only when generated, from 5 to 100 m (FR-GEO-03). */
  readonly marginM: number | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface GeofenceDraft {
  readonly name: string
  readonly polygon: readonly Geodetic[]
  readonly maxHeightM: number
  readonly origin: GeofenceOrigin
  readonly marginM: number | null
}

export type GeofenceChanges = Partial<GeofenceDraft>

export type GeofenceField = keyof GeofenceDraft

/** One baked waypoint: where, and how high above the takeoff point. */
export interface Waypoint {
  readonly index: number
  readonly position: Geodetic
  readonly heightM: number
}

/** A wayline's bake in figures: its waypoints and its distance. Its duration is its flight's. */
export interface WaylineMetrics {
  readonly waypointCount: number
  readonly distanceM: number
}

/**
 * A wayline: its design as drawn and its bake, stored together (IR-WAY-01). A wayline is
 * geometry: its speed, its climb, its finish and its geofence are the operation's (M4).
 */
export interface Wayline {
  readonly id: string
  readonly name: string
  readonly takeoff: Geodetic
  readonly defaultHeightM: number
  readonly design: Readonly<Record<string, unknown>>
  readonly waypoints: readonly Waypoint[]
  readonly metrics: WaylineMetrics
  /** The version of the bake that produced `waypoints`. */
  readonly bakeVersion: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface WaylineDraft {
  readonly name: string
  readonly takeoff: Geodetic
  readonly defaultHeightM: number
  readonly design: Readonly<Record<string, unknown>>
  readonly waypoints: readonly Waypoint[]
  readonly metrics: WaylineMetrics
  readonly bakeVersion: string
}

export type WaylineChanges = Partial<WaylineDraft>

export type WaylineField = keyof WaylineDraft

/** The fourteen states an operation is in (FR-OPS-02, IR-OPS). */
export type OperationState =
  | 'draft'
  | 'planned'
  | 'preparing'
  | 'simulating'
  | 'simulated'
  | 'ready'
  | 'launching'
  | 'in_flight'
  | 'paused'
  | 'returning'
  | 'completed'
  | 'aborted'
  | 'failed'
  | 'cancelled'

/** How an operation ended, once it has (IR-OPS). */
export type EndReason =
  | 'completed'
  | 'operator_stop'
  | 'operator_return'
  | 'geofence_breach'
  | 'envelope_breach'
  | 'low_battery'
  | 'link_lost'
  | 'pilot_takeover'
  | 'aircraft_fault'
  | 'cancelled'

export type OperatorRole = 'pilot' | 'observer'

export type FlightMode = 'simulated' | 'real'

/** DJI's flight task status, as soc-cloud reads it (IR-FST). */
export type FlightStatus =
  | 'sent'
  | 'in_progress'
  | 'paused'
  | 'ok'
  | 'failed'
  | 'canceled'
  | 'rejected'
  | 'timeout'
  | 'partially_done'

export type EventSeverity = 'info' | 'warning' | 'error' | 'safety'

export type EventSource = 'operator' | 'soc-operations' | 'soc-cloud' | 'aircraft'

/** A move a member asks an operation to make (IR-TRQ-01). */
export type Transition =
  'plan' | 'prepare' | 'unprepare' | 'simulate' | 'launch' | 'stop' | 'cancel'

export type TransitionStatus = 'pending' | 'running' | 'accepted' | 'refused' | 'failed' | 'expired'

export type CheckState = 'pass' | 'fail' | 'unknown'

/** Every verb a command intent can carry (IR-CMD). */
export type CommandVerb = 'prepare' | 'execute' | 'pause' | 'recovery' | 'return_home' | 'undo'

/** The verbs a pilot asks, through soc.request_command (FR-CMD-01). */
export type PilotCommandVerb = 'pause' | 'recovery' | 'return_home' | 'undo'

export type CommandStatus =
  'pending' | 'sent' | 'accepted' | 'refused' | 'failed' | 'timed_out' | 'expired'

/** An operation: what flies, where, at what height, and the state it is in (IR-OPS). */
export interface Operation {
  readonly id: string
  readonly organizationId: string
  readonly name: string
  readonly geofenceId: string | null
  /** Metres above the takeoff point the fleets climb to before the transit (FR-OPS-01). */
  readonly takeoffSecurityHeightM: number | null
  readonly state: OperationState
  readonly endReason: EndReason | null
  readonly createdBy: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly startedAt: string | null
  readonly endedAt: string | null
}

export interface OperationDraft {
  readonly name: string
  readonly geofenceId: string | null
  readonly takeoffSecurityHeightM: number | null
}

export type OperationChanges = Partial<OperationDraft>

export type OperationField = keyof OperationDraft

/** A wayline flown by a fleet within an operation (IR-ASG). */
export interface Assignment {
  readonly id: string
  readonly operationId: string
  readonly waylineId: string
  readonly fleetId: string
  readonly speedMs: number | null
  /** The wayline as the operation flies it, validated by soc-operations (IR-ASG). */
  readonly flight: Readonly<Record<string, unknown>> | null
}

export interface AssignmentDraft {
  readonly waylineId: string
  readonly fleetId: string
  readonly speedMs: number | null
  readonly flight: Readonly<Record<string, unknown>> | null
}

export type AssignmentChanges = Partial<AssignmentDraft>

export type AssignmentField = keyof AssignmentDraft

/** A member taking part in an operation, as its pilot or its observer (IR-OPR). */
export interface Operator {
  readonly operationId: string
  readonly profileId: string
  readonly role: OperatorRole
}

export type OperatorField = 'profileId' | 'role'

/** A live member of the organization, whom an operation can name as an operator (IR-OPR). */
export interface Member {
  readonly profileId: string
  readonly displayName: string | null
  readonly email: string | null
  readonly role: Role
}

/** The latest judgement of one preflight check of an operation (IR-CHK, FR-OPS-05). */
export interface OperationCheck {
  readonly checkId: string
  readonly state: CheckState
  readonly blocking: boolean
  readonly value: unknown
  readonly detail: string | null
  readonly evaluatedAt: string
}

/** One entry of an operation's append-only log (IR-EVT, FR-LOG-01). */
export interface OperationEvent {
  readonly id: string
  readonly organizationId: string
  readonly operationId: string
  readonly flightId: string | null
  readonly fleetId: string | null
  readonly commandId: string | null
  readonly occurredAt: string
  readonly recordedAt: string
  readonly kind: string
  readonly severity: EventSeverity
  readonly source: EventSource
  readonly actorId: string | null
  readonly payload: Readonly<Record<string, unknown>>
}

/** A member's ask that an operation move, with its outcome (IR-TRQ). */
export interface TransitionRequest {
  readonly id: string
  readonly operationId: string
  readonly transition: Transition
  readonly status: TransitionStatus
  readonly reasons: readonly string[] | null
  readonly requestedBy: string | null
  readonly requestedAt: string
  readonly decidedAt: string | null
}

/** One DJI flight task of an operation: one fleet flying one file (IR-FLT). */
export interface Flight {
  readonly id: string
  readonly operationId: string
  readonly mode: FlightMode
  readonly fleetId: string
  readonly gatewaySn: string
  readonly aircraftSn: string
  readonly preparedAt: string
  readonly executedAt: string | null
  readonly tookOffAt: string | null
  readonly landedAt: string | null
  readonly endedAt: string | null
  readonly endReason: EndReason | null
  /** When soc-cloud sent its return home on a geofence breach (FR-SAF-01), or null. */
  readonly breachedAt: string | null
}

/**
 * One stored sample of a flight's track (IR-TEL, FR-TEL-05): where the aircraft was, and how high
 * above the takeoff point. A flight's track is its samples in time order.
 */
export interface TrackPoint {
  /** When the aircraft took the sample, as the database sends it: ISO 8601 with its offset. */
  readonly sampledAt: string
  readonly position: Geodetic
  /** Metres above the takeoff point (ADR-0014). */
  readonly heightM: number
}

/** The latest progress of a flight, as soc-cloud reports it (IR-FST). */
export interface FlightState {
  readonly flightId: string
  readonly status: FlightStatus
  readonly result: number | null
  readonly percent: number | null
  readonly currentWaypointIndex: number | null
  readonly endReason: EndReason | null
  readonly updatedAt: string
}

/** A pilot's command to a flight's aircraft, and its outcome (IR-CMD). */
export interface CommandIntent {
  readonly id: string
  readonly operationId: string
  readonly flightId: string
  readonly verb: CommandVerb
  readonly status: CommandStatus
  readonly result: number | null
  readonly requestedBy: string | null
  readonly requestedAt: string
  readonly sentAt: string | null
  readonly repliedAt: string | null
}

/** A stack as the console needs it to fly: its envelope, and when it was last read (IR-STK). */
export interface StackView {
  readonly gatewaySn: string
  readonly name: string
  readonly linkState: LinkState
  /** Sky Orchestrator's envelope, or null while it has not been read: an unknown stays unknown. */
  readonly envelope: Readonly<Record<string, unknown>> | null
  readonly envelopeReadAt: string | null
  /** The mode its status last said: true in the simulator, false for real, null while not said. */
  readonly simulatorMode: boolean | null
}

/** Any field a write can name: a fleet's, a geofence's, a wayline's or an operation's. */
export type RefusedField =
  FleetField | GeofenceField | WaylineField | OperationField | AssignmentField | OperatorField

/** A write the database refused, with the field it names when it names one. */
export class FieldRefusedError extends BackendError {
  readonly field: RefusedField | null

  constructor(message: string, field: RefusedField | null, code: string | null = null) {
    super(message, code)
    this.field = field
  }
}

/**
 * A change on the organization's state topic (ADR-0007), from the database's triggers, or
 * `joined` each time the topic is joined: broadcasts sent while away are not replayed, so
 * whatever was read before then may be stale. `joined` comes once more after a join, with its
 * first broadcast or JOIN_SETTLE_MS without one, since Realtime delivers to a join only a
 * moment after it (supabaseFleets.ts).
 */
export interface StateEvent {
  readonly kind:
    | 'joined'
    | 'stack'
    | 'device'
    | 'fleet'
    | 'command_intent'
    | 'geofence'
    | 'wayline'
    | 'operation'
    | 'flight'
    | 'flight_state'
    | 'operation_event'
    | 'transition_request'
    | 'operation_check'
  /** The row the database broadcast, as it sent it: snake_case, the operation's id included. */
  readonly payload: Readonly<Record<string, unknown>>
}

/** Everything the web asks of Supabase, so the interface can be tested without it. */
export interface Backend {
  readonly address: string
  onAccountChange(listener: (account: Account | null) => void): () => void
  signIn(email: string, password: string): Promise<SignInFailure | null>
  signOut(): Promise<void>
  memberOrganizations(): Promise<Organization[]>
  aircraftModels(): Promise<AircraftModel[]>
  devices(organizationId: string): Promise<Device[]>
  fleets(organizationId: string): Promise<Fleet[]>
  registerFleet(organizationId: string, draft: FleetDraft): Promise<Fleet>
  changeFleet(fleetId: string, changes: FleetChanges): Promise<Fleet>
  retireFleet(fleetId: string): Promise<void>
  geofences(organizationId: string): Promise<Geofence[]>
  createGeofence(organizationId: string, draft: GeofenceDraft): Promise<Geofence>
  changeGeofence(geofenceId: string, changes: GeofenceChanges): Promise<Geofence>
  retireGeofence(geofenceId: string): Promise<void>
  waylines(organizationId: string): Promise<Wayline[]>
  createWayline(organizationId: string, draft: WaylineDraft): Promise<Wayline>
  changeWayline(waylineId: string, changes: WaylineChanges): Promise<Wayline>
  retireWayline(waylineId: string): Promise<void>
  operations(organizationId: string): Promise<Operation[]>
  createOperation(organizationId: string, draft: OperationDraft): Promise<Operation>
  changeOperation(operationId: string, changes: OperationChanges): Promise<Operation>
  assignments(operationId: string): Promise<Assignment[]>
  assign(operationId: string, organizationId: string, draft: AssignmentDraft): Promise<Assignment>
  changeAssignment(assignmentId: string, changes: AssignmentChanges): Promise<Assignment>
  unassign(assignmentId: string): Promise<void>
  operators(operationId: string): Promise<Operator[]>
  members(organizationId: string): Promise<Member[]>
  nameOperator(
    operationId: string,
    organizationId: string,
    profileId: string,
    role: OperatorRole,
  ): Promise<Operator>
  changeOperator(operationId: string, profileId: string, role: OperatorRole): Promise<Operator>
  removeOperator(operationId: string, profileId: string): Promise<void>
  checks(operationId: string): Promise<OperationCheck[]>
  events(operationId: string): Promise<OperationEvent[]>
  requests(operationId: string): Promise<TransitionRequest[]>
  /** Asks the operation to move; the same client request id gives back the same request. */
  requestTransition(
    operationId: string,
    transition: Transition,
    clientRequestId: string,
  ): Promise<TransitionRequest>
  flights(operationId: string): Promise<Flight[]>
  flightStates(operationId: string): Promise<FlightState[]>
  /** A flight's stored samples in time order: its track, during and after the flight (FR-TEL-05). */
  track(flightId: string): Promise<TrackPoint[]>
  commands(operationId: string): Promise<CommandIntent[]>
  /** Asks the flight's aircraft to do a verb; the same client request id gives back the same intent. */
  requestCommand(
    flightId: string,
    verb: PilotCommandVerb,
    clientRequestId: string,
  ): Promise<CommandIntent>
  stacks(organizationId: string): Promise<StackView[]>
  onState(organizationId: string, listener: (event: StateEvent) => void): () => void
  onTelemetry(organizationId: string, listener: (sample: TelemetrySample) => void): () => void
  /** Whether the console's live topics reach it now (NFR-REL-07). */
  link(): Link
  onLink(listener: (link: Link) => void): () => void
  /** The organization's baked site model, served beside the console, or null (ADR-0018). */
  siteModel(organizationId: string): Promise<LoadedSite | null>
}
