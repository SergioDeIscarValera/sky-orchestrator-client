// @vitest-environment node
import { readFileSync } from 'node:fs'

import { BackendError } from '../backend/backend'
import { positionFromStorage } from '../backend/positions'
import { bake, type BakeSettings } from './bake'
import {
  bakedFromJson,
  bakedToJson,
  designFromJson,
  designToJson,
  envelopeFromSkyOrchestrator,
  envelopeFromStackRead,
  flightFromJson,
  flightToJson,
} from './designJson'
import { planFlight, type FinishAction } from './flight'

/** The golden bakes libs/soc-geo checks, and the two design examples the schema is shown with. */
const VECTORS = new URL('../../../../contracts/geometry/bake.json', import.meta.url)
const ROUTE_EXAMPLE = new URL(
  '../../../../contracts/geometry/examples/design.route.json',
  import.meta.url,
)
const TOOLS_EXAMPLE = new URL(
  '../../../../contracts/geometry/examples/design.tools.json',
  import.meta.url,
)

/** A JSON value as a file holds it. The tests edit copies of these, never the files. */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

interface Vector {
  readonly name: string
  readonly design: Json
  readonly envelope: Json
  /** The wayline's bake; null for a design with nothing drawn. */
  readonly baked: Json
  readonly operation: {
    readonly takeoff_security_height_m: number
    readonly speed_ms: number
    readonly finish_action: FinishAction
  }
  readonly flight: Json
}

interface VectorFile {
  readonly origin: Json
  readonly max_arc_spacing_m: number
  readonly cases: readonly Vector[]
}

interface Example {
  readonly design: Json
  readonly baked: Json
}

const FILE = JSON.parse(readFileSync(VECTORS, 'utf8')) as VectorFile
const ROUTE = JSON.parse(readFileSync(ROUTE_EXAMPLE, 'utf8')) as Example
const TOOLS = JSON.parse(readFileSync(TOOLS_EXAMPLE, 'utf8')) as Example
const ORIGIN = positionFromStorage(FILE.origin)
const NOTHING_DRAWN = 'nothing drawn'
/** The golden cases with a waypoint to fly. The one with none is refused by the schema. */
const DRAWN = FILE.cases.filter((vector) => vector.name !== NOTHING_DRAWN)
const EXAMPLES = [
  { name: 'design.route.json', design: ROUTE.design },
  { name: 'design.tools.json', design: TOOLS.design },
]

function caseNamed(name: string): Vector {
  const found = FILE.cases.find((vector) => vector.name === name)
  if (found === undefined) throw new Error(`no golden case named ${name}`)
  return found
}

const settingsOf = (): BakeSettings => ({ origin: ORIGIN, maxArcSpacingM: FILE.max_arc_spacing_m })

/** The flight a golden case's operation makes of its wayline, against its envelope. */
const flightOf = (vector: Vector) => {
  const design = designFromJson(vector.design)
  return planFlight(design.takeoff, bake(design, settingsOf()), {
    origin: ORIGIN,
    takeoffSecurityHeightM: vector.operation.takeoff_security_height_m,
    speedMs: vector.operation.speed_ms,
    finishAction: vector.operation.finish_action,
    envelope: envelopeFromSkyOrchestrator(vector.envelope),
  })
}

/** A flight the schema accepts: the first golden case's. */
const FLIGHT = (FILE.cases[0] as Vector).flight

/** A design the schema accepts, with every kind of primitive and every optional key in it. */
const DESIGN: { [key: string]: Json } = {
  schema_version: '2.2.0',
  takeoff: [-4.7245, 41.6523],
  default_height_m: 30,
  primitives: [
    {
      kind: 'route',
      points: [
        { position: [-4.7245, 41.65255] },
        { position: [-4.72405, 41.65255] },
        { position: [-4.72405, 41.6523], height_m: 35 },
      ],
    },
    { kind: 'points', points: [{ position: [-4.7243, 41.6523], height_m: 12 }] },
    {
      kind: 'circle',
      centre: [-4.724, 41.6519],
      radius_m: 30,
      clockwise: true,
      start_bearing_deg: 0,
      height_m: 40,
    },
    {
      kind: 'grid',
      area: [
        [-4.725, 41.6515],
        [-4.7244, 41.6515],
        [-4.7244, 41.6512],
      ],
      line_spacing_m: 10,
      point_spacing_m: 15,
      angle_deg: 45,
      height_m: 25,
    },
  ],
}

/** Sky Orchestrator's envelope under its `envelope` key, written from the openapi, which has no example. */
const SKY_ORCHESTRATOR_ENVELOPE: Json = {
  geofence_center: { latitude_deg: 41.6523, longitude_deg: -4.7245 },
  geofence_radius_m: 1000,
  max_height_m: 120,
  max_home_distance_m: 1000,
  max_leg_m: 300,
  max_transit_m: 300,
  max_total_distance_m: 5000,
  max_waypoints: 200,
  max_horizontal_speed_ms: 15,
}

const DESIGN_KEYS = ['schema_version', 'takeoff', 'default_height_m', 'primitives'] as const

const BAKED_KEYS = ['schema_version', 'waypoints', 'distance_m'] as const

const FLIGHT_KEYS = [
  'schema_version',
  'takeoff_security_height_m',
  'reference_point',
  'speed_ms',
  'finish_action',
  'waypoints',
  'distance_m',
  'duration_s',
  'violations',
] as const

const ENVELOPE_KEYS = [
  'geofence_center',
  'geofence_radius_m',
  'max_height_m',
  'max_home_distance_m',
  'max_leg_m',
  'max_transit_m',
  'max_total_distance_m',
  'max_waypoints',
  'max_horizontal_speed_ms',
] as const

/** Takes a key away. */
const MISSING: unique symbol = Symbol('a key taken away')

type Path = readonly (string | number)[]

/** A copy of `document` with the value at `path` replaced; MISSING takes the key away. */
function edit(document: Json, path: Path, value: Json | typeof MISSING): Json {
  const [key, ...rest] = path
  if (key === undefined) {
    if (value === MISSING) throw new Error('a document cannot lose its root')
    return value
  }
  if (typeof key === 'number') {
    if (!Array.isArray(document) || key >= document.length) {
      throw new Error(`no item ${String(key)} to edit`)
    }
    return document.map((item, index) => (index === key ? edit(item, rest, value) : item))
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new Error(`no key ${key} to edit`)
  }
  // MISSING removes only the key the path ends at; the keys above it stay.
  if (rest.length === 0 && value === MISSING) {
    return Object.fromEntries(Object.entries(document).filter(([name]) => name !== key))
  }
  return { ...document, [key]: edit(document[key] ?? null, rest, value) }
}

/** A message that names `path`: it opens with it, or follows another refusal in the same message. */
const naming = (path: string) => new RegExp(`(^|; )${path.replace(/[.[\]]/g, '\\$&')}: `)

/** The message of the Error a read throws; a read that succeeds fails the test. */
function refusalOf(read: () => unknown): string {
  try {
    read()
  } catch (error) {
    if (error instanceof Error) return error.message
    throw error
  }
  throw new Error('the read was not refused')
}

type Document = 'design' | 'baked' | 'flight' | 'envelope'

/** An edit of a valid document, which the reader must refuse with a message naming `names`. */
interface Refusal {
  readonly title: string
  readonly path: Path
  readonly value: Json | typeof MISSING
  readonly names: string
  /** A phrase the message must carry as well, when the rule has one to name. */
  readonly says?: string
}

/** A refusal, with the document it edits. */
interface Case extends Refusal {
  readonly document: Document
}

/** Each document's valid base, and the reader that must refuse an edit of it. */
const DOCUMENTS: {
  readonly [name in Document]: { readonly base: Json; readonly read: (raw: unknown) => unknown }
} = {
  design: { base: DESIGN, read: (raw) => designFromJson(raw) },
  baked: { base: ROUTE.baked, read: (raw) => bakedFromJson(raw) },
  flight: { base: FLIGHT, read: (raw) => flightFromJson(raw) },
  envelope: { base: SKY_ORCHESTRATOR_ENVELOPE, read: (raw) => envelopeFromSkyOrchestrator(raw) },
}

/** Tags each refusal with its document, so one table holds a rule for all three. */
const of = (document: Document, rows: readonly Refusal[]): Case[] =>
  rows.map((row) => ({ ...row, document }))

// Rule 1: a key the schema requires is never filled in with a default.
const MISSING_KEY: readonly Case[] = [
  ...of('design', [
    ...DESIGN_KEYS.map((key): Refusal => ({
      title: key,
      path: [key],
      value: MISSING,
      names: `design.${key}`,
    })),
    {
      title: "a route point's position",
      path: ['primitives', 0, 'points', 0, 'position'],
      value: MISSING,
      names: 'design.primitives[0].points[0].position',
    },
    {
      title: "a primitive's kind",
      path: ['primitives', 1, 'kind'],
      value: MISSING,
      names: 'design.primitives[1].kind',
    },
    {
      title: "a circle's centre",
      path: ['primitives', 2, 'centre'],
      value: MISSING,
      names: 'design.primitives[2].centre',
    },
    {
      title: "a circle's clockwise",
      path: ['primitives', 2, 'clockwise'],
      value: MISSING,
      names: 'design.primitives[2].clockwise',
    },
    {
      title: "a grid's area",
      path: ['primitives', 3, 'area'],
      value: MISSING,
      names: 'design.primitives[3].area',
    },
    {
      title: "a grid's line spacing",
      path: ['primitives', 3, 'line_spacing_m'],
      value: MISSING,
      names: 'design.primitives[3].line_spacing_m',
    },
    {
      title: "a route's points",
      path: ['primitives', 0, 'points'],
      value: MISSING,
      names: 'design.primitives[0].points',
    },
  ]),
  ...of(
    'baked',
    BAKED_KEYS.map((key): Refusal => ({
      title: key,
      path: [key],
      value: MISSING,
      names: `baked.${key}`,
    })),
  ),
  ...of('flight', [
    ...FLIGHT_KEYS.map((key): Refusal => ({
      title: key,
      path: [key],
      value: MISSING,
      names: `flight.${key}`,
    })),
    {
      title: "a violation's message",
      path: ['violations'],
      value: [{ rule: 'no_waypoints' }],
      names: 'flight.violations[0].message',
    },
  ]),
  ...of(
    'envelope',
    ENVELOPE_KEYS.map((key): Refusal => ({
      title: key,
      path: [key],
      value: MISSING,
      names: `envelope.${key}`,
    })),
  ),
]

// Rule 2: a value of the wrong kind is refused, whatever the key.
const WRONG_KIND: readonly Case[] = [
  ...of('design', [
    { title: 'schema_version', path: ['schema_version'], value: 1, names: 'design.schema_version' },
    {
      title: 'default_height_m',
      path: ['default_height_m'],
      value: '30',
      names: 'design.default_height_m',
    },
    { title: 'primitives', path: ['primitives'], value: {}, names: 'design.primitives' },
    { title: 'a primitive', path: ['primitives', 0], value: null, names: 'design.primitives[0]' },
    {
      title: 'points',
      path: ['primitives', 0, 'points'],
      value: 'route',
      names: 'design.primitives[0].points',
    },
    {
      title: 'a point height',
      path: ['primitives', 0, 'points', 2, 'height_m'],
      value: '35',
      names: 'design.primitives[0].points[2].height_m',
    },
    {
      title: 'clockwise',
      path: ['primitives', 2, 'clockwise'],
      value: 'yes',
      names: 'design.primitives[2].clockwise',
    },
    {
      title: 'a primitive kind the schema does not know',
      path: ['primitives', 1, 'kind'],
      value: 'arc',
      names: 'design.primitives[1].kind',
    },
    {
      title: 'a grid angle',
      path: ['primitives', 3, 'angle_deg'],
      value: '45',
      names: 'design.primitives[3].angle_deg',
    },
  ]),
  ...of('flight', [
    { title: 'schema_version', path: ['schema_version'], value: 1, names: 'flight.schema_version' },
    {
      title: 'takeoff_security_height_m',
      path: ['takeoff_security_height_m'],
      value: '20',
      names: 'flight.takeoff_security_height_m',
    },
    { title: 'speed_ms', path: ['speed_ms'], value: null, names: 'flight.speed_ms' },
    { title: 'waypoints', path: ['waypoints'], value: 'x', names: 'flight.waypoints' },
    {
      title: 'a waypoint index',
      path: ['waypoints', 0, 'index'],
      value: '0',
      names: 'flight.waypoints[0].index',
    },
    {
      title: 'a waypoint height',
      path: ['waypoints', 0, 'height_m'],
      value: '30',
      names: 'flight.waypoints[0].height_m',
    },
    { title: 'violations', path: ['violations'], value: {}, names: 'flight.violations' },
  ]),
  ...of('envelope', [
    {
      title: 'geofence_radius_m',
      path: ['geofence_radius_m'],
      value: '1000',
      names: 'envelope.geofence_radius_m',
    },
    {
      title: 'max_waypoints',
      path: ['max_waypoints'],
      value: '200',
      names: 'envelope.max_waypoints',
    },
    {
      title: 'a centre latitude',
      path: ['geofence_center', 'latitude_deg'],
      value: '41.6523',
      names: 'envelope.geofence_center.latitude_deg',
    },
  ]),
]

// Rule 3: a position is two finite numbers in range, longitude first (GeoJSON order).
const POSITION: readonly Case[] = [
  ...of('design', [
    {
      title: 'a takeoff that is text',
      path: ['takeoff'],
      value: '-4.7245,41.6523',
      names: 'design.takeoff',
    },
    {
      title: 'a takeoff with a NaN longitude',
      path: ['takeoff'],
      value: [Number.NaN, 41.6523],
      names: 'design.takeoff',
    },
    {
      title: 'a takeoff with an infinite latitude',
      path: ['takeoff'],
      value: [-4.7245, Number.POSITIVE_INFINITY],
      names: 'design.takeoff',
    },
    {
      title: 'a takeoff with an infinite longitude',
      path: ['takeoff'],
      value: [Number.NEGATIVE_INFINITY, 41.6523],
      names: 'design.takeoff',
    },
    {
      title: 'a takeoff longitude past 180',
      path: ['takeoff'],
      value: [180.5, 41.6523],
      names: 'design.takeoff',
    },
    {
      title: 'a takeoff latitude past 90',
      path: ['takeoff'],
      value: [-4.7245, 90.5],
      names: 'design.takeoff',
    },
    {
      title: 'a takeoff longitude below -180',
      path: ['takeoff'],
      value: [-180.5, 0],
      names: 'design.takeoff',
    },
    {
      title: 'a takeoff latitude below -90',
      path: ['takeoff'],
      value: [0, -90.5],
      names: 'design.takeoff',
    },
    {
      title: 'a takeoff of one number',
      path: ['takeoff'],
      value: [-4.7245],
      names: 'design.takeoff',
    },
    {
      title: 'a takeoff of three numbers',
      path: ['takeoff'],
      value: [-4.7245, 41.6523, 0],
      names: 'design.takeoff',
    },
    {
      title: 'a takeoff of two numbers as text',
      path: ['takeoff'],
      value: ['-4.7245', '41.6523'],
      names: 'design.takeoff',
    },
    {
      title: 'a takeoff with a null longitude',
      path: ['takeoff'],
      value: [null, 41.6523],
      names: 'design.takeoff',
    },
    { title: 'an empty takeoff', path: ['takeoff'], value: [], names: 'design.takeoff' },
    {
      title: 'a takeoff as an object',
      path: ['takeoff'],
      value: { longitude: -4.7245, latitude: 41.6523 },
      names: 'design.takeoff',
    },
    {
      title: 'a route point with a NaN latitude',
      path: ['primitives', 0, 'points', 1, 'position'],
      value: [-4.72405, Number.NaN],
      names: 'design.primitives[0].points[1].position',
    },
    {
      title: 'a circle centre with a latitude past 90',
      path: ['primitives', 2, 'centre'],
      value: [-4.724, 91],
      names: 'design.primitives[2].centre',
    },
    {
      title: 'a grid vertex that is text',
      path: ['primitives', 3, 'area', 2],
      value: [-4.7244, 'x'],
      names: 'design.primitives[3].area[2]',
    },
  ]),
  ...of('flight', [
    {
      title: 'a reference point of three numbers',
      path: ['reference_point'],
      value: [-4.7245, 41.6523, 0],
      names: 'flight.reference_point',
    },
    {
      title: 'a waypoint latitude past 90',
      path: ['waypoints', 0, 'position'],
      value: [-4.7245, 91],
      names: 'flight.waypoints[0].position',
    },
  ]),
  ...of('envelope', [
    {
      title: 'a centre in SOC storage order, longitude first',
      path: ['geofence_center'],
      value: [-4.7245, 41.6523],
      names: 'envelope.geofence_center',
    },
    {
      title: 'a centre latitude past 90',
      path: ['geofence_center', 'latitude_deg'],
      value: 91,
      names: 'envelope.geofence_center',
    },
    {
      title: 'a centre longitude past 180',
      path: ['geofence_center', 'longitude_deg'],
      value: 181,
      names: 'envelope.geofence_center',
    },
  ]),
]

// Rule 4: a height, a radius, a spacing or a speed is above zero (ADR-0014).
const HEIGHT: readonly Case[] = [
  ...of('design', [
    {
      title: 'a default height of zero',
      path: ['default_height_m'],
      value: 0,
      names: 'design.default_height_m',
    },
    {
      title: 'a default height below zero',
      path: ['default_height_m'],
      value: -5,
      names: 'design.default_height_m',
    },
    {
      title: 'a point height of zero',
      path: ['primitives', 0, 'points', 2, 'height_m'],
      value: 0,
      names: 'design.primitives[0].points[2].height_m',
    },
    {
      title: 'a point height below zero',
      path: ['primitives', 1, 'points', 0, 'height_m'],
      value: -1,
      names: 'design.primitives[1].points[0].height_m',
    },
    {
      title: 'a circle height of zero',
      path: ['primitives', 2, 'height_m'],
      value: 0,
      names: 'design.primitives[2].height_m',
    },
    {
      title: 'a grid height below zero',
      path: ['primitives', 3, 'height_m'],
      value: -1,
      names: 'design.primitives[3].height_m',
    },
    {
      title: 'a circle radius of zero',
      path: ['primitives', 2, 'radius_m'],
      value: 0,
      names: 'design.primitives[2].radius_m',
    },
    {
      title: 'a grid line spacing of zero',
      path: ['primitives', 3, 'line_spacing_m'],
      value: 0,
      names: 'design.primitives[3].line_spacing_m',
    },
    {
      title: 'a grid point spacing of zero',
      path: ['primitives', 3, 'point_spacing_m'],
      value: 0,
      names: 'design.primitives[3].point_spacing_m',
    },
  ]),
  ...of('flight', [
    {
      title: 'a waypoint height of zero',
      path: ['waypoints', 0, 'height_m'],
      value: 0,
      names: 'flight.waypoints[0].height_m',
    },
    {
      title: 'a takeoff security height of zero',
      path: ['takeoff_security_height_m'],
      value: 0,
      names: 'flight.takeoff_security_height_m',
    },
    { title: 'a speed of zero', path: ['speed_ms'], value: 0, names: 'flight.speed_ms' },
  ]),
  ...of('envelope', [
    {
      title: 'a geofence radius of zero',
      path: ['geofence_radius_m'],
      value: 0,
      names: 'envelope.geofence_radius_m',
    },
    {
      title: 'a maximum height of zero',
      path: ['max_height_m'],
      value: 0,
      names: 'envelope.max_height_m',
    },
    {
      title: 'a maximum home distance below zero',
      path: ['max_home_distance_m'],
      value: -1,
      names: 'envelope.max_home_distance_m',
    },
    { title: 'a maximum leg of zero', path: ['max_leg_m'], value: 0, names: 'envelope.max_leg_m' },
    {
      title: 'a maximum transit of zero',
      path: ['max_transit_m'],
      value: 0,
      names: 'envelope.max_transit_m',
    },
    {
      title: 'a maximum total distance of zero',
      path: ['max_total_distance_m'],
      value: 0,
      names: 'envelope.max_total_distance_m',
    },
    {
      title: 'a maximum speed of zero',
      path: ['max_horizontal_speed_ms'],
      value: 0,
      names: 'envelope.max_horizontal_speed_ms',
    },
  ]),
]

// The other rules of the schema: versions, enums, counts, ranges, and the keys it does not allow.
const OTHER: readonly Case[] = [
  ...of('design', [
    {
      title: 'a schema_version of another major version',
      path: ['schema_version'],
      value: '1.0.0',
      names: 'design.schema_version',
    },
    {
      title: 'a schema_version with two parts',
      path: ['schema_version'],
      value: '1.0',
      names: 'design.schema_version',
    },
    {
      title: 'a schema_version with a v prefix',
      path: ['schema_version'],
      value: 'v1.0.0',
      names: 'design.schema_version',
    },
    {
      title: 'a route of one point',
      path: ['primitives', 0, 'points'],
      value: [{ position: [-4.7245, 41.65255] }],
      names: 'design.primitives[0].points',
    },
    {
      title: 'a points primitive with none',
      path: ['primitives', 1, 'points'],
      value: [],
      names: 'design.primitives[1].points',
    },
    {
      title: 'a grid area of two vertices',
      path: ['primitives', 3, 'area'],
      value: [
        [-4.725, 41.6515],
        [-4.7244, 41.6515],
      ],
      names: 'design.primitives[3].area',
    },
    {
      title: 'a circle start bearing of 360',
      path: ['primitives', 2, 'start_bearing_deg'],
      value: 360,
      names: 'design.primitives[2].start_bearing_deg',
    },
    {
      title: 'a circle start bearing below zero',
      path: ['primitives', 2, 'start_bearing_deg'],
      value: -1,
      names: 'design.primitives[2].start_bearing_deg',
    },
    {
      title: 'a grid angle of 180',
      path: ['primitives', 3, 'angle_deg'],
      value: 180,
      names: 'design.primitives[3].angle_deg',
    },
    {
      title: 'a key the schema does not allow on the design',
      path: ['colour'],
      value: 'red',
      names: 'design',
      says: 'Unrecognized key',
    },
    {
      title: 'a key the schema does not allow on a point',
      path: ['primitives', 0, 'points', 0, 'colour'],
      value: 'red',
      names: 'design.primitives[0].points[0]',
      says: 'Unrecognized key',
    },
    {
      title: 'a point with actions, which the schema reserves',
      path: ['primitives', 0, 'points', 0, 'actions'],
      value: [],
      names: 'design.primitives[0].points[0].actions',
      says: 'FR-WAY-12',
    },
    { title: 'a design that is an array', path: [], value: [], names: 'design' },
    { title: 'a design that is null', path: [], value: null, names: 'design' },
    { title: 'a design that is text', path: [], value: 'design', names: 'design' },
  ]),
  ...of('flight', [
    {
      title: 'a bake with no waypoint, as nothing drawn gives: never a plan',
      path: ['waypoints'],
      value: [],
      names: 'flight.waypoints',
    },
    {
      title: 'a bake of 201 waypoints',
      path: ['waypoints'],
      value: Array.from({ length: 201 }, (_, index) => ({
        index,
        position: [-4.7245, 41.6523],
        height_m: 30,
      })),
      names: 'flight.waypoints',
    },
    {
      title: 'a violation rule in capitals',
      path: ['violations'],
      value: [{ rule: 'NoWaypoints', message: 'nothing is drawn to fly' }],
      names: 'flight.violations[0].rule',
    },
    {
      title: 'a violation waypoint index below zero',
      path: ['violations'],
      value: [{ rule: 'height_above_max', message: 'x', waypoint_index: -1 }],
      names: 'flight.violations[0].waypoint_index',
    },
    {
      title: 'a waypoint index below zero',
      path: ['waypoints', 0, 'index'],
      value: -1,
      names: 'flight.waypoints[0].index',
    },
    {
      title: 'a waypoint index that is not whole',
      path: ['waypoints', 1, 'index'],
      value: 1.5,
      names: 'flight.waypoints[1].index',
    },
    {
      title: 'a waypoint with its own speed, which a wayline does not have',
      path: ['waypoints', 0, 'speed_ms'],
      value: 3,
      names: 'flight.waypoints[0].speed_ms',
      says: 'FR-WAY-10',
    },
    {
      title: 'a waypoint with actions, which the schema reserves',
      path: ['waypoints', 0, 'actions'],
      value: [],
      names: 'flight.waypoints[0].actions',
      says: 'FR-WAY-12',
    },
    { title: 'a distance below zero', path: ['distance_m'], value: -1, names: 'flight.distance_m' },
    {
      title: 'a duration below zero',
      path: ['duration_s'],
      value: -0.5,
      names: 'flight.duration_s',
    },
    {
      title: 'a takeoff security height past 120',
      path: ['takeoff_security_height_m'],
      value: 121,
      names: 'flight.takeoff_security_height_m',
    },
    {
      title: 'a finish action the schema does not know',
      path: ['finish_action'],
      value: 'land2',
      names: 'flight.finish_action',
    },
    {
      title: 'a schema_version of another major version',
      path: ['schema_version'],
      value: '1.0.0',
      names: 'flight.schema_version',
    },
    {
      title: 'a key the schema does not allow',
      path: ['extra'],
      value: 1,
      names: 'flight',
      says: 'Unrecognized key',
    },
    { title: 'a flight that is an array', path: [], value: [], names: 'flight' },
  ]),
  ...of('baked', [
    {
      title: 'a schema_version of another major version',
      path: ['schema_version'],
      value: '1.0.0',
      names: 'baked.schema_version',
    },
    {
      title: "a flight's key, which a wayline's bake does not have",
      path: ['speed_ms'],
      value: 5,
      names: 'baked',
      says: 'Unrecognized key',
    },
    { title: 'no waypoint', path: ['waypoints'], value: [], names: 'baked.waypoints' },
    {
      title: 'a waypoint of no height',
      path: ['waypoints', 0, 'height_m'],
      value: 0,
      names: 'baked.waypoints[0].height_m',
    },
    { title: 'a negative distance', path: ['distance_m'], value: -1, names: 'baked.distance_m' },
    { title: 'a bake that is an array', path: [], value: [], names: 'baked' },
  ]),
  ...of('envelope', [
    {
      title: 'a maximum of zero waypoints',
      path: ['max_waypoints'],
      value: 0,
      names: 'envelope.max_waypoints',
    },
    {
      title: 'a maximum of 1.5 waypoints',
      path: ['max_waypoints'],
      value: 1.5,
      names: 'envelope.max_waypoints',
    },
    {
      title: 'a centre with an altitude',
      path: ['geofence_center', 'altitude_m'],
      value: 0,
      names: 'envelope.geofence_center',
      says: 'Unrecognized key',
    },
    {
      title: 'a limit SO keeps in its configuration but not in the envelope',
      path: ['max_vertical_speed_ms'],
      value: 2,
      names: 'envelope',
      says: 'Unrecognized key',
    },
    {
      title: 'the whole response rather than its envelope object',
      path: [],
      value: { envelope: SKY_ORCHESTRATOR_ENVELOPE, config_fingerprint: 'a'.repeat(64) },
      names: 'envelope',
      says: 'Unrecognized key',
    },
  ]),
]

/** The row's edit of its document is refused, and the refusal names the row's path. */
function expectRefused(row: Case): void {
  const { base, read } = DOCUMENTS[row.document]
  const message = refusalOf(() => read(edit(base, row.path, row.value)))
  expect(message).toMatch(naming(row.names))
  if (row.says !== undefined) expect(message).toContain(row.says)
}

describe('a design as design.schema.json writes it (FR-WAY-09)', () => {
  it.each(FILE.cases)('writes the design of $name key for key as the file has it', (vector) => {
    expect(designToJson(designFromJson(vector.design))).toStrictEqual(vector.design)
  })

  it.each(FILE.cases)('reads the design of $name back to the same Design', (vector) => {
    const design = designFromJson(vector.design)
    expect(designFromJson(designToJson(design))).toStrictEqual(design)
  })

  it.each(EXAMPLES)('writes the $name example key for key and reads it back', ({ design }) => {
    const parsed = designFromJson(design)
    expect(designToJson(parsed)).toStrictEqual(design)
    expect(designFromJson(designToJson(parsed))).toStrictEqual(parsed)
  })

  it('carries every optional key when it is given: an angle, and heights on each kind', () => {
    expect(designToJson(designFromJson(DESIGN))).toStrictEqual(DESIGN)
  })

  it('reads a position longitude first, as the stored pair is', () => {
    expect(designFromJson(DESIGN).takeoff).toStrictEqual({
      latitudeDeg: 41.6523,
      longitudeDeg: -4.7245,
    })
  })

  it('reads a document at any 2.x.y, which it writes back as 2.0.0, and refuses a 1.x.y', () => {
    expect(designFromJson({ ...DESIGN, schema_version: '2.4.2' })).toStrictEqual(
      designFromJson(DESIGN),
    )
    expect(refusalOf(() => designFromJson({ ...DESIGN, schema_version: '1.0.0' }))).toMatch(
      naming('design.schema_version'),
    )
  })

  it("refuses the flight fields a design no longer has: they are the operation's (M4)", () => {
    for (const [key, value] of [
      ['speed_ms', 5],
      ['takeoff_security_height_m', 20],
      ['finish_action', 'return_home'],
    ] as const) {
      expect(refusalOf(() => designFromJson({ ...DESIGN, [key]: value }))).toMatch(/design/)
    }
  })

  it('reads the limits of every range the schema allows', () => {
    const design = designFromJson({
      ...DESIGN,
      takeoff: [180, -90],
      primitives: [
        {
          kind: 'circle',
          centre: [-180, 90],
          radius_m: 0.001,
          clockwise: false,
          start_bearing_deg: 0,
        },
        {
          kind: 'grid',
          area: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
          line_spacing_m: 0.001,
          point_spacing_m: 0.001,
          angle_deg: 0,
        },
      ],
    })
    expect(design.takeoff).toStrictEqual({ latitudeDeg: -90, longitudeDeg: 180 })
    expect(designFromJson(designToJson(design))).toStrictEqual(design)
  })

  it('reads a design with nothing drawn, which the schema allows', () => {
    const design = designFromJson({ ...DESIGN, primitives: [] })
    expect(design.primitives).toStrictEqual([])
    expect(designToJson(design).primitives).toStrictEqual([])
  })

  it('refuses to write a takeoff out of range, as positions.ts does', () => {
    const design = designFromJson(DESIGN)
    const outOfRange = { ...design, takeoff: { latitudeDeg: 91, longitudeDeg: 0 } }
    expect(() => designToJson(outOfRange)).toThrow(BackendError)
    expect(() => designToJson(outOfRange)).toThrow(/cannot write a position/)
  })
})

describe("a wayline's bake as design.schema.json writes it (FR-WAY-07, FR-WAY-09)", () => {
  it.each(DRAWN)('writes the bake of $name key for key as the file has it', (vector) => {
    const baked = bake(designFromJson(vector.design), settingsOf())
    expect(bakedToJson(baked)).toStrictEqual(vector.baked)
  })

  it.each(DRAWN)('reads the bake of $name back as saved, and writes it again', (vector) => {
    const baked = bakedFromJson(vector.baked)
    expect(bakedToJson(baked)).toStrictEqual(vector.baked)
    expect(bakedFromJson(bakedToJson(baked))).toStrictEqual(baked)
  })

  it('keeps no bake for nothing drawn: a wayline needs a waypoint, so the schema does', () => {
    expect(caseNamed(NOTHING_DRAWN).baked).toBeNull()
    const nothing = bakedToJson(bake(designFromJson(caseNamed(NOTHING_DRAWN).design), settingsOf()))
    expect(refusalOf(() => bakedFromJson(nothing))).toMatch(naming('baked.waypoints'))
  })

  it('reads the route example bake back as saved', () => {
    const baked = bakedFromJson(ROUTE.baked)
    expect(bakedToJson(baked)).toStrictEqual(ROUTE.baked)
    expect(bakedFromJson(bakedToJson(baked))).toStrictEqual(baked)
  })

  it('reads the tools example, whose bake is null until it is baked, as a design only', () => {
    expect(TOOLS.baked).toBeNull()
    expect(refusalOf(() => bakedFromJson(TOOLS.baked))).toMatch(naming('baked'))
  })
})

describe('a flight as design.schema.json writes it (FR-WAY-08, FR-WAY-11)', () => {
  it.each(FILE.cases)('writes the flight of $name key for key as the file has it', (vector) => {
    expect(flightToJson(flightOf(vector))).toStrictEqual(vector.flight)
  })

  it.each(DRAWN)('reads the flight of $name back, and writes it again', (vector) => {
    const flight = flightFromJson(vector.flight)
    expect(flightToJson(flight)).toStrictEqual(vector.flight)
    expect(flightFromJson(flightToJson(flight))).toStrictEqual(flight)
  })

  it('refuses the flight of nothing drawn: a plan needs a waypoint, so the schema does', () => {
    const message = refusalOf(() => flightFromJson(caseNamed(NOTHING_DRAWN).flight))
    expect(message).toMatch(naming('flight.waypoints'))
  })
})

describe("Sky Orchestrator's envelope (FR-WAY-11)", () => {
  it('reads the envelope the openapi describes, its centre in the API order', () => {
    expect(envelopeFromSkyOrchestrator(SKY_ORCHESTRATOR_ENVELOPE)).toStrictEqual({
      geofenceCenter: { latitudeDeg: 41.6523, longitudeDeg: -4.7245 },
      geofenceRadiusM: 1000,
      maxHeightM: 120,
      maxHomeDistanceM: 1000,
      maxLegM: 300,
      maxTransitM: 300,
      maxTotalDistanceM: 5000,
      maxWaypoints: 200,
      maxHorizontalSpeedMs: 15,
    })
  })

  it.each(FILE.cases)('reads the envelope of $name', (vector) => {
    expect(() => envelopeFromSkyOrchestrator(vector.envelope)).not.toThrow()
  })

  /** A whole answer of GET /v1/envelope (the openapi's EnvelopeRead), as soc.stacks holds it. */
  const READ = {
    envelope: SKY_ORCHESTRATOR_ENVELOPE,
    envelope_fingerprint: 'e'.repeat(64),
    config_fingerprint: 'c'.repeat(64),
    application_in_force: null,
  }

  it('reads the limits from a whole answer of GET /v1/envelope, as a stack records it', () => {
    expect(envelopeFromStackRead(READ)).toStrictEqual(
      envelopeFromSkyOrchestrator(SKY_ORCHESTRATOR_ENVELOPE),
    )
  })

  it('refuses the limits alone as a stack read, naming what is missing', () => {
    expect(() => envelopeFromStackRead(SKY_ORCHESTRATOR_ENVELOPE)).toThrow(
      /envelope read\.envelope_fingerprint/,
    )
    expect(() => envelopeFromStackRead({ ...READ, envelope: undefined })).toThrow(/^envelope: /)
  })
})

describe('the schema refuses what it refuses, and the message names the path of the refusal', () => {
  it.each(MISSING_KEY)('refuses a missing key in $document: $title', (row) => {
    expectRefused(row)
  })

  it.each(WRONG_KIND)('refuses a value of the wrong kind in $document: $title', (row) => {
    expectRefused(row)
  })

  it.each(POSITION)(
    'refuses a position that is not two finite numbers in range, in $document: $title',
    (row) => {
      expectRefused(row)
    },
  )

  it.each(HEIGHT)(
    'refuses a height, radius, spacing or speed not above zero, in $document: $title',
    (row) => {
      expectRefused(row)
    },
  )

  it.each(OTHER)('refuses what else the schema refuses, in $document: $title', (row) => {
    expectRefused(row)
  })
})
