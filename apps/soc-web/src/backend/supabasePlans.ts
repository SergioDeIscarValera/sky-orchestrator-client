import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'

import { z } from '../schema'
import {
  BackendError,
  FieldRefusedError,
  type Geofence,
  type GeofenceChanges,
  type GeofenceDraft,
  type RefusedField,
  type Wayline,
  type WaylineChanges,
  type WaylineDraft,
  type WaylineMetrics,
  type Waypoint,
} from './backend'
import { positionFromStorage, positionToStorage } from './positions'
import { rows } from './rows'

/** The two kinds of plan the console keeps. */
export type PlanKind = 'geofence' | 'wayline'

/** A numeric column arrives as a number, or as its text, as the catalogue's do. */
const numeric = z.union([z.number(), z.string().check(z.regex(/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/))])

// A position is read by positionFromStorage, the one conversion, so the rows keep it as it came.
const GEOFENCE_ROW = z.object({
  id: z.uuid(),
  name: z.string(),
  polygon: z.array(z.unknown()).check(z.minLength(3)),
  max_height_m: numeric,
  origin: z.enum(['drawn', 'generated']),
  margin_m: z.nullable(numeric),
  created_at: z.string(),
  updated_at: z.string(),
})

const WAYPOINT_ROW = z.object({
  index: z.number(),
  position: z.unknown(),
  height_m: numeric,
})

const WAYLINE_ROW = z.object({
  id: z.uuid(),
  name: z.string(),
  takeoff: z.unknown(),
  default_height_m: numeric,
  design: z.record(z.string(), z.unknown()),
  waypoints: z.array(WAYPOINT_ROW).check(z.minLength(1)),
  metrics: z.object({ waypoint_count: z.number(), distance_m: numeric }),
  bake_version: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
})

/**
 * What each of the database's constraints means to the person filling the form (FR-GEO-04,
 * FR-WAY-06, FR-WAY-09). The fake backend refuses through this same table, so the two agree.
 */
const REFUSALS = {
  geofence_name_given: { field: 'name', message: 'A geofence needs a name.' },
  geofence_polygon_ring: {
    field: 'polygon',
    message:
      'A geofence needs a polygon of at least three positions, its last not repeating its first.',
  },
  geofence_max_height_positive: {
    field: 'maxHeightM',
    message: "A geofence's maximum height must be above zero.",
  },
  geofence_margin_when_generated: {
    field: 'marginM',
    message: 'A generated geofence has a margin from 5 to 100 m; a drawn one has none.',
  },
  wayline_name_given: { field: 'name', message: 'A wayline needs a name.' },
  wayline_takeoff_position: {
    field: 'takeoff',
    message: 'The takeoff point needs a longitude and a latitude in range.',
  },
  wayline_default_height_positive: {
    field: 'defaultHeightM',
    message: "A wayline's default height must be above zero.",
  },
  wayline_design_object: { field: 'design', message: 'The design must be an object.' },
  wayline_waypoints_baked: {
    field: 'waypoints',
    message: 'A wayline needs baked waypoints, each with a position and a height above zero.',
  },
  wayline_metrics_object: {
    field: 'metrics',
    message: 'The metrics of the bake need a waypoint count and a distance, as numbers.',
  },
  wayline_bake_version_given: {
    field: 'bakeVersion',
    message: 'A wayline needs the version of the bake that produced it.',
  },
} as const satisfies Readonly<
  Record<string, { readonly field: RefusedField; readonly message: string }>
>

export type PlanConstraint = keyof typeof REFUSALS

const CHECK_VIOLATION = '23514'
const NOT_ALLOWED = '42501'

function isPlanConstraint(name: string): name is PlanConstraint {
  return Object.hasOwn(REFUSALS, name)
}

/** The refusal a named constraint stands for: its field, and the plain message for it. */
export function refusedBy(
  constraint: PlanConstraint,
  code: string | null = CHECK_VIOLATION,
): FieldRefusedError {
  const { field, message } = REFUSALS[constraint]
  return new FieldRefusedError(message, field, code)
}

/** A viewer's insert: row security refuses it with 42501 and names no field. */
export function notAllowedRefusal(kind: PlanKind): FieldRefusedError {
  return new FieldRefusedError(`Only editors and owners change ${kind}s.`, null, NOT_ALLOWED)
}

/** A change or a retirement of a retired row: the trigger refuses it, and names no field. */
export function retiredRefusal(
  kind: PlanKind,
  code: string | null = CHECK_VIOLATION,
): FieldRefusedError {
  return new FieldRefusedError(`A retired ${kind} does not change.`, null, code)
}

/**
 * Row security hides a plan from a viewer's update instead of refusing it, so a write that
 * returns no row changed nothing: the plan is not the organization's, or the role only reads.
 */
export function untouched(kind: PlanKind): FieldRefusedError {
  return new FieldRefusedError(
    `Nothing changed: this ${kind} is not one your role in this organization can change.`,
    null,
  )
}

/** The refusal a database error means for a plan; any other error passes on unchanged. */
export function refusal(error: PostgrestError, kind: PlanKind): BackendError {
  const constraint = /constraint "([^"]+)"/.exec(error.message)?.[1]
  if (constraint !== undefined && isPlanConstraint(constraint)) {
    return refusedBy(constraint, error.code)
  }
  if (error.code === NOT_ALLOWED) return notAllowedRefusal(kind)
  if (error.message.includes(`a retired ${kind} does not change`)) {
    return retiredRefusal(kind, error.code)
  }
  return new BackendError(error.message, error.code)
}

function geofenceOf(row: z.infer<typeof GEOFENCE_ROW>): Geofence {
  return {
    id: row.id,
    name: row.name,
    polygon: row.polygon.map((position) => positionFromStorage(position)),
    maxHeightM: Number(row.max_height_m),
    origin: row.origin,
    marginM: row.margin_m === null ? null : Number(row.margin_m),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function waypointOf(row: z.infer<typeof WAYPOINT_ROW>): Waypoint {
  return {
    index: row.index,
    position: positionFromStorage(row.position),
    heightM: Number(row.height_m),
  }
}

function waylineOf(row: z.infer<typeof WAYLINE_ROW>): Wayline {
  return {
    id: row.id,
    name: row.name,
    takeoff: positionFromStorage(row.takeoff),
    defaultHeightM: Number(row.default_height_m),
    design: row.design,
    waypoints: row.waypoints.map((waypoint) => waypointOf(waypoint)),
    metrics: {
      waypointCount: row.metrics.waypoint_count,
      distanceM: Number(row.metrics.distance_m),
    },
    bakeVersion: row.bake_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** The columns a change gives: a field left out is not written, and a `null` is (margin_m). */
function givenColumns(columns: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined))
}

function geofenceColumns(changes: GeofenceChanges): Record<string, unknown> {
  return givenColumns({
    name: changes.name,
    polygon: changes.polygon?.map((position) => positionToStorage(position)),
    max_height_m: changes.maxHeightM,
    origin: changes.origin,
    margin_m: changes.marginM,
  })
}

function waypointColumns(waypoint: Waypoint): Record<string, unknown> {
  return givenColumns({
    index: waypoint.index,
    position: positionToStorage(waypoint.position),
    height_m: waypoint.heightM,
  })
}

function metricsColumns(metrics: WaylineMetrics): Record<string, unknown> {
  return {
    waypoint_count: metrics.waypointCount,
    distance_m: metrics.distanceM,
  }
}

function waylineColumns(changes: WaylineChanges): Record<string, unknown> {
  return givenColumns({
    name: changes.name,
    takeoff: changes.takeoff === undefined ? undefined : positionToStorage(changes.takeoff),
    default_height_m: changes.defaultHeightM,
    design: changes.design,
    waypoints: changes.waypoints?.map((waypoint) => waypointColumns(waypoint)),
    metrics: changes.metrics === undefined ? undefined : metricsColumns(changes.metrics),
    bake_version: changes.bakeVersion,
  })
}

/** Geofences and waylines through PostgREST, in schema soc, as the fleets are (IR-GEO, IR-WAY). */
export function planOperations(client: SupabaseClient) {
  const soc = () => client.schema('soc')

  return {
    async geofences(organizationId: string): Promise<Geofence[]> {
      const { data, error } = await soc()
        .from('geofences')
        .select('*')
        .eq('organization_id', organizationId)
        .is('deleted_at', null)
        .order('name')
      if (error !== null) throw new BackendError(error.message, error.code)
      return rows(GEOFENCE_ROW, data, 'geofences').map((row) => geofenceOf(row))
    },

    async createGeofence(organizationId: string, draft: GeofenceDraft): Promise<Geofence> {
      const response = await soc()
        .from('geofences')
        .insert({ organization_id: organizationId, ...geofenceColumns(draft) })
        .select('*')
        .single()
      if (response.error !== null) throw refusal(response.error, 'geofence')
      const [row] = rows(GEOFENCE_ROW, [response.data], 'geofences')
      if (row === undefined) throw new BackendError('soc.geofences answered no row')
      return geofenceOf(row)
    },

    async changeGeofence(geofenceId: string, changes: GeofenceChanges): Promise<Geofence> {
      const response = await soc()
        .from('geofences')
        .update(geofenceColumns(changes))
        .eq('id', geofenceId)
        .select('*')
      if (response.error !== null) throw refusal(response.error, 'geofence')
      const [row] = rows(GEOFENCE_ROW, response.data, 'geofences')
      if (row === undefined) throw untouched('geofence')
      return geofenceOf(row)
    },

    async retireGeofence(geofenceId: string): Promise<void> {
      const response = await soc()
        .from('geofences')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', geofenceId)
        .select('id')
      if (response.error !== null) throw refusal(response.error, 'geofence')
      if (response.data.length === 0) throw untouched('geofence')
    },

    async waylines(organizationId: string): Promise<Wayline[]> {
      const { data, error } = await soc()
        .from('waylines')
        .select('*')
        .eq('organization_id', organizationId)
        .is('deleted_at', null)
        .order('name')
      if (error !== null) throw new BackendError(error.message, error.code)
      return rows(WAYLINE_ROW, data, 'waylines').map((row) => waylineOf(row))
    },

    async createWayline(organizationId: string, draft: WaylineDraft): Promise<Wayline> {
      const response = await soc()
        .from('waylines')
        .insert({ organization_id: organizationId, ...waylineColumns(draft) })
        .select('*')
        .single()
      if (response.error !== null) throw refusal(response.error, 'wayline')
      const [row] = rows(WAYLINE_ROW, [response.data], 'waylines')
      if (row === undefined) throw new BackendError('soc.waylines answered no row')
      return waylineOf(row)
    },

    async changeWayline(waylineId: string, changes: WaylineChanges): Promise<Wayline> {
      const response = await soc()
        .from('waylines')
        .update(waylineColumns(changes))
        .eq('id', waylineId)
        .select('*')
      if (response.error !== null) throw refusal(response.error, 'wayline')
      const [row] = rows(WAYLINE_ROW, response.data, 'waylines')
      if (row === undefined) throw untouched('wayline')
      return waylineOf(row)
    },

    async retireWayline(waylineId: string): Promise<void> {
      const response = await soc()
        .from('waylines')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', waylineId)
        .select('id')
      if (response.error !== null) throw refusal(response.error, 'wayline')
      if (response.data.length === 0) throw untouched('wayline')
    },
  }
}
