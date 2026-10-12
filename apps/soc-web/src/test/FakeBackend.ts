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
  type Geofence,
  type GeofenceChanges,
  type GeofenceDraft,
  type Organization,
  type SignInFailure,
  type StateEvent,
  type Wayline,
  type WaylineChanges,
  type WaylineDraft,
} from '../backend/backend'
import type { Link } from '../backend/link'
import { untouched } from '../backend/supabaseFleets'
import type { Geodetic } from '../geometry/projection'
import {
  notAllowedRefusal,
  refusedBy,
  retiredRefusal,
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
  if (!(draft.speedMs > 0)) return refusedBy('wayline_speed_positive')
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
      speedMs: draft.speedMs,
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

  private become(account: Account | null): void {
    this.account = account
    for (const listener of this.listeners) listener(account)
  }
}
