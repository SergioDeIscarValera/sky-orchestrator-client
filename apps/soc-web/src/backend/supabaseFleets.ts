import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'

import { z } from '../schema'
import {
  BackendError,
  FieldRefusedError,
  type AircraftModel,
  type Device,
  type Fleet,
  type FleetChanges,
  type FleetDraft,
  type FleetField,
  type StateEvent,
} from './backend'
import { rows } from './rows'

/** Every broadcast on the organization's state topic (ADR-0007), each passed on as it was sent. */
const STATE_EVENTS = [
  'stack',
  'device',
  'fleet',
  'command_intent',
  'geofence',
  'wayline',
  'operation',
  'flight',
  'flight_state',
  'operation_event',
  'transition_request',
  'operation_check',
] as const

/** The part of a Realtime channel the console uses, so it can be faked in tests. */
export interface StateChannel {
  on(
    type: 'broadcast',
    filter: { event: string },
    callback: (message: { event: string; payload: Record<string, unknown> }) => void,
  ): StateChannel
  subscribe(callback: (status: string) => void): unknown
  unsubscribe(): unknown
}

export type ChannelFactory = (topic: string) => StateChannel

const nullableNumber = z.nullable(z.union([z.number(), z.string()]))
const MODEL_ROW = z.object({
  model: z.string(),
  display_name: z.string(),
  msdk_v4_support: z.enum(['full', 'partial']),
  support_notes: z.string(),
  max_horizontal_speed_ms: nullableNumber,
  max_ascent_speed_ms: nullableNumber,
  max_descent_speed_ms: nullableNumber,
  max_flight_time_s: z.nullable(z.number()),
  max_service_ceiling_m: nullableNumber,
  max_wind_resistance_ms: nullableNumber,
  weight_g: z.nullable(z.number()),
  camera: z.object({
    sensor: z.nullable(z.string()),
    photo_resolution: z.nullable(z.string()),
    video_resolution: z.nullable(z.string()),
    zoom: z.nullable(z.string()),
  }),
  thermal: z.object({
    capability: z.enum(['integrated', 'payload', 'none']),
    resolution: z.nullable(z.string()),
  }),
  sources: z.record(z.string(), z.string()),
})

const DEVICE_ROW = z.object({
  gateway_sn: z.string(),
  aircraft_sn: z.string(),
  domain: z.number(),
  type: z.number(),
  sub_type: z.number(),
  online: z.boolean(),
  firmware_version: z.nullable(z.string()),
  first_seen_at: z.string(),
  last_seen_at: z.string(),
  stacks: z.object({
    name: z.string(),
    link_state: z.enum(['connected', 'connecting', 'displaced', 'unreachable']),
  }),
})

const FLEET_ROW = z.object({
  id: z.uuid(),
  name: z.string(),
  model: z.string(),
  airframe_serial: z.string(),
  controller_serial: z.nullable(z.string()),
  gateway_sn: z.string(),
  aircraft_sn: z.string(),
  flight_time_before_soc_s: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
})

/** What the database's constraints mean to the person filling the form (FR-FLE-03). */
const REFUSALS: Readonly<Record<string, { field: FleetField | null; message: string }>> = {
  fleet_name_given: { field: 'name', message: 'A fleet needs a name.' },
  fleets_model_fkey: { field: 'model', message: "Choose the aircraft's model from the catalogue." },
  fleet_airframe_serial_given: {
    field: 'airframeSerial',
    message: 'A fleet needs the serial printed on the airframe.',
  },
  fleets_one_live_per_device: {
    field: 'aircraftSn',
    message: 'This aircraft already belongs to a live fleet.',
  },
  fleets_gateway_sn_aircraft_sn_fkey: {
    field: 'aircraftSn',
    message: 'SOC has not seen this aircraft on the wire.',
  },
  fleets_gateway_sn_organization_id_fkey: {
    field: 'gatewaySn',
    message: "This aircraft's stack flies for another organization.",
  },
}
const NOT_NULL: Readonly<Record<string, { field: FleetField; message: string }>> = {
  name: { field: 'name', message: 'A fleet needs a name.' },
  model: { field: 'model', message: "Choose the aircraft's model from the catalogue." },
  airframe_serial: {
    field: 'airframeSerial',
    message: 'A fleet needs the serial printed on the airframe.',
  },
}
const NOT_ALLOWED = '42501'
/** The words the trigger raises fleet_identity_in_flight with: PostgREST sends no constraint name. */
const FLYING = 'its aircraft is flying'

export function refusal(error: PostgrestError): BackendError {
  const constraint = /constraint "([^"]+)"/.exec(error.message)?.[1]
  const known = constraint === undefined ? undefined : REFUSALS[constraint]
  if (known !== undefined) return new FieldRefusedError(known.message, known.field, error.code)
  const column = /column "([^"]+)"/.exec(error.message)?.[1]
  const missing = column === undefined ? undefined : NOT_NULL[column]
  if (missing !== undefined && error.code === '23502') {
    return new FieldRefusedError(missing.message, missing.field, error.code)
  }
  if (error.code === NOT_ALLOWED) {
    return new FieldRefusedError('Only editors and owners change fleets.', null, error.code)
  }
  if (error.message.includes('a retired fleet does not change')) {
    return new FieldRefusedError('A retired fleet does not change.', null, error.code)
  }
  if (error.message.includes(FLYING)) return flyingRefusal(error.code)
  return new BackendError(error.message, error.code)
}

/**
 * The wire identity of a fleet whose aircraft flies: the trigger refuses its change and names no
 * field, since the gateway and the aircraft serials are both the identity (migration 0010, FR-FLE-05).
 */
export function flyingRefusal(code: string | null = '23514'): FieldRefusedError {
  return new FieldRefusedError(
    'This aircraft is flying: its wire identity stays until its flight ends.',
    null,
    code,
  )
}

/**
 * Row security hides a fleet from a viewer's update instead of refusing it, so a write that
 * returns no row changed nothing: the fleet is not the organization's, or the role only reads.
 */
export function untouched(): FieldRefusedError {
  return new FieldRefusedError(
    'Nothing changed: this fleet is not one your role in this organization can change.',
    null,
  )
}

function number(value: number | string | null): number | null {
  return value === null ? null : Number(value)
}

function fleetOf(row: z.infer<typeof FLEET_ROW>): Fleet {
  return {
    id: row.id,
    name: row.name,
    model: row.model,
    airframeSerial: row.airframe_serial,
    controllerSerial: row.controller_serial,
    gatewaySn: row.gateway_sn,
    aircraftSn: row.aircraft_sn,
    flightTimeBeforeSocS: row.flight_time_before_soc_s,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function columns(changes: FleetChanges): Record<string, unknown> {
  const renamed: Record<string, unknown> = {
    name: changes.name,
    model: changes.model,
    airframe_serial: changes.airframeSerial,
    controller_serial: changes.controllerSerial,
    flight_time_before_soc_s: changes.flightTimeBeforeSocS,
    gateway_sn: changes.gatewaySn,
    aircraft_sn: changes.aircraftSn,
  }
  return Object.fromEntries(Object.entries(renamed).filter(([, value]) => value !== undefined))
}

export function fleetOperations(client: SupabaseClient, channel: ChannelFactory) {
  const soc = () => client.schema('soc')

  return {
    async aircraftModels(): Promise<AircraftModel[]> {
      const { data, error } = await soc().from('aircraft_models').select('*').order('display_name')
      if (error !== null) throw new BackendError(error.message, error.code)
      return rows(MODEL_ROW, data, 'aircraft_models').map((row) => ({
        model: row.model,
        displayName: row.display_name,
        msdkV4Support: row.msdk_v4_support,
        supportNotes: row.support_notes,
        maxHorizontalSpeedMs: number(row.max_horizontal_speed_ms),
        maxAscentSpeedMs: number(row.max_ascent_speed_ms),
        maxDescentSpeedMs: number(row.max_descent_speed_ms),
        maxFlightTimeS: row.max_flight_time_s,
        maxServiceCeilingM: number(row.max_service_ceiling_m),
        maxWindResistanceMs: number(row.max_wind_resistance_ms),
        weightG: row.weight_g,
        camera: {
          sensor: row.camera.sensor,
          photoResolution: row.camera.photo_resolution,
          videoResolution: row.camera.video_resolution,
          zoom: row.camera.zoom,
        },
        thermal: row.thermal,
        sources: row.sources,
      }))
    },

    async devices(organizationId: string): Promise<Device[]> {
      const { data, error } = await soc()
        .from('devices')
        .select('*, stacks!inner(name, link_state)')
        .eq('stacks.organization_id', organizationId)
        .order('first_seen_at')
      if (error !== null) throw new BackendError(error.message, error.code)
      return rows(DEVICE_ROW, data, 'devices').map((row) => ({
        gatewaySn: row.gateway_sn,
        aircraftSn: row.aircraft_sn,
        wireModel: `${String(row.domain)}-${String(row.type)}-${String(row.sub_type)}`,
        online: row.online,
        firmwareVersion: row.firmware_version,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        stack: { name: row.stacks.name, linkState: row.stacks.link_state },
      }))
    },

    async fleets(organizationId: string): Promise<Fleet[]> {
      const { data, error } = await soc()
        .from('fleets')
        .select('*')
        .eq('organization_id', organizationId)
        .is('deleted_at', null)
        .order('name')
      if (error !== null) throw new BackendError(error.message, error.code)
      return rows(FLEET_ROW, data, 'fleets').map(fleetOf)
    },

    async registerFleet(organizationId: string, draft: FleetDraft): Promise<Fleet> {
      const response = await soc()
        .from('fleets')
        .insert({ organization_id: organizationId, ...columns(draft) })
        .select('*')
        .single()
      if (response.error !== null) throw refusal(response.error)
      const [row] = rows(FLEET_ROW, [response.data], 'fleets')
      if (row === undefined) throw new BackendError('soc.fleets answered no row')
      return fleetOf(row)
    },

    async changeFleet(fleetId: string, changes: FleetChanges): Promise<Fleet> {
      const response = await soc()
        .from('fleets')
        .update(columns(changes))
        .eq('id', fleetId)
        .select('*')
      if (response.error !== null) throw refusal(response.error)
      const [row] = rows(FLEET_ROW, response.data, 'fleets')
      if (row === undefined) throw untouched()
      return fleetOf(row)
    },

    async retireFleet(fleetId: string): Promise<void> {
      const response = await soc()
        .from('fleets')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', fleetId)
        .select('id')
      if (response.error !== null) throw refusal(response.error)
      if (response.data.length === 0) throw untouched()
    },

    onState(organizationId: string, listener: (event: StateEvent) => void): () => void {
      const subscription = channel(`org:${organizationId}:soc:state`)
      for (const kind of STATE_EVENTS) {
        subscription.on('broadcast', { event: kind }, ({ payload }) => {
          listener({ kind, payload })
        })
      }
      // Realtime calls back SUBSCRIBED on the first join and on every rejoin after a drop.
      subscription.subscribe((status) => {
        if (status === 'SUBSCRIBED') listener({ kind: 'joined', payload: {} })
      })
      return () => {
        void subscription.unsubscribe()
      }
    },
  }
}
