import type {
  AircraftModel,
  Assignment,
  AssignmentChanges,
  AssignmentDraft,
  Fleet,
  Geofence,
  Operation,
  OperationChanges,
  OperationState,
  RefusedField,
  StackView,
  Wayline,
} from '../backend/backend'
import type { Baked } from '../geometry/bake'
import { envelopeFromSkyOrchestrator, flightFromJson, flightToJson } from '../geometry/designJson'
import { planFlight, type Flight } from '../geometry/flight'
import type { Envelope, Violation } from '../geometry/limits'
import type { Geodetic } from '../geometry/projection'
import { fenceViolations } from '../plans/fenceRules'

/**
 * The operation's definition, as the console decides what to write (FR-OPS-01, FR-OPS-07): which
 * values were read, which writes a save makes, and the flight an assignment stores. Pure: the
 * component reads the lists and the queries, and calls these.
 */

/** The highest takeoff security height, in metres: the flight schema's own bound (FR-OPS-01). */
export const MAX_HEIGHT_M = 120

/** A definition may change until a flight of it is prepared: from simulating on, it is fixed (IR-OPS-02). */
const DEFINITION_OPEN: ReadonlySet<OperationState> = new Set<OperationState>([
  'draft',
  'planned',
  'preparing',
  'simulated',
  'ready',
])

/** Operators may change until the operation launches (IR-OPR): simulating does not fix them. */
const OPERATORS_OPEN: ReadonlySet<OperationState> = new Set<OperationState>([
  'draft',
  'planned',
  'preparing',
  'simulating',
  'simulated',
  'ready',
])

export function definitionOpen(state: OperationState): boolean {
  return DEFINITION_OPEN.has(state)
}

export function operatorsOpen(state: OperationState): boolean {
  return OPERATORS_OPEN.has(state)
}

export type DefinitionField =
  'name' | 'geofenceId' | 'heightM' | 'waylineId' | 'fleetId' | 'speedMs'

export type DefinitionErrors = Readonly<Partial<Record<DefinitionField, string>>>

/** The form as typed: every value a string, the empty string where no choice is made. */
export interface DefinitionText {
  readonly name: string
  readonly geofenceId: string
  readonly heightM: string
  readonly waylineId: string
  readonly fleetId: string
  readonly speedMs: string
}

/** The definition as it reads: numbers and ids, null where it is not set. */
export interface DefinitionDraft {
  readonly name: string
  readonly geofenceId: string | null
  readonly heightM: number | null
  readonly waylineId: string | null
  readonly fleetId: string | null
  readonly speedMs: number | null
}

export type ReadDefinition =
  | { readonly ok: true; readonly draft: DefinitionDraft }
  | { readonly ok: false; readonly errors: DefinitionErrors }

const NUMBER = /^(?:\d+\.?\d*|\.\d+)$/

/** A typed number: null when blank, 'invalid' when it is not written as one. */
function numberOf(text: string): number | null | 'invalid' {
  const trimmed = text.trim()
  if (trimmed === '') return null
  return NUMBER.test(trimmed) ? Number(trimmed) : 'invalid'
}

/**
 * The refusals the database would give, before asking it (FR-OPS-01, FR-WAY-10): a name, a
 * height in (0, 120], a speed above zero and at most the fleet's model maximum, and a wayline and
 * a fleet together, since an assignment names both. The database gives the same words for the
 * ones it refuses too.
 */
export function readDefinition(
  text: DefinitionText,
  limits: { readonly maxSpeedMs: number | null },
): ReadDefinition {
  const errors: { -readonly [K in DefinitionField]?: string } = {}
  const name = text.name.trim()
  if (name === '') errors.name = 'An operation needs a name.'
  const heightM = numberOf(text.heightM)
  if (heightM === 'invalid') errors.heightM = 'Enter a number.'
  else if (heightM !== null && !(heightM > 0)) {
    errors.heightM = 'The takeoff security height must be above zero.'
  } else if (heightM !== null && heightM > MAX_HEIGHT_M) {
    errors.heightM = `The takeoff security height is at most ${String(MAX_HEIGHT_M)} m.`
  }
  const speedMs = numberOf(text.speedMs)
  if (speedMs === 'invalid') errors.speedMs = 'Enter a number.'
  else if (speedMs !== null && !(speedMs > 0)) {
    errors.speedMs = 'The speed the fleet flies the wayline at must be above zero.'
  } else if (speedMs !== null && limits.maxSpeedMs !== null && speedMs > limits.maxSpeedMs) {
    errors.speedMs = `Above the fleet's model maximum of ${String(limits.maxSpeedMs)} m/s.`
  }
  const waylineId = text.waylineId === '' ? null : text.waylineId
  const fleetId = text.fleetId === '' ? null : text.fleetId
  if (waylineId === null && fleetId !== null)
    errors.waylineId = 'Choose the wayline this fleet flies.'
  if (fleetId === null && waylineId !== null)
    errors.fleetId = 'Choose the fleet that flies this wayline.'
  if (waylineId === null && fleetId === null && typeof speedMs === 'number') {
    errors.speedMs = 'Choose a wayline and a fleet first.'
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return {
    ok: true,
    draft: {
      name,
      geofenceId: text.geofenceId === '' ? null : text.geofenceId,
      heightM: typeof heightM === 'number' ? heightM : null,
      waylineId,
      fleetId,
      speedMs: typeof speedMs === 'number' ? speedMs : null,
    },
  }
}

/** The form's values for what is stored: the operation's, and its one assignment's if it has one. */
export function storedText(operation: Operation, assignment: Assignment | null): DefinitionText {
  return {
    name: operation.name,
    geofenceId: operation.geofenceId ?? '',
    heightM:
      operation.takeoffSecurityHeightM === null ? '' : String(operation.takeoffSecurityHeightM),
    waylineId: assignment?.waylineId ?? '',
    fleetId: assignment?.fleetId ?? '',
    speedMs: assignment === null || assignment.speedMs === null ? '' : String(assignment.speedMs),
  }
}

/** A wayline's bake as the flight takes it: its waypoints in order, and its distance. */
export function bakedOf(wayline: Wayline): Baked {
  return {
    waypoints: wayline.waypoints.map(({ index, position, heightM }) => ({
      index,
      latitudeDeg: position.latitudeDeg,
      longitudeDeg: position.longitudeDeg,
      heightM,
    })),
    distanceM: wayline.metrics.distanceM,
  }
}

/** What the flight of an assignment is computed from (FR-WAY-10, FR-WAY-11). */
export interface FlightInputs {
  readonly wayline: Wayline | undefined
  readonly fleet: Fleet | undefined
  readonly heightM: number | null
  readonly speedMs: number | null
  /** The site frame's origin, the one every local measure is taken from (ADR-0014). */
  readonly origin: Geodetic | null
  readonly envelope: Envelope | null
}

/**
 * The flight an assignment stores, as flightToJson writes it: `planFlight` of the wayline's
 * bake from its takeoff, at the operation's height and the assignment's speed, finishing at home.
 * Null while any of the height, the wayline, the fleet, the speed or the origin is not known. It
 * is read back as the schema reads it before it is returned, so a flight the schema refuses is
 * never written (as a design the schema refuses is never saved).
 */
export function flightFor(inputs: FlightInputs): Record<string, unknown> | null {
  const { wayline, fleet, heightM, speedMs, origin, envelope } = inputs
  if (
    wayline === undefined ||
    fleet === undefined ||
    heightM === null ||
    speedMs === null ||
    origin === null
  ) {
    return null
  }
  const flight = planFlight(wayline.takeoff, bakedOf(wayline), {
    origin,
    takeoffSecurityHeightM: heightM,
    speedMs,
    finishAction: 'return_home',
    envelope,
  })
  const written = flightToJson(flight)
  flightFromJson(written)
  return written
}

/**
 * The stack's envelope as the flight is checked against it, or null while the stack has not read
 * one (FR-LNK-09): then no leg is split and no limit is judged. Throws on an envelope it cannot read.
 */
export function envelopeOf(stack: StackView | undefined): Envelope | null {
  if (stack === undefined || stack.envelope === null) return null
  return envelopeFromSkyOrchestrator(stack.envelope)
}

/** The flight a stored assignment holds, read as the schema reads it; null while it holds none. */
export function storedFlight(
  json: Readonly<Record<string, unknown>> | null,
):
  | { readonly ok: true; readonly flight: Flight | null }
  | { readonly ok: false; readonly message: string } {
  if (json === null) return { ok: true, flight: null }
  try {
    return { ok: true, flight: flightFromJson(json) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** What a flight breaks of its geofence, named as the envelope names its own (fenceRules.ts). */
export function fenceProblems(
  flight: Flight,
  geofence: Geofence | undefined,
  origin: Geodetic | null,
): Violation[] {
  if (geofence === undefined || origin === null) return []
  return fenceViolations(
    flight,
    { polygon: geofence.polygon, maxHeightM: geofence.maxHeightM },
    origin,
  )
}

export interface StoredDefinition {
  readonly operation: Operation
  readonly assignment: Assignment | null
}

export type AssignmentWrite =
  | { readonly kind: 'assign'; readonly draft: AssignmentDraft }
  | { readonly kind: 'change'; readonly id: string; readonly changes: AssignmentChanges }

/** The writes a save makes, the operation's first: each is null when nothing it holds changed. */
export interface SavePlan {
  readonly operation: OperationChanges | null
  readonly assignment: AssignmentWrite | null
}

/**
 * What a save writes (FR-OPS-01). The operation takes the fields that changed. The assignment is
 * written when its wayline, fleet or speed changed, or the height did (the flight climbs to it),
 * and then with its flight, in the same write. A new assignment needs its wayline and its fleet.
 */
export function planSave(
  stored: StoredDefinition,
  next: DefinitionDraft,
  flight: Record<string, unknown> | null,
): SavePlan {
  return {
    operation: operationChangesOf(stored.operation, next),
    assignment: assignmentWriteOf(stored, next, flight),
  }
}

function operationChangesOf(operation: Operation, next: DefinitionDraft): OperationChanges | null {
  const changes: { -readonly [K in keyof OperationChanges]: OperationChanges[K] } = {}
  if (next.name !== operation.name) changes.name = next.name
  if (next.geofenceId !== operation.geofenceId) changes.geofenceId = next.geofenceId
  if (next.heightM !== operation.takeoffSecurityHeightM) {
    changes.takeoffSecurityHeightM = next.heightM
  }
  return Object.keys(changes).length === 0 ? null : changes
}

function assignmentWriteOf(
  { operation, assignment }: StoredDefinition,
  next: DefinitionDraft,
  flight: Record<string, unknown> | null,
): AssignmentWrite | null {
  const { waylineId, fleetId, speedMs } = next
  if (waylineId === null || fleetId === null) return null
  if (assignment === null) {
    return { kind: 'assign', draft: { waylineId, fleetId, speedMs, flight } }
  }
  const changes: { -readonly [K in keyof AssignmentChanges]: AssignmentChanges[K] } = {}
  if (waylineId !== assignment.waylineId) changes.waylineId = waylineId
  if (fleetId !== assignment.fleetId) changes.fleetId = fleetId
  if (speedMs !== assignment.speedMs) changes.speedMs = speedMs
  // The flight is written again when what it is made of changed here, or anywhere else: the
  // wayline edited, the stack's envelope read anew (FR-OPS-07).
  const flies =
    Object.keys(changes).length > 0 ||
    next.heightM !== operation.takeoffSecurityHeightM ||
    !sameJson(flight, assignment.flight)
  if (!flies) return null
  return { kind: 'change', id: assignment.id, changes: { ...changes, flight } }
}

/** The field of the definition a refusal names, when it names one the form shows. */
export function definitionFieldOf(field: RefusedField | null): DefinitionField | null {
  switch (field) {
    case 'name':
    case 'geofenceId':
    case 'waylineId':
    case 'fleetId':
    case 'speedMs':
      return field
    case 'takeoffSecurityHeightM':
      return 'heightM'
    default:
      return null
  }
}

/** The organization's lists the definition takes its choices from, read before it is shown. */
export interface Choices {
  readonly waylines: readonly Wayline[]
  readonly fleets: readonly Fleet[]
  readonly geofences: readonly Geofence[]
  readonly stacks: readonly StackView[]
  readonly models: readonly AircraftModel[]
  /** The site frame's origin, which the flight is measured from (ADR-0014). */
  readonly origin: Geodetic | null
}

/** The flight the draft's assignment would store, from the lists it names; null while incomplete. */
export function draftFlight(
  draft: DefinitionDraft,
  choices: Choices,
): Record<string, unknown> | null {
  const fleet = choices.fleets.find(({ id }) => id === draft.fleetId)
  const stack = choices.stacks.find(({ gatewaySn }) => gatewaySn === fleet?.gatewaySn)
  return flightFor({
    wayline: choices.waylines.find(({ id }) => id === draft.waylineId),
    fleet,
    heightM: draft.heightM,
    speedMs: draft.speedMs,
    origin: choices.origin,
    envelope: envelopeOf(stack),
  })
}

/** Two JSON values are the same, whatever the order of their keys (a jsonb column reorders them). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameJson(item, b[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
  )
}

/**
 * Whether the stored flight is no longer the one its operation's stored definition makes: its
 * wayline was edited, or the stack's envelope changed, since it was saved. False while either
 * cannot be made: nothing to compare.
 */
export function flightOutdated(
  operation: Operation,
  assignment: Assignment | null,
  choices: Choices,
): boolean {
  if (assignment === null || assignment.flight === null) return false
  const read = readDefinition(storedText(operation, assignment), { maxSpeedMs: null })
  if (!read.ok) return false
  try {
    const current = draftFlight(read.draft, choices)
    return current !== null && !sameJson(current, assignment.flight)
  } catch {
    return false
  }
}
