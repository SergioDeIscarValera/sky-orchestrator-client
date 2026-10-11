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

/** A write the database refused, with the field it names when it names one. */
export class FieldRefusedError extends BackendError {
  readonly field: FleetField | null

  constructor(message: string, field: FleetField | null, code: string | null = null) {
    super(message, code)
    this.field = field
  }
}

/**
 * A change on the organization's state topic (ADR-0007), from the database's triggers, or
 * `joined` each time the topic is joined: broadcasts sent while away are not replayed, so
 * whatever was read before then may be stale.
 */
export interface StateEvent {
  readonly kind: 'joined' | 'stack' | 'device' | 'fleet' | 'command_intent'
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
  onState(organizationId: string, listener: (event: StateEvent) => void): () => void
  onTelemetry(organizationId: string, listener: (sample: TelemetrySample) => void): () => void
}
