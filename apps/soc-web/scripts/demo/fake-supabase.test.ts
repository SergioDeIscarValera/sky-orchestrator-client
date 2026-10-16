// @vitest-environment node
import { FieldRefusedError, type Backend, type Fleet } from '../../src/backend/backend'
import { bake } from '../../src/geometry/bake'
import { designFromJson, envelopeFromSkyOrchestrator } from '../../src/geometry/designJson'
import { supabaseBackend } from '../../src/backend/supabase'
import { parseRuntimeConfiguration } from '../../src/config/runtime'
import { PASSWORD_FOR_TESTS } from '../../src/test/keys'
import { startFakeSupabase, type FakeSupabase } from './fake-supabase.mjs'
import { DEMO_SETTINGS, demoSupabaseKey } from './run.mjs'
import { replaySerials } from '../../src/telemetry/replay'

const EMAIL = 'pilot@farm.test'
const NORTH = '11111111-1111-4111-8111-111111111111'
const ALMENDRAL = '22222222-2222-4222-8222-222222222222'
const NO_FLEET_AIRCRAFT = '3YTBJ7R0021ZK9'
const UNKNOWN_FLEET = '44444444-4444-4444-8444-444444444444'

const SECOND_FLEET = {
  name: 'Norte 2',
  model: 'mavic-air-2',
  airframeSerial: '3YTBJ7',
  controllerSerial: null,
  gatewaySn: 'SOTESTDOCK01',
  aircraftSn: NO_FLEET_AIRCRAFT,
  flightTimeBeforeSocS: 0,
}

let fake: FakeSupabase
let backend: Backend

function connect(url: string): Backend {
  return supabaseBackend(
    { supabaseUrl: url, supabaseKey: demoSupabaseKey() },
    { autoRefreshToken: false },
  )
}

async function fleetNames(organizationId: string): Promise<string[]> {
  return (await backend.fleets(organizationId)).map(({ name }) => name)
}

async function fleetNamed(name: string): Promise<Fleet> {
  const fleet = (await backend.fleets(NORTH)).find((candidate) => candidate.name === name)
  if (fleet === undefined) throw new Error(`no fleet named ${name}`)
  return fleet
}

/** Resolves once the backend's link reads up; fails at once if it reads down first. */
function linkUp(): Promise<void> {
  if (backend.link() === 'up') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const stop = backend.onLink((link) => {
      if (link === 'connecting') return
      stop()
      if (link === 'up') resolve()
      else reject(new Error('the link read down before it read up'))
    })
  })
}

/** A socket to the demo's Realtime, opened as the console's client opens it (vsn 2.0.0). */
function openRealtime(url: string): Promise<WebSocket> {
  const address = new URL('/realtime/v1/websocket', url)
  address.protocol = 'ws:'
  address.searchParams.set('apikey', demoSupabaseKey())
  address.searchParams.set('vsn', '2.0.0')
  const socket = new WebSocket(address)
  return new Promise((resolve, reject) => {
    socket.addEventListener(
      'open',
      () => {
        resolve(socket)
      },
      { once: true },
    )
    socket.addEventListener(
      'error',
      () => {
        reject(new Error(`no socket at ${address.href}`))
      },
      { once: true },
    )
  })
}

/** The next frame the socket receives, parsed as the Realtime protocol's JSON. */
function nextFrame(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    socket.addEventListener(
      'message',
      (event: MessageEvent<string>) => {
        resolve(JSON.parse(event.data))
      },
      { once: true },
    )
  })
}

beforeAll(async () => {
  fake = await startFakeSupabase({ port: 0 })
  backend = connect(fake.url)
  expect(await backend.signIn(EMAIL, PASSWORD_FOR_TESTS)).toBeNull()
})

afterAll(async () => {
  await fake.close()
})

describe('the demo Supabase, read through the console backend', () => {
  it('answers the two organizations of the signed-in user', async () => {
    const organizations = await backend.memberOrganizations()
    expect(organizations.map(({ name, role }) => [name, role])).toEqual([
      ['Finca Norte', 'owner'],
      ['Almendral', 'viewer'],
    ])
  })

  it('answers the 38 models of the catalogue', async () => {
    expect(await backend.aircraftModels()).toHaveLength(38)
  })

  it('answers an unpublished figure as null, never as a text that reads as NaN', async () => {
    const models = await backend.aircraftModels()
    expect(models.find(({ model }) => model === 'inspire-1-pro')?.maxHorizontalSpeedMs).toBeNull()
    const figures = models.flatMap((model) => [
      model.maxHorizontalSpeedMs,
      model.maxAscentSpeedMs,
      model.maxDescentSpeedMs,
      model.maxFlightTimeS,
      model.maxServiceCeilingM,
      model.maxWindResistanceMs,
      model.weightG,
    ])
    expect(figures.filter((figure) => figure !== null && !Number.isFinite(figure))).toEqual([])
  })

  it('answers a browser preflight for the headers the console sends, Authorization included', async () => {
    const response = await fetch(`${fake.url}/rest/v1/fleets`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5199',
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'authorization, apikey, content-type, prefer',
      },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-allow-methods')).toContain('PATCH')
    expect(response.headers.get('access-control-allow-headers')).toBe(
      'authorization, apikey, content-type, prefer',
    )
  })

  it("answers the aircraft of Finca Norte: three on stack lab, and the replay's two on their own", async () => {
    const devices = await backend.devices(NORTH)
    expect(
      devices.map(({ aircraftSn, online, stack }) => [
        aircraftSn,
        online,
        stack.name,
        stack.linkState,
      ]),
    ).toEqual([
      ['1WNBH9E00A0042', true, 'lab', 'connected'],
      [NO_FLEET_AIRCRAFT, true, 'lab', 'connected'],
      ['5HPCJ4T00D2M77', true, 'lab', 'unreachable'],
      ['REPLAYUAV', true, 'replay', 'connected'],
      ['REPLAYUAV2', true, 'replay', 'connected'],
    ])
    // The serials `?replay=2` flies, so both aircraft in the scene are listed too.
    expect(
      devices.slice(-2).map(({ gatewaySn, aircraftSn }) => ({ gatewaySn, aircraftSn })),
    ).toEqual([replaySerials(0), replaySerials(1)])
  })

  it('answers the one fleet of Finca Norte, and nothing for Almendral', async () => {
    expect(await fleetNames(NORTH)).toEqual(['Norte 1'])
    expect(await backend.devices(ALMENDRAL)).toEqual([])
    expect(await backend.fleets(ALMENDRAL)).toEqual([])
  })

  it('registers the aircraft without a fleet as a second fleet', async () => {
    const fleet = await backend.registerFleet(NORTH, SECOND_FLEET)
    expect(fleet).toMatchObject({ name: 'Norte 2', aircraftSn: NO_FLEET_AIRCRAFT })
    expect(await fleetNames(NORTH)).toEqual(['Norte 1', 'Norte 2'])
  })

  it('refuses a second live fleet for the same aircraft, and names the field', async () => {
    const refusal = await backend
      .registerFleet(NORTH, SECOND_FLEET)
      .catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(FieldRefusedError)
    expect(refusal).toMatchObject({ field: 'aircraftSn', code: '23505' })
  })

  it('changes a fleet, and answers the row it changed', async () => {
    const second = await fleetNamed('Norte 2')
    expect(await backend.changeFleet(second.id, { name: 'Norte 2 (hangar)' })).toMatchObject({
      id: second.id,
      name: 'Norte 2 (hangar)',
    })
    expect(await fleetNames(NORTH)).toEqual(['Norte 1', 'Norte 2 (hangar)'])
  })

  it('names a change to a fleet that is not there, which the database answers with no row', async () => {
    await expect(backend.changeFleet(UNKNOWN_FLEET, { name: 'Nobody' })).rejects.toThrow(
      'Nothing changed',
    )
  })

  it('retires a fleet, which then no longer lists', async () => {
    await backend.retireFleet((await fleetNamed('Norte 2 (hangar)')).id)
    expect(await fleetNames(NORTH)).toEqual(['Norte 1'])
  })
})

describe("the demo's geofences and waylines, read through the console backend", () => {
  const SQUARE = [
    { latitudeDeg: 41.6523, longitudeDeg: -4.7245 },
    { latitudeDeg: 41.6523, longitudeDeg: -4.7235 },
    { latitudeDeg: 41.6531, longitudeDeg: -4.7235 },
  ]

  it('answers the north corridor of Finca Norte, to generate a geofence round, and none for Almendral', async () => {
    const [corridor, ...others] = await backend.waylines(NORTH)
    expect(others).toEqual([])
    expect(corridor).toMatchObject({ name: 'North corridor', defaultHeightM: 30 })
    expect(corridor?.takeoff.latitudeDeg).toBeCloseTo(41.6523, 9)
    expect(corridor?.takeoff.longitudeDeg).toBeCloseTo(-4.7245, 9)
    expect(corridor?.waypoints.map(({ index }) => index)).toEqual([0, 1, 2, 3, 4])
    // Its design reads as the designer reads it, and bakes to its waypoints.
    const design = designFromJson(corridor?.design)
    const baked = bake(design, { origin: design.takeoff, maxArcSpacingM: 10 })
    expect(baked.waypoints.map(({ heightM }) => heightM)).toEqual([30, 30, 30, 30, 30])
    expect(baked.waypoints.length).toBe(corridor?.waypoints.length)
    expect(baked.distanceM).toBeCloseTo(corridor?.metrics.distanceM ?? 0, -1)
    expect(await backend.waylines(ALMENDRAL)).toEqual([])
  })

  it('answers the north field of Finca Norte, round the corridor, the seeded operation inside it', async () => {
    const [field, ...others] = await backend.geofences(NORTH)
    expect(others).toEqual([])
    expect(field).toMatchObject({ name: 'North field', maxHeightM: 60, origin: 'drawn' })
    expect(field?.polygon).toHaveLength(4)
    const [corridor] = await backend.waylines(NORTH)
    const latitudes = field?.polygon.map(({ latitudeDeg }) => latitudeDeg) ?? []
    const longitudes = field?.polygon.map(({ longitudeDeg }) => longitudeDeg) ?? []
    for (const { position } of corridor?.waypoints ?? []) {
      expect(position.latitudeDeg).toBeGreaterThan(Math.min(...latitudes))
      expect(position.latitudeDeg).toBeLessThan(Math.max(...latitudes))
      expect(position.longitudeDeg).toBeGreaterThan(Math.min(...longitudes))
      expect(position.longitudeDeg).toBeLessThan(Math.max(...longitudes))
    }
    const [operation] = await backend.operations(NORTH)
    expect(operation?.geofenceId).toBe(field?.id)
    expect(await backend.geofences(ALMENDRAL)).toEqual([])
  })

  it('saves, renames and retires a geofence, its ring read back as written', async () => {
    const saved = await backend.createGeofence(NORTH, {
      name: 'Trial plot',
      polygon: SQUARE,
      maxHeightM: 45,
      origin: 'drawn',
      marginM: null,
    })
    expect(saved).toMatchObject({ name: 'Trial plot', polygon: SQUARE, maxHeightM: 45 })
    expect(await backend.changeGeofence(saved.id, { name: 'Trial plot, west' })).toMatchObject({
      id: saved.id,
      name: 'Trial plot, west',
      polygon: SQUARE,
    })
    await backend.retireGeofence(saved.id)
    expect((await backend.geofences(NORTH)).map(({ name }) => name)).toEqual(['North field'])
    await expect(backend.changeGeofence(saved.id, { name: 'Back' })).rejects.toThrow(
      'Nothing changed',
    )
  })
})

describe('signing in to the demo', () => {
  const token = async (grant: string, body: Readonly<Record<string, string>>) => {
    const response = await fetch(`${fake.url}/auth/v1/token?grant_type=${grant}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload: unknown = await response.json()
    return { status: response.status, payload }
  }

  it('accepts any email with any password', async () => {
    expect(await connect(fake.url).signIn('someone.else@farm.test', PASSWORD_FOR_TESTS)).toBeNull()
  })

  it('refuses an empty password as GoTrue refuses wrong credentials', async () => {
    const nothing = ''
    const refused = await token('password', { email: EMAIL, password: nothing })
    expect(refused.status).toBe(400)
    expect(refused.payload).toMatchObject({ code: 'invalid_credentials' })
  })

  it('renews a session with its refresh token, which then serves once', async () => {
    const signedIn = await token('password', { email: EMAIL, password: PASSWORD_FOR_TESTS })
    const { refresh_token: refresh } = signedIn.payload as { refresh_token: string }
    expect(await token('refresh_token', { refresh_token: refresh })).toMatchObject({ status: 200 })
    expect(await token('refresh_token', { refresh_token: refresh })).toMatchObject({ status: 400 })
  })
})

describe("the demo's configuration", () => {
  it("passes the console's own check, with the anon key the console expects", () => {
    expect(
      parseRuntimeConfiguration({
        supabase_url: fake.url,
        supabase_key: demoSupabaseKey(),
        settings: DEMO_SETTINGS,
      }),
    ).toMatchObject({
      supabaseUrl: fake.url,
      settings: {
        telemetryStaleAfterMs: 3000,
        telemetryLostAfterMs: 10000,
        geofenceWarningBandM: 5,
        geofenceMaxVertices: 32,
        maxArcSpacingM: 10,
      },
    })
  })
})

describe("the demo's Realtime, joined by the console", () => {
  it('joins the state and telemetry topics, and the link reads up', async () => {
    const up = linkUp()
    const stopState = backend.onState(NORTH, () => undefined)
    const stopTelemetry = backend.onTelemetry(NORTH, () => undefined)
    await up
    expect(backend.link()).toBe('up')
    stopState()
    stopTelemetry()
  })

  it('answers a heartbeat with an ok reply, which the link waits for', async () => {
    const socket = await openRealtime(fake.url)
    const reply = nextFrame(socket)
    socket.send(JSON.stringify([null, '1', 'phoenix', 'heartbeat', {}]))
    expect(await reply).toEqual([null, '1', 'phoenix', 'phx_reply', { status: 'ok', response: {} }])
    socket.close()
  })

  it('ends its open sockets when it closes, so the process can exit', async () => {
    const own = await startFakeSupabase({ port: 0 })
    const socket = await openRealtime(own.url)
    const closed = new Promise<void>((resolve) => {
      socket.addEventListener(
        'close',
        () => {
          resolve()
        },
        { once: true },
      )
    })
    await own.close()
    await closed
    expect(socket.readyState).toBe(WebSocket.CLOSED)
  })
})

describe("the demo's operations, read and written through the console backend (migration 0010)", () => {
  const DEMO_PILOT = '6f1c2a52-34c5-4d7b-9a43-0b0f9e1d2c11'
  const NORTE_1 = '33333333-3333-4333-8333-333333333333'
  const CORRIDOR = '55555555-5555-4555-8555-555555555555'
  const CLIENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const OTHER_CLIENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const FLIGHT = '88888888-8888-4888-8888-888888888888'

  /** The seeded operation of Finca Norte, found by its name: the lists keep no order of their own here. */
  async function corridorOperation() {
    const operation = (await backend.operations(NORTH)).find(
      ({ name }) => name === 'North corridor',
    )
    if (operation === undefined) throw new Error('the demo has no North corridor operation')
    return operation
  }

  it('answers the one operation of Finca Norte: a draft named for its corridor, flown by Norte 1', async () => {
    const operation = await corridorOperation()
    expect(operation).toMatchObject({
      state: 'draft',
      endReason: null,
      createdBy: DEMO_PILOT,
      takeoffSecurityHeightM: null,
    })
    expect(await backend.operations(ALMENDRAL)).toEqual([])
    expect(await backend.assignments(operation.id)).toEqual([
      expect.objectContaining({
        operationId: operation.id,
        waylineId: CORRIDOR,
        fleetId: NORTE_1,
        speedMs: null,
        flight: null,
      }),
    ])
    expect(await backend.operators(operation.id)).toEqual([
      { operationId: operation.id, profileId: DEMO_PILOT, role: 'pilot' },
    ])
    expect(await backend.events(operation.id)).toEqual([])
    expect(await backend.members(NORTH)).toEqual([
      { profileId: DEMO_PILOT, displayName: null, email: EMAIL, role: 'owner' },
    ])
  })

  it('answers the lab stack with the envelope its dock reported, and the replay stacks with none', async () => {
    const stacks = await backend.stacks(NORTH)
    const lab = stacks.find(({ name }) => name === 'lab')
    expect(lab).toMatchObject({
      gatewaySn: 'SOTESTDOCK01',
      linkState: 'connected',
      envelopeReadAt: '2026-10-11T12:40:00+00:00',
    })
    // The envelope reads as Sky Orchestrator's own, strictly: the same limits the bake checks.
    expect(envelopeFromSkyOrchestrator(lab?.envelope)).toMatchObject({
      maxHeightM: 120,
      maxHorizontalSpeedMs: 15,
    })
    expect(stacks.filter(({ name }) => name === 'replay')).toEqual([
      expect.objectContaining({ envelope: null, envelopeReadAt: null }),
      expect.objectContaining({ envelope: null, envelopeReadAt: null }),
    ])
  })

  it('creates an operation as a draft, changes its name, and lists it with the others', async () => {
    const created = await backend.createOperation(NORTH, {
      name: 'Trial corridor',
      geofenceId: null,
      takeoffSecurityHeightM: 40,
    })
    expect(created).toMatchObject({
      name: 'Trial corridor',
      state: 'draft',
      takeoffSecurityHeightM: 40,
      endReason: null,
    })
    expect(
      await backend.changeOperation(created.id, { name: 'Trial corridor, west' }),
    ).toMatchObject({ id: created.id, name: 'Trial corridor, west', takeoffSecurityHeightM: 40 })
    expect((await backend.operations(NORTH)).map(({ id }) => id)).toContain(created.id)
  })

  it('changes an operator role, removes it, and names it again', async () => {
    const operation = await corridorOperation()
    expect(await backend.changeOperator(operation.id, DEMO_PILOT, 'observer')).toEqual({
      operationId: operation.id,
      profileId: DEMO_PILOT,
      role: 'observer',
    })
    expect(await backend.changeOperator(operation.id, DEMO_PILOT, 'pilot')).toMatchObject({
      role: 'pilot',
    })
    await backend.removeOperator(operation.id, DEMO_PILOT)
    expect(await backend.operators(operation.id)).toEqual([])
    await expect(backend.removeOperator(operation.id, DEMO_PILOT)).rejects.toThrow(
      'Nothing changed',
    )
    expect(await backend.nameOperator(operation.id, NORTH, DEMO_PILOT, 'pilot')).toMatchObject({
      role: 'pilot',
    })
  })

  it('unassigns the seeded assignment and assigns it again, its speed and flight as given', async () => {
    const operation = await corridorOperation()
    const [seeded] = await backend.assignments(operation.id)
    if (seeded === undefined) throw new Error('the demo has no assignment')
    await backend.unassign(seeded.id)
    expect(await backend.assignments(operation.id)).toEqual([])
    const again = await backend.assign(operation.id, NORTH, {
      waylineId: CORRIDOR,
      fleetId: NORTE_1,
      speedMs: 12,
      flight: { schema_version: '2.2.0' },
    })
    expect(await backend.changeAssignment(again.id, { speedMs: 10 })).toMatchObject({
      speedMs: 10,
      flight: { schema_version: '2.2.0' },
    })
    expect(await backend.assignments(operation.id)).toEqual([
      expect.objectContaining({ id: again.id, speedMs: 10 }),
    ])
  })

  it('asks a transition through the RPC once per client request id, and a pilot may ask to simulate', async () => {
    const operation = await corridorOperation()
    const plan = await backend.requestTransition(operation.id, 'plan', CLIENT)
    expect(plan).toMatchObject({
      transition: 'plan',
      status: 'pending',
      operationId: operation.id,
      requestedBy: DEMO_PILOT,
    })
    expect(await backend.requestTransition(operation.id, 'plan', CLIENT)).toEqual(plan)
    expect(await backend.requests(operation.id)).toEqual([plan])
    expect(await backend.requestTransition(operation.id, 'simulate', OTHER_CLIENT)).toMatchObject({
      transition: 'simulate',
      status: 'pending',
    })
  })

  it("answers an operation's requests newest first, as the console reads its latest", async () => {
    const operation = await corridorOperation()
    const first = await backend.requestTransition(
      operation.id,
      'plan',
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    )
    // A few milliseconds apart: the database stamps each request with its own time.
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await backend.requestTransition(
      operation.id,
      'plan',
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    )
    const requests = await backend.requests(operation.id)
    expect(requests.slice(0, 2).map(({ id }) => id)).toEqual([second.id, first.id])
    expect(requests.map(({ requestedAt }) => requestedAt)).toEqual(
      requests
        .map(({ requestedAt }) => requestedAt)
        .toSorted()
        .reverse(),
    )
  })

  it('refuses a command for a flight the demo does not fly, as the database refuses a stranger', async () => {
    const operation = await corridorOperation()
    const refused = await backend
      .requestCommand(FLIGHT, 'pause', CLIENT)
      .catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(FieldRefusedError)
    expect(refused).toMatchObject({
      code: '42501',
      message: 'Only a pilot of the operation commands its aircraft.',
    })
    expect(await backend.commands(operation.id)).toEqual([])
  })

  it('answers a browser preflight for the DELETE the console sends to unassign and remove', async () => {
    const response = await fetch(`${fake.url}/rest/v1/assignments`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5199',
        'access-control-request-method': 'DELETE',
        'access-control-request-headers': 'authorization, apikey, content-type, prefer',
      },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-methods')).toContain('DELETE')
  })
})

describe("the demo's flown tracks, read through the console backend (FR-TEL-05)", () => {
  const FLOWN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const UNFLOWN = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  const START = Date.parse('2026-10-11T10:00:00Z')
  const FLEET = '33333333-3333-4333-8333-333333333333'

  /** One stored sample of a flight, as soc.telemetry_samples holds it: `second` after the start. */
  function sample(flightId: string, second: number, heightM: number) {
    return {
      flight_id: flightId,
      sampled_at: new Date(START + second * 1000).toISOString(),
      received_at: new Date(START + second * 1000 + 40).toISOString(),
      organization_id: NORTH,
      fleet_id: FLEET,
      longitude: -4.7245,
      latitude: 41.6523,
      height_m: heightM,
      battery_pct: 80,
    }
  }

  // 1,200 samples of FLOWN, stored newest first (the answer must still be in time order), and two of OTHER.
  const telemetry = [
    ...Array.from({ length: 1200 }, (_, index) => sample(FLOWN, 1199 - index, 1199 - index)),
    sample(OTHER, 0, 5),
    sample(OTHER, 1, 6),
  ]
  let seeded: FakeSupabase
  let flown: Backend

  beforeAll(async () => {
    seeded = await startFakeSupabase({ port: 0, telemetry })
    flown = connect(seeded.url)
  })

  afterAll(async () => {
    await seeded.close()
  })

  it("answers a flight's track in time order, and only the samples of that flight", async () => {
    expect((await flown.track(OTHER)).map(({ heightM }) => heightM)).toEqual([5, 6])
    expect(await flown.track(UNFLOWN)).toEqual([])
  })

  it("pages a track past the demo's row cap, so the console reads every sample of a long flight", async () => {
    const track = await flown.track(FLOWN)
    expect(track.map(({ heightM }) => heightM)).toEqual(Array.from({ length: 1200 }, (_, i) => i))
    expect(track[0]).toEqual({
      sampledAt: new Date(START).toISOString(),
      position: { latitudeDeg: 41.6523, longitudeDeg: -4.7245 },
      heightM: 0,
    })
  })

  it('answers only the columns a track read selects, as PostgREST does', async () => {
    const url = new URL('/rest/v1/telemetry_samples', seeded.url)
    url.searchParams.set('flight_id', `eq.${OTHER}`)
    url.searchParams.set('select', 'sampled_at,height_m')
    const answer = (await (await fetch(url)).json()) as Record<string, unknown>[]
    expect(answer.map((row) => Object.keys(row).sort())).toEqual([
      ['height_m', 'sampled_at'],
      ['height_m', 'sampled_at'],
    ])
  })
})
