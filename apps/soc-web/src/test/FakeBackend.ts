import {
  BackendError,
  FieldRefusedError,
  type Account,
  type AircraftModel,
  type Backend,
  type Device,
  type Fleet,
  type FleetChanges,
  type FleetDraft,
  type Organization,
  type SignInFailure,
  type StateEvent,
} from '../backend/backend'
import { untouched } from '../backend/supabaseFleets'
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
  private account: Account | null
  private readonly listeners = new Set<(account: Account | null) => void>()
  private readonly stateListeners = new Map<string, Set<(event: StateEvent) => void>>()
  private readonly telemetryListeners = new Map<string, Set<(sample: TelemetrySample) => void>>()
  private fleetsMade = 0

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

  private become(account: Account | null): void {
    this.account = account
    for (const listener of this.listeners) listener(account)
  }
}
