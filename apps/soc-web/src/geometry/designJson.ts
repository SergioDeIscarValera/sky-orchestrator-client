import { BackendError } from '../backend/backend'
import { positionFromStorage, positionToStorage } from '../backend/positions'
import { z } from '../schema'
import type { Baked, BakedWaypoint, Design, DesignPoint, Primitive } from './bake'
import type { Flight } from './flight'
import type { Envelope, Violation } from './limits'
import type { Geodetic } from './projection'

/**
 * A wayline's design and its bake, and the flight an operation makes of it, as
 * contracts/geometry/design.schema.json (2.0.0) writes them
 * (FR-WAY-09): what the designer saves to soc.waylines and reads back as saved. Reading
 * refuses what the schema refuses, naming the path of each refusal; it never guesses a value
 * or fills a default. Writing gives the schema's keys and only those, the optional ones left
 * out when undefined. Sky Orchestrator's envelope is read the same way (FR-WAY-11).
 */

/** The version written; a document at any 2.x.y reads, as the schema's pattern allows. */
const SCHEMA_VERSION = '2.1.0'
const VERSION_2X = z.string().check(z.regex(/^2\.[0-9]+\.[0-9]+$/))

/** positionFromStorage's answer, its refusal returned rather than thrown, for a zod transform. */
function positionOrRefusal(stored: unknown): Geodetic | string {
  try {
    return positionFromStorage(stored)
  } catch (refusal) {
    if (refusal instanceof BackendError) return refusal.message
    throw refusal
  }
}

/**
 * [longitude, latitude] in GeoJSON order. The one check positions get is positionFromStorage's,
 * and a refusal is an issue at the position's own path, so the error names where it is.
 */
const POSITION = z.pipe(
  z.unknown(),
  z.transform((stored, ctx) => {
    const position = positionOrRefusal(stored)
    if (typeof position === 'string') {
      ctx.issues.push({ code: 'custom', message: position, input: stored })
      return z.NEVER
    }
    return position
  }),
)

/**
 * Sky Orchestrator's centre, latitude first in its API. It is read as the stored pair, so the
 * same check applies to it, and a centre in SOC's order is refused as not an object.
 */
const CENTRE = z.pipe(
  z.strictObject({ latitude_deg: z.number(), longitude_deg: z.number() }),
  z.transform(({ latitude_deg, longitude_deg }, ctx) => {
    const centre = positionOrRefusal([longitude_deg, latitude_deg])
    if (typeof centre === 'string') {
      ctx.issues.push({ code: 'custom', message: centre, input: { latitude_deg, longitude_deg } })
      return z.NEVER
    }
    return centre
  }),
)

/** A height above the takeoff point, a radius, a spacing, a speed: above zero (ADR-0014). */
const ABOVE_ZERO = z.number().check(z.gt(0))
const FINISH_ACTION = z.enum(['return_home', 'hold', 'land'])

// The schema reserves waypoint actions and the console draws none yet (FR-WAY-12). A document
// with one is refused rather than read with the action dropped, so nothing is lost silently.
const RESERVED_ACTIONS = z.optional(
  z.never({
    error: 'The console draws no waypoint actions yet: the schema reserves them (FR-WAY-12).',
  }),
)

// A wayline has one speed (FR-WAY-10), so the bake sets none on a waypoint; one that carries
// its own is refused for the same reason as an action.
const NO_WAYPOINT_SPEED = z.optional(
  z.never({ error: 'The bake sets no speed per waypoint: a wayline has one speed (FR-WAY-10).' }),
)

const POINT = z.strictObject({
  position: POSITION,
  height_m: z.optional(ABOVE_ZERO),
  actions: RESERVED_ACTIONS,
})

const ROUTE = z.strictObject({
  kind: z.literal('route'),
  points: z.array(POINT).check(z.minLength(2)),
})

const POINTS = z.strictObject({
  kind: z.literal('points'),
  points: z.array(POINT).check(z.minLength(1)),
})

const CIRCLE = z.strictObject({
  kind: z.literal('circle'),
  centre: POSITION,
  radius_m: ABOVE_ZERO,
  clockwise: z.boolean(),
  start_bearing_deg: z.number().check(z.gte(0), z.lt(360)),
  height_m: z.optional(ABOVE_ZERO),
})

const GRID = z.strictObject({
  kind: z.literal('grid'),
  area: z.array(POSITION).check(z.minLength(3)),
  line_spacing_m: ABOVE_ZERO,
  point_spacing_m: ABOVE_ZERO,
  angle_deg: z.optional(z.number().check(z.gte(0), z.lt(180))),
  height_m: z.optional(ABOVE_ZERO),
})

const PRIMITIVE = z.discriminatedUnion('kind', [ROUTE, POINTS, CIRCLE, GRID])

const DESIGN = z.strictObject({
  schema_version: VERSION_2X,
  takeoff: POSITION,
  default_height_m: ABOVE_ZERO,
  primitives: z.array(PRIMITIVE),
})

const VIOLATION = z.strictObject({
  rule: z.string().check(z.regex(/^[a-z][a-z_]*$/)),
  message: z.string(),
  waypoint_index: z.optional(z.int().check(z.gte(0))),
})

const BAKED_WAYPOINT = z.strictObject({
  index: z.int().check(z.gte(0)),
  position: POSITION,
  height_m: ABOVE_ZERO,
  speed_ms: NO_WAYPOINT_SPEED,
  actions: RESERVED_ACTIONS,
})

// A bake with no waypoint is never a wayline, so the schema refuses one: nothing drawn
// bakes to no waypoint, and saving that bake is refused here.
const BAKED = z.strictObject({
  schema_version: VERSION_2X,
  waypoints: z.array(BAKED_WAYPOINT).check(z.minLength(1)),
  distance_m: z.number().check(z.gte(0)),
})

// A flight with no waypoint is never a plan: the flight reports `no_waypoints`, and
// writing it down is refused here.
const FLIGHT = z.strictObject({
  schema_version: VERSION_2X,
  takeoff_security_height_m: z.number().check(z.gt(0), z.lte(120)),
  reference_point: POSITION,
  speed_ms: ABOVE_ZERO,
  finish_action: FINISH_ACTION,
  waypoints: z.array(BAKED_WAYPOINT).check(z.minLength(1), z.maxLength(200)),
  distance_m: z.number().check(z.gte(0)),
  duration_s: z.number().check(z.gte(0)),
  violations: z.array(VIOLATION),
})

// Sky Orchestrator's envelope, the object its GET /v1/envelope answers under `envelope`
// (contracts/sky-orchestrator/wayline/openapi.yaml): every key there, nothing else.
const ENVELOPE = z.strictObject({
  geofence_center: CENTRE,
  geofence_radius_m: ABOVE_ZERO,
  max_height_m: ABOVE_ZERO,
  max_home_distance_m: ABOVE_ZERO,
  max_leg_m: ABOVE_ZERO,
  max_transit_m: ABOVE_ZERO,
  max_total_distance_m: ABOVE_ZERO,
  max_waypoints: z.int().check(z.gte(1)),
  max_horizontal_speed_ms: ABOVE_ZERO,
})

/**
 * The value parsed by its schema, or an Error naming the path of every refusal in the schema's
 * words, such as `design.primitives[0].points[1].height_m: Too small: expected number to be >0`.
 */
function parse<T>(schema: z.ZodMiniType<T>, raw: unknown, root: string): T {
  const parsed = z.safeParse(schema, raw)
  if (parsed.success) return parsed.data
  throw new Error(
    parsed.error.issues.map((issue) => `${pathOf(root, issue.path)}: ${issue.message}`).join('; '),
  )
}

/** The path a refusal is about, as the schema names it: `root.key`, `root.list[0]`. */
function pathOf(root: string, path: readonly PropertyKey[]): string {
  return path.reduce<string>(
    (name, key) => (typeof key === 'number' ? `${name}[${String(key)}]` : `${name}.${String(key)}`),
    root,
  )
}

/** The console's Design from a design as the schema writes it; refused when the schema refuses it. */
export function designFromJson(raw: unknown): Design {
  const json = parse(DESIGN, raw, 'design')
  return {
    takeoff: json.takeoff,
    defaultHeightM: json.default_height_m,
    primitives: json.primitives.map((primitive) => primitiveOf(primitive)),
  }
}

function primitiveOf(json: z.infer<typeof PRIMITIVE>): Primitive {
  switch (json.kind) {
    case 'route':
      return { kind: 'route', points: json.points.map((point) => pointOf(point)) }
    case 'points':
      return { kind: 'points', points: json.points.map((point) => pointOf(point)) }
    case 'circle':
      return {
        kind: 'circle',
        centre: json.centre,
        radiusM: json.radius_m,
        clockwise: json.clockwise,
        startBearingDeg: json.start_bearing_deg,
        ...(json.height_m === undefined ? {} : { heightM: json.height_m }),
      }
    case 'grid':
      return {
        kind: 'grid',
        area: json.area,
        lineSpacingM: json.line_spacing_m,
        pointSpacingM: json.point_spacing_m,
        ...(json.angle_deg === undefined ? {} : { angleDeg: json.angle_deg }),
        ...(json.height_m === undefined ? {} : { heightM: json.height_m }),
      }
  }
}

function pointOf(json: z.infer<typeof POINT>): DesignPoint {
  return {
    ...json.position,
    ...(json.height_m === undefined ? {} : { heightM: json.height_m }),
  }
}

/** The console's Baked from a wayline's bake as the schema writes it, refused when it refuses it. */
export function bakedFromJson(raw: unknown): Baked {
  const json = parse(BAKED, raw, 'baked')
  return {
    waypoints: json.waypoints.map((waypoint) => waypointOf(waypoint)),
    distanceM: json.distance_m,
  }
}

/** The console's Flight from a flight as the schema writes it, refused when the schema refuses it. */
export function flightFromJson(raw: unknown): Flight {
  const json = parse(FLIGHT, raw, 'flight')
  return {
    referencePoint: json.reference_point,
    takeoffSecurityHeightM: json.takeoff_security_height_m,
    speedMs: json.speed_ms,
    finishAction: json.finish_action,
    waypoints: json.waypoints.map((waypoint) => waypointOf(waypoint)),
    distanceM: json.distance_m,
    durationS: json.duration_s,
    violations: json.violations.map((violation) => violationOf(violation)),
  }
}

function waypointOf(json: z.infer<typeof BAKED_WAYPOINT>): BakedWaypoint {
  return { index: json.index, ...json.position, heightM: json.height_m }
}

function violationOf(json: z.infer<typeof VIOLATION>): Violation {
  return {
    rule: json.rule,
    message: json.message,
    ...(json.waypoint_index === undefined ? {} : { waypointIndex: json.waypoint_index }),
  }
}

/**
 * Sky Orchestrator's envelope from the object its GET /v1/envelope answers under `envelope`. Its
 * fingerprints and application_in_force are not read: the Envelope holds only the limits.
 */
export function envelopeFromSkyOrchestrator(raw: unknown): Envelope {
  const json = parse(ENVELOPE, raw, 'envelope')
  return {
    geofenceCenter: json.geofence_center,
    geofenceRadiusM: json.geofence_radius_m,
    maxHeightM: json.max_height_m,
    maxHomeDistanceM: json.max_home_distance_m,
    maxLegM: json.max_leg_m,
    maxTransitM: json.max_transit_m,
    maxTotalDistanceM: json.max_total_distance_m,
    maxWaypoints: json.max_waypoints,
    maxHorizontalSpeedMs: json.max_horizontal_speed_ms,
  }
}

/**
 * A design as design.schema.json writes it: every key the schema allows, the optional ones only
 * when they are defined.
 */
export function designToJson(design: Design) {
  return {
    schema_version: SCHEMA_VERSION,
    takeoff: positionToStorage(design.takeoff),
    default_height_m: design.defaultHeightM,
    primitives: design.primitives.map((primitive) => primitiveToJson(primitive)),
  }
}

function primitiveToJson(primitive: Primitive) {
  switch (primitive.kind) {
    case 'route':
      return { kind: 'route', points: primitive.points.map((point) => pointToJson(point)) }
    case 'points':
      return { kind: 'points', points: primitive.points.map((point) => pointToJson(point)) }
    case 'circle':
      return {
        kind: 'circle',
        centre: positionToStorage(primitive.centre),
        radius_m: primitive.radiusM,
        clockwise: primitive.clockwise,
        start_bearing_deg: primitive.startBearingDeg,
        ...(primitive.heightM === undefined ? {} : { height_m: primitive.heightM }),
      }
    case 'grid':
      return {
        kind: 'grid',
        area: primitive.area.map((vertex) => positionToStorage(vertex)),
        line_spacing_m: primitive.lineSpacingM,
        point_spacing_m: primitive.pointSpacingM,
        ...(primitive.angleDeg === undefined ? {} : { angle_deg: primitive.angleDeg }),
        ...(primitive.heightM === undefined ? {} : { height_m: primitive.heightM }),
      }
  }
}

function pointToJson(point: DesignPoint) {
  return {
    position: positionToStorage(point),
    ...(point.heightM === undefined ? {} : { height_m: point.heightM }),
  }
}

/** A wayline's bake as design.schema.json writes it. Writing refuses only a position out of range. */
export function bakedToJson(baked: Baked) {
  return {
    schema_version: SCHEMA_VERSION,
    waypoints: baked.waypoints.map((waypoint) => waypointToJson(waypoint)),
    distance_m: baked.distanceM,
  }
}

/** A flight as design.schema.json writes it. Writing refuses only a position out of range. */
export function flightToJson(flight: Flight) {
  return {
    schema_version: SCHEMA_VERSION,
    takeoff_security_height_m: flight.takeoffSecurityHeightM,
    reference_point: positionToStorage(flight.referencePoint),
    speed_ms: flight.speedMs,
    finish_action: flight.finishAction,
    waypoints: flight.waypoints.map((waypoint) => waypointToJson(waypoint)),
    distance_m: flight.distanceM,
    duration_s: flight.durationS,
    violations: flight.violations.map((violation) => ({
      rule: violation.rule,
      message: violation.message,
      ...(violation.waypointIndex === undefined ? {} : { waypoint_index: violation.waypointIndex }),
    })),
  }
}

function waypointToJson(waypoint: BakedWaypoint) {
  return {
    index: waypoint.index,
    position: positionToStorage(waypoint),
    height_m: waypoint.heightM,
  }
}
