// The demo's Supabase: the GoTrue, PostgREST and Realtime calls the console makes, answered
// from memory, so `pnpm demo` runs the console with no server behind it (run.mjs). Fleets,
// geofences and waylines change in memory, and a restart resets them. The operations' tables
// are the database's (operation-tables.mjs), and soc-operations and soc-cloud play on them
// (lifecycle.mjs): each change to an operation is broadcast on its organization's state topic
// as the database broadcasts it, and the console reads it. No telemetry is sent, and a fleet,
// geofence or wayline changed from another console shows once the console reads again.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'

import { createLifecycle, TIMINGS } from './lifecycle.mjs'
import { createOperationTables, DatabaseError } from './operation-tables.mjs'

const HOST = '127.0.0.1'
const CATALOGUE = new URL('../../../../contracts/catalogue/aircraft-models.json', import.meta.url)
const API_VERSION = '2024-01-01'
const LIFETIME_S = 3600
/** Supabase's default row cap: a PostgREST answer holds at most this many rows (the console pages). */
const ROW_CAP = 1000
const DEFAULT_ALLOWED_HEADERS =
  'authorization, apikey, content-type, prefer, accept-profile, content-profile, x-client-info'
const INVALID_CREDENTIALS = {
  status: 400,
  payload: { code: 'invalid_credentials', message: 'Invalid login credentials' },
}
/** The socket the console's Realtime client opens, with its apikey and vsn in the query. */
const REALTIME_PATH = '/realtime/v1/websocket'
/** Events answered with an ok reply; the heartbeat, on topic `phoenix`, is answered too. */
const ANSWERED_EVENTS = new Set(['phx_join', 'phx_leave', 'access_token'])

const NORTH = '11111111-1111-4111-8111-111111111111'
const ALMENDRAL = '22222222-2222-4222-8222-222222222222'
const NORTE_1 = '33333333-3333-4333-8333-333333333333'
const NORTH_CORRIDOR = '55555555-5555-4555-8555-555555555555'
const USER_ID = '6f1c2a52-34c5-4d7b-9a43-0b0f9e1d2c11'
const GATEWAY = 'SOTESTDOCK01'
const OPERATION = '66666666-6666-4666-8666-666666666666'
const ASSIGNMENT = '77777777-7777-4777-8777-777777777777'
/** The address the demo answers for its one member: the demo signs in with any address. */
const DEMO_EMAIL = 'pilot@farm.test'
/** The one device envelope the demo's stack reports: contracts/geometry/bake.json's `envelope`. */
const ENVELOPE = {
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
const ORGANIZATIONS = [
  {
    id: NORTH,
    name: 'Finca Norte',
    role: 'owner',
    latitude: 41.6523,
    longitude: -4.7245,
    timezone: 'Europe/Madrid',
  },
  {
    id: ALMENDRAL,
    name: 'Almendral',
    role: 'viewer',
    latitude: null,
    longitude: null,
    timezone: null,
  },
]

const published = (figure) => figure?.value ?? null
const sourced = (figure) => figure?.source ?? null

/** A catalogue entry as the aircraft_models table holds it (database/migrations/0006). */
function modelRow(entry) {
  const sources = Object.fromEntries(
    Object.entries({
      msdk_v4_support: entry.support_source,
      max_horizontal_speed_ms: sourced(entry.max_horizontal_speed_ms),
      max_ascent_speed_ms: sourced(entry.max_ascent_speed_ms),
      max_descent_speed_ms: sourced(entry.max_descent_speed_ms),
      max_flight_time_s: sourced(entry.max_flight_time_s),
      max_service_ceiling_m: sourced(entry.max_service_ceiling_m),
      max_wind_resistance_ms: sourced(entry.max_wind_resistance_ms),
      weight_g: sourced(entry.weight_g),
      'camera.sensor': sourced(entry.camera.sensor),
      'camera.photo_resolution': sourced(entry.camera.photo_resolution),
      'camera.video_resolution': sourced(entry.camera.video_resolution),
      'camera.zoom': sourced(entry.camera.zoom),
      'thermal.capability': sourced(entry.thermal.capability),
      'thermal.resolution': sourced(entry.thermal.resolution),
    }).filter(([, url]) => typeof url === 'string'),
  )
  return {
    model: entry.model,
    display_name: entry.display_name,
    msdk_v4_enum: entry.msdk_v4_enum,
    msdk_v4_support: entry.msdk_v4_support,
    support_notes: entry.support_notes,
    max_horizontal_speed_ms: published(entry.max_horizontal_speed_ms),
    max_ascent_speed_ms: published(entry.max_ascent_speed_ms),
    max_descent_speed_ms: published(entry.max_descent_speed_ms),
    max_flight_time_s: published(entry.max_flight_time_s),
    max_service_ceiling_m: published(entry.max_service_ceiling_m),
    max_wind_resistance_ms: published(entry.max_wind_resistance_ms),
    weight_g: published(entry.weight_g),
    camera: {
      sensor: published(entry.camera.sensor),
      photo_resolution: published(entry.camera.photo_resolution),
      video_resolution: published(entry.camera.video_resolution),
      zoom: published(entry.camera.zoom),
    },
    thermal: {
      capability: published(entry.thermal.capability),
      resolution: published(entry.thermal.resolution),
    },
    sources,
    source_urls: [...new Set(Object.values(sources))].sort(),
  }
}

const MODELS = JSON.parse(readFileSync(CATALOGUE, 'utf8'))
  .models.map(modelRow)
  .sort((a, b) => a.display_name.localeCompare(b.display_name))

/** An aircraft as the devices view answers it: its stack's last announcement of it. */
function device(aircraftSn, { online, linkState, firmware, firstSeen, lastSeen }) {
  return {
    gateway_sn: GATEWAY,
    aircraft_sn: aircraftSn,
    domain: 0,
    type: 67,
    sub_type: 0,
    online,
    firmware_version: firmware,
    first_seen_at: firstSeen,
    last_seen_at: lastSeen,
    stacks: { name: 'lab', link_state: linkState },
  }
}

/** One of the replay's aircraft, seen on the replay's own stack. */
function replayDevice(gatewaySn, aircraftSn) {
  return {
    ...device(aircraftSn, {
      online: true,
      linkState: 'connected',
      firmware: '10.01.0004',
      firstSeen: '2026-10-11T08:00:00+00:00',
      lastSeen: '2026-10-11T12:41:00+00:00',
    }),
    gateway_sn: gatewaySn,
    stacks: { name: 'replay', link_state: 'connected' },
  }
}

const DEVICES_BY_ORGANIZATION = new Map([
  [
    NORTH,
    [
      // In a fleet.
      device('1WNBH9E00A0042', {
        online: true,
        linkState: 'connected',
        firmware: '10.01.0004',
        firstSeen: '2026-10-11T08:00:00+00:00',
        lastSeen: '2026-10-11T12:41:00+00:00',
      }),
      // Online, in no fleet.
      device('3YTBJ7R0021ZK9', {
        online: true,
        linkState: 'connected',
        firmware: '10.01.0004',
        firstSeen: '2026-10-11T09:15:00+00:00',
        lastSeen: '2026-10-11T12:40:00+00:00',
      }),
      // Its stack is unreachable: the console shows the stack's state, not the flag it last sent.
      device('5HPCJ4T00D2M77', {
        online: true,
        linkState: 'unreachable',
        firmware: '10.01.0002',
        firstSeen: '2026-10-11T10:30:00+00:00',
        lastSeen: '2026-10-11T11:58:00+00:00',
      }),
      // The aircraft `?replay=2` flies in development (src/telemetry/replay.ts), on a stack of their own.
      replayDevice('REPLAYDOCK', 'REPLAYUAV'),
      replayDevice('REPLAYDOCK2', 'REPLAYUAV2'),
    ],
  ],
])

function seedFleets() {
  return [
    {
      id: NORTE_1,
      organization_id: NORTH,
      name: 'Norte 1',
      model: 'mavic-air-2',
      airframe_serial: '1WNBH9',
      controller_serial: null,
      gateway_sn: GATEWAY,
      aircraft_sn: '1WNBH9E00A0042',
      flight_time_before_soc_s: 45240,
      created_at: '2026-10-11T08:10:00+00:00',
      updated_at: '2026-10-11T08:10:00+00:00',
      deleted_at: null,
    },
  ]
}

/** A point `east` and `north` metres from Finca Norte, as [longitude, latitude]. */
function nearNorth(east, north) {
  const metresPerDegree = 111_320
  return [
    -4.7245 + east / (metresPerDegree * Math.cos((41.6523 * Math.PI) / 180)),
    41.6523 + north / metresPerDegree,
  ]
}

/** One wayline of Finca Norte, a corridor along its north field, to generate a geofence round. */
function seedWaylines() {
  const takeoff = nearNorth(0, 0)
  const route = [
    [0, 60],
    [180, 60],
    [180, 140],
    [0, 140],
  ].map(([east, north]) => nearNorth(east, north))
  // Baked as the designer bakes it: straight up above the takeoff first, then the route.
  const waypoints = [takeoff, ...route].map((position, index) => ({
    index,
    position,
    height_m: 30,
  }))
  return [
    {
      id: '55555555-5555-4555-8555-555555555555',
      organization_id: NORTH,
      name: 'North corridor',
      takeoff,
      default_height_m: 30,
      // Its design as the designer saves it: one route through the waypoints, baked to them.
      design: {
        schema_version: '2.2.0',
        takeoff,
        default_height_m: 30,
        primitives: [{ kind: 'route', points: route.map((position) => ({ position })) }],
      },
      waypoints,
      metrics: { waypoint_count: 5, distance_m: 499.4 },
      bake_version: '2.2.0',
      created_at: '2026-10-11T08:10:00+00:00',
      updated_at: '2026-10-11T08:10:00+00:00',
      deleted_at: null,
    },
  ]
}

/**
 * Finca Norte's one operation, as the database holds a new one (migration 0010): a draft named for
 * its wayline, flown by its one fleet, with its one pilot and an empty log.
 */
function seedOperations() {
  return [
    {
      id: OPERATION,
      organization_id: NORTH,
      name: 'North corridor',
      geofence_id: null,
      takeoff_security_height_m: null,
      state: 'draft',
      end_reason: null,
      created_by: USER_ID,
      created_at: '2026-10-11T08:20:00+00:00',
      updated_at: '2026-10-11T08:20:00+00:00',
      started_at: null,
      ended_at: null,
    },
  ]
}

function seedAssignments() {
  return [
    {
      id: ASSIGNMENT,
      operation_id: OPERATION,
      organization_id: NORTH,
      wayline_id: NORTH_CORRIDOR,
      fleet_id: NORTE_1,
      speed_ms: null,
      flight: null,
      created_at: '2026-10-11T08:20:00+00:00',
    },
  ]
}

function seedOperators() {
  return [{ operation_id: OPERATION, organization_id: NORTH, profile_id: USER_ID, role: 'pilot' }]
}

/** Each stack of Finca Norte, as soc-cloud records it: the lab's reports an envelope, the replay's none. */
function seedStacks() {
  return [
    {
      gateway_sn: GATEWAY,
      name: 'lab',
      organization_id: NORTH,
      link_state: 'connected',
      envelope: ENVELOPE,
      envelope_read_at: '2026-10-11T12:40:00+00:00',
    },
    ...['REPLAYDOCK', 'REPLAYDOCK2'].map((gatewaySn) => ({
      gateway_sn: gatewaySn,
      name: 'replay',
      organization_id: NORTH,
      link_state: 'connected',
      envelope: null,
      envelope_read_at: null,
    })),
  ]
}

/** A JWT-shaped string with a placeholder signature: the console reads only its payload. */
export function unsignedJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.sig`
}

/**
 * Starts the fake on 127.0.0.1 at `port`, 0 taking a free one. `telemetry` holds the rows of
 * soc.telemetry_samples the track read answers with; `timings` overrides the demo's TIMINGS (a
 * test shortens them). `url` is the address the console is given as its Supabase URL;
 * `close` stops the lifecycle's timers, the server and its connections.
 */
export function startFakeSupabase({ port = 0, telemetry = [], timings = {} } = {}) {
  const state = {
    fleets: seedFleets(),
    geofences: [],
    waylines: seedWaylines(),
    /** soc.telemetry_samples, as given: each flight's stored samples, read back as its track. */
    telemetry: [...telemetry],
    refreshTokens: new Map(),
    /** The operations' tables, by name: what the console reads and writes through PostgREST. */
    tables: {
      operations: seedOperations(),
      assignments: seedAssignments(),
      operators: seedOperators(),
      operation_checks: [],
      operation_events: [],
      transition_requests: [],
      flights: [],
      flight_states: [],
      command_intents: [],
      stacks: seedStacks(),
    },
  }
  /** The sockets joined to each topic: a broadcast on a state topic is sent to those. */
  const topics = new Map()
  const publish = (organizationId, event, payload) => {
    const topic = stateTopic(organizationId)
    const frame = JSON.stringify([
      null,
      null,
      topic,
      'broadcast',
      { type: 'broadcast', event, payload },
    ])
    for (const client of topics.get(topic) ?? []) {
      if (client.readyState === WebSocket.OPEN) client.send(frame)
    }
  }
  const db = createOperationTables({
    rows: (name) => rowsOf(state, name),
    publish,
    roles: { canEdit },
  })
  const lifecycle = createLifecycle({ db, roles: { canEdit }, timings: { ...TIMINGS, ...timings } })
  const app = { state, db, lifecycle }
  const server = createServer((request, response) => {
    void answer(app, request, response)
  })
  const realtime = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url ?? '/', `http://${HOST}`)
    // Only the console's socket is answered: any other upgrade is dropped.
    if (pathname !== REALTIME_PATH) {
      socket.destroy()
      return
    }
    realtime.handleUpgrade(request, socket, head, (client) => {
      client.on('message', (data, isBinary) => {
        if (!isBinary) answerFrame(client, data.toString('utf8'), topics)
      })
      // A socket that closes leaves every topic, so no broadcast is sent to it.
      client.on('close', () => {
        for (const sockets of topics.values()) sockets.delete(client)
      })
      // An error event nobody handles would crash the demo, so one client's error only drops it.
      client.on('error', () => client.terminate())
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, HOST, () => {
      server.off('error', reject)
      const { port: bound } = server.address()
      resolve({
        url: `http://${HOST}:${bound}`,
        close: () =>
          new Promise((done, failed) => {
            // Nothing is written after the fake stops: the lifecycle's timers go first.
            lifecycle.close()
            // ws leaves its clients open when its server closes, and an open socket keeps the
            // HTTP server from closing and the process from exiting: each is terminated first.
            for (const client of realtime.clients) client.terminate()
            realtime.close()
            server.close((error) => (error ? failed(error) : done()))
            server.closeAllConnections()
          }),
      })
    })
  })
}

/**
 * Answers one text frame of the console's Realtime client (realtime-js 2.x, protocol vsn 2.0.0: a
 * JSON array `[join_ref, ref, topic, event, payload]`). The client takes an ok reply to a join as
 * joined and to a leave as left, and it calls the socket dead when a heartbeat gets no reply within
 * one interval (link.ts), so each is answered at once. A join's reply names no postgres_changes:
 * the console binds none, and the client takes such a join as joined. Any other frame is ignored,
 * a binary user broadcast included.
 */
function answerFrame(client, text, topics) {
  const frame = frameOf(text)
  if (frame === null) return
  const [joinRef, ref, topic, event] = frame
  const heartbeat = topic === 'phoenix' && event === 'heartbeat'
  if (!heartbeat && !ANSWERED_EVENTS.has(event)) return
  // A join makes the socket one of the topic's listeners for its broadcasts, a leave takes it off.
  if (event === 'phx_join') joinTopic(topics, topic, client)
  if (event === 'phx_leave') topics.get(topic)?.delete(client)
  client.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: {} }]))
}

function joinTopic(topics, topic, client) {
  const sockets = topics.get(topic) ?? new Set()
  sockets.add(client)
  topics.set(topic, sockets)
}

/** The Realtime topic of an organization's state (ADR-0007): the console joins `org:<id>:soc:state`. */
function stateTopic(organizationId) {
  return `realtime:org:${organizationId}:soc:state`
}

/** The live rows of a table, by name: the operations' tables and the plans and fleets alike. */
function rowsOf(state, name) {
  if (name === 'fleets') return state.fleets
  if (name === 'waylines') return state.waylines
  return state.tables[name]
}

/** The five parts of a frame, or null when the text is not one: the client sends no other text. */
function frameOf(text) {
  try {
    const frame = JSON.parse(text)
    return Array.isArray(frame) && frame.length === 5 ? frame : null
  } catch {
    return null
  }
}

async function answer(app, request, response) {
  const headers = corsHeaders(request)
  try {
    if (request.method === 'OPTIONS') {
      send(response, 204, headers)
      return
    }
    const url = new URL(request.url ?? '/', `http://${HOST}`)
    const { status, payload } = route(
      app,
      request.method ?? '',
      url,
      parse(await readBody(request)),
    )
    send(response, status, headers, payload)
  } catch (error) {
    if (response.headersSent) response.destroy()
    else send(response, 500, headers, { message: `the demo failed: ${String(error)}` })
  }
}

function corsHeaders(request) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    // A wildcard does not cover Authorization, so the requested headers are echoed back.
    'access-control-allow-headers':
      request.headers['access-control-request-headers'] ?? DEFAULT_ALLOWED_HEADERS,
    'access-control-expose-headers': 'x-supabase-api-version',
    'x-supabase-api-version': API_VERSION,
    vary: 'Access-Control-Request-Headers',
  }
}

function send(response, status, headers, payload) {
  if (payload === undefined) {
    response.writeHead(status, headers)
    response.end()
    return
  }
  response.writeHead(status, { 'content-type': 'application/json', ...headers })
  response.end(JSON.stringify(payload))
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function parse(text) {
  if (text === '') return {}
  try {
    const value = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function route(app, method, url, body) {
  const { state } = app
  const { pathname, searchParams } = url
  if (pathname === '/auth/v1/token' && method === 'POST') {
    return token(state, searchParams.get('grant_type'), body)
  }
  if (pathname === '/auth/v1/logout' && method === 'POST') return { status: 204 }
  if (pathname === '/rest/v1/rpc/member_organizations' && (method === 'GET' || method === 'POST')) {
    return { status: 200, payload: ORGANIZATIONS }
  }
  if (pathname === '/rest/v1/aircraft_models' && method === 'GET') {
    return { status: 200, payload: MODELS }
  }
  if (pathname === '/rest/v1/devices' && method === 'GET') return devicesOf(searchParams)
  if (pathname === '/rest/v1/fleets' && ['GET', 'POST', 'PATCH'].includes(method)) {
    return fleets(state, method, searchParams, body)
  }
  for (const table of ['geofences', 'waylines']) {
    if (pathname === `/rest/v1/${table}` && ['GET', 'POST', 'PATCH'].includes(method)) {
      return plans(state[table], method, searchParams, body)
    }
  }
  if (pathname === '/rest/v1/rpc/organization_members' && (method === 'GET' || method === 'POST')) {
    const organization =
      typeof body.organization === 'string' ? body.organization : searchParams.get('organization')
    return { status: 200, payload: membersOf(organization) }
  }
  if (pathname === '/rest/v1/rpc/request_transition' && method === 'POST') {
    return requestTransition(app, body)
  }
  if (pathname === '/rest/v1/rpc/request_command' && method === 'POST') {
    return requestCommand(app, body)
  }
  if (pathname === '/rest/v1/telemetry_samples' && method === 'GET') {
    return telemetrySamples(state, searchParams)
  }
  const name = pathname.slice('/rest/v1/'.length)
  if (pathname.startsWith('/rest/v1/') && Object.hasOwn(state.tables, name)) {
    return operationTable(app, name, method, searchParams, body)
  }
  return { status: 404, payload: { message: `the demo has no ${method} ${pathname}` } }
}

/** GoTrue's password grant, and its refresh, so a long session keeps working. */
function token(state, grant, body) {
  if (grant === 'password') {
    const { email, password } = body
    if (!isText(email) || !isText(password)) return INVALID_CREDENTIALS
    return { status: 200, payload: session(state, { id: USER_ID, email }) }
  }
  if (grant === 'refresh_token') {
    const refresh = body.refresh_token
    const user = typeof refresh === 'string' ? state.refreshTokens.get(refresh) : undefined
    if (user === undefined) {
      return {
        status: 400,
        payload: {
          code: 'refresh_token_not_found',
          message: 'Invalid Refresh Token: Refresh Token Not Found',
        },
      }
    }
    state.refreshTokens.delete(refresh)
    return { status: 200, payload: session(state, user) }
  }
  return {
    status: 400,
    payload: {
      code: 'unsupported_grant_type',
      message: `the demo does not grant ${String(grant)}`,
    },
  }
}

function session(state, user) {
  const refresh = randomUUID()
  state.refreshTokens.set(refresh, user)
  const expiresAt = Math.floor(Date.now() / 1000) + LIFETIME_S
  return {
    access_token: unsignedJwt({
      aud: 'authenticated',
      exp: expiresAt,
      iss: 'supabase',
      role: 'authenticated',
      sub: user.id,
      email: user.email,
    }),
    token_type: 'bearer',
    expires_in: LIFETIME_S,
    expires_at: expiresAt,
    refresh_token: refresh,
    user: {
      id: user.id,
      aud: 'authenticated',
      role: 'authenticated',
      email: user.email,
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {},
    },
  }
}

function devicesOf(searchParams) {
  const organization = equals(searchParams.get('stacks.organization_id'))
  return { status: 200, payload: DEVICES_BY_ORGANIZATION.get(organization) ?? [] }
}

/**
 * The fleets table: GET the organization's live fleets, POST one (201 with the row), PATCH
 * one by id (its row in a list, or an empty list when there is none). A live aircraft
 * belongs to one fleet, as the unique index fleets_one_live_per_device makes it.
 */
function fleets(state, method, searchParams, body) {
  if (method === 'GET') {
    const organization = equals(searchParams.get('organization_id'))
    const rows = state.fleets
      .filter((fleet) => fleet.organization_id === organization && fleet.deleted_at === null)
      .sort((a, b) => a.name.localeCompare(b.name))
    return { status: 200, payload: rows }
  }
  if (method === 'POST') {
    if (taken(state, body.gateway_sn, body.aircraft_sn, null)) {
      return conflict(body.gateway_sn, body.aircraft_sn)
    }
    const now = new Date().toISOString()
    const row = {
      controller_serial: null,
      flight_time_before_soc_s: 0,
      ...body,
      id: randomUUID(),
      created_at: now,
      updated_at: now,
      deleted_at: null,
    }
    state.fleets.push(row)
    return { status: 201, payload: row }
  }
  const id = equals(searchParams.get('id'))
  const fleet = state.fleets.find((row) => row.id === id)
  if (fleet === undefined) return { status: 200, payload: [] }
  const changed = { ...fleet, ...body }
  if (
    changed.deleted_at === null &&
    taken(state, changed.gateway_sn, changed.aircraft_sn, fleet.id)
  ) {
    return conflict(changed.gateway_sn, changed.aircraft_sn)
  }
  Object.assign(fleet, body, { updated_at: new Date().toISOString() })
  return { status: 200, payload: [fleet] }
}

/**
 * A geofences or waylines table (database/migrations/0008): GET the organization's live
 * rows by name, POST one (201 with the row), PATCH one by id (its row in a list, or an
 * empty list when there is none, as row security answers). The checks are the console's
 * and the database's; the demo stores what it is given.
 */
function plans(rows, method, searchParams, body) {
  if (method === 'GET') {
    const organization = equals(searchParams.get('organization_id'))
    const live = rows
      .filter((row) => row.organization_id === organization && row.deleted_at === null)
      .sort((a, b) => a.name.localeCompare(b.name))
    return { status: 200, payload: live }
  }
  const now = new Date().toISOString()
  if (method === 'POST') {
    const row = { ...body, id: randomUUID(), created_at: now, updated_at: now, deleted_at: null }
    rows.push(row)
    return { status: 201, payload: row }
  }
  const id = equals(searchParams.get('id'))
  const row = rows.find((candidate) => candidate.id === id && candidate.deleted_at === null)
  if (row === undefined) return { status: 200, payload: [] }
  Object.assign(row, body, { updated_at: now })
  return { status: 200, payload: [row] }
}

/** The organization's members (soc.organization_members): the demo's one user, in its role there. */
function membersOf(organization) {
  const role = ORGANIZATIONS.find(({ id }) => id === organization)?.role
  return role === undefined
    ? []
    : [{ profile_id: USER_ID, display_name: null, email: DEMO_EMAIL, role }]
}

/** Whether the demo's user may write in an organization: an owner or an editor (IR-OPS). */
function canEdit(organization) {
  const role = ORGANIZATIONS.find(({ id }) => id === organization)?.role
  return role === 'owner' || role === 'editor'
}

/** The answer to a refusal the database raises (operation-tables.mjs). Any other error is a bug. */
function refusalOf(error) {
  if (error instanceof DatabaseError) return { status: error.status, payload: error.payload }
  throw error
}

/**
 * soc.request_transition: an editor asks an operation to move, and a pilot of it asks to simulate,
 * launch or stop. The database writes the request and its log entry; the lifecycle decides it.
 */
function requestTransition(app, body) {
  try {
    const { row, created } = app.db.requestTransition({
      operation: body.operation,
      wanted: body.wanted,
      clientRequest: body.client_request,
      me: USER_ID,
    })
    if (created) app.lifecycle.transitionAsked(row.id)
    return { status: 200, payload: row }
  } catch (error) {
    return refusalOf(error)
  }
}

/**
 * soc.request_command: a pilot of a flight's operation asks its aircraft a pilot's verb. The database
 * writes the intent and logs it; the lifecycle sends it to the stack and settles it.
 */
function requestCommand(app, body) {
  try {
    const { row, created } = app.db.requestCommand({
      flight: body.flight,
      wanted: body.wanted,
      clientRequest: body.client_request,
      me: USER_ID,
    })
    if (created) app.lifecycle.commandAsked(row.id)
    return { status: 200, payload: row }
  } catch (error) {
    return refusalOf(error)
  }
}

/** The operations' tables the console writes through PostgREST (migration 0010's grants). */
const WRITABLE = new Set(['operations', 'assignments', 'operators'])

/**
 * One of the operations' tables: GET the rows its filters keep; for the writable ones, POST one
 * (201 with the row), PATCH or DELETE the rows its filters keep (the list of those, empty when none).
 * The demo stores what it is given: the database's own checks are not repeated here. Each write is
 * broadcast as the database broadcasts it (operation-tables.mjs).
 */
function operationTable(app, name, method, searchParams, body) {
  const { state, db } = app
  if (method === 'GET') return { status: 200, payload: filtered(state, name, searchParams) }
  if (!WRITABLE.has(name)) {
    return { status: 405, payload: { message: `the demo does not write ${name}` } }
  }
  const rows = state.tables[name]
  const now = new Date().toISOString()
  if (method === 'POST') {
    const row = db.insertRow(name, { ...defaultsOf(name, now), ...body })
    return { status: 201, payload: row }
  }
  if (method !== 'PATCH' && method !== 'DELETE') {
    return { status: 405, payload: { message: `the demo does not ${method} ${name}` } }
  }
  const matched = filtered(state, name, searchParams)
  if (method === 'DELETE') {
    state.tables[name] = rows.filter((row) => !matched.includes(row))
    for (const row of matched) db.changed(name, row)
    return { status: 200, payload: matched }
  }
  for (const row of matched) {
    db.updateRow(name, row, Object.hasOwn(row, 'updated_at') ? { ...body, updated_at: now } : body)
  }
  return { status: 200, payload: matched }
}

/**
 * soc.telemetry_samples as PostgREST answers the console's track read: the flight's rows in
 * sampled_at order, the columns `select` names, the window `offset` and `limit` name, and never
 * more than ROW_CAP rows, as Supabase caps a response.
 */
function telemetrySamples(state, searchParams) {
  const flight = equals(searchParams.get('flight_id'))
  const select = searchParams.get('select')
  const columns = select === null ? null : select.split(',').map((column) => column.trim())
  const offset = Number(searchParams.get('offset') ?? 0)
  const limit = Number(searchParams.get('limit') ?? ROW_CAP)
  const page = state.telemetry
    .filter((row) => row.flight_id === flight)
    .sort((a, b) => Date.parse(a.sampled_at) - Date.parse(b.sampled_at))
    .slice(offset, offset + Math.min(limit, ROW_CAP))
  const payload = page.map((row) =>
    columns === null ? row : Object.fromEntries(columns.map((column) => [column, row[column]])),
  )
  return { status: 200, payload }
}

/** The columns a row gets from the database when it is inserted: its id, its state and its stamps. */
function defaultsOf(name, now) {
  if (name === 'operations') {
    return {
      id: randomUUID(),
      state: 'draft',
      end_reason: null,
      created_by: USER_ID,
      created_at: now,
      updated_at: now,
      started_at: null,
      ended_at: null,
    }
  }
  if (name === 'assignments')
    return { id: randomUUID(), speed_ms: null, flight: null, created_at: now }
  return {}
}

/** The rows a PostgREST query keeps: each `column=eq.value` filter must hold; select and order filter nothing. */
function filtered(state, name, searchParams) {
  const filters = [...searchParams].filter(
    ([column]) => !['select', 'order', 'limit', 'offset'].includes(column),
  )
  return state.tables[name].filter((row) =>
    filters.every(([column, filter]) => {
      const value = equals(filter)
      return value === null || String(columnOf(state, name, row, column)) === value
    }),
  )
}

/** A column of a row, or through its flight for `flights.operation_id`, the embedded filter of the console. */
function columnOf(state, name, row, column) {
  if (name === 'flight_states' && column === 'flights.operation_id') {
    return state.tables.flights.find(({ id }) => id === row.flight_id)?.operation_id
  }
  return row[column]
}

function taken(state, gatewaySn, aircraftSn, except) {
  return state.fleets.some(
    (fleet) =>
      fleet.id !== except &&
      fleet.deleted_at === null &&
      fleet.gateway_sn === gatewaySn &&
      fleet.aircraft_sn === aircraftSn,
  )
}

function conflict(gatewaySn, aircraftSn) {
  return {
    status: 409,
    payload: {
      code: '23505',
      message: 'duplicate key value violates unique constraint "fleets_one_live_per_device"',
      details: `Key (gateway_sn, aircraft_sn)=(${gatewaySn}, ${aircraftSn}) already exists.`,
      hint: null,
    },
  }
}

/** The value of a PostgREST filter such as `eq.<value>`, or null when there is none. */
function equals(filter) {
  return filter?.startsWith('eq.') ? filter.slice('eq.'.length) : null
}

const isText = (value) => typeof value === 'string' && value !== ''
