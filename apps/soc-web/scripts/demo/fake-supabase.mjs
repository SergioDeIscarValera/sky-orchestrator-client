// The demo's Supabase: the GoTrue and PostgREST calls the console makes, answered from
// memory, so `pnpm demo` runs the console with no server behind it (run.mjs). Fleets,
// geofences and waylines change in memory, and a restart resets them. Realtime is not faked: this server has
// no WebSocket upgrade, so the console shows no live telemetry and no change made from
// another console.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

const HOST = '127.0.0.1'
const CATALOGUE = new URL('../../../../contracts/catalogue/aircraft-models.json', import.meta.url)
const API_VERSION = '2024-01-01'
const LIFETIME_S = 3600
const DEFAULT_ALLOWED_HEADERS =
  'authorization, apikey, content-type, prefer, accept-profile, content-profile, x-client-info'
const INVALID_CREDENTIALS = {
  status: 400,
  payload: { code: 'invalid_credentials', message: 'Invalid login credentials' },
}

const NORTH = '11111111-1111-4111-8111-111111111111'
const ALMENDRAL = '22222222-2222-4222-8222-222222222222'
const NORTE_1 = '33333333-3333-4333-8333-333333333333'
const USER_ID = '6f1c2a52-34c5-4d7b-9a43-0b0f9e1d2c11'
const GATEWAY = 'SOTESTDOCK01'

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
  const waypoints = [
    [0, 60],
    [180, 60],
    [180, 140],
    [0, 140],
  ].map(([east, north], index) => ({ index, position: nearNorth(east, north), height_m: 30 }))
  return [
    {
      id: '55555555-5555-4555-8555-555555555555',
      organization_id: NORTH,
      name: 'North corridor',
      takeoff,
      default_height_m: 30,
      speed_ms: 5,
      design: {},
      waypoints,
      metrics: { waypoint_count: 4, distance_m: 580, duration_s: 116 },
      bake_version: '1',
      created_at: '2026-10-11T08:10:00+00:00',
      updated_at: '2026-10-11T08:10:00+00:00',
      deleted_at: null,
    },
  ]
}

/** A JWT-shaped string with a placeholder signature: the console reads only its payload. */
export function unsignedJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.sig`
}

/**
 * Starts the fake on 127.0.0.1 at `port`, 0 taking a free one. `url` is the address the
 * console is given as its Supabase URL; `close` stops the server and drops its connections.
 */
export function startFakeSupabase({ port = 0 } = {}) {
  const state = {
    fleets: seedFleets(),
    geofences: [],
    waylines: seedWaylines(),
    refreshTokens: new Map(),
  }
  const server = createServer((request, response) => {
    void answer(state, request, response)
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
            server.close((error) => (error ? failed(error) : done()))
            server.closeAllConnections()
          }),
      })
    })
  })
}

async function answer(state, request, response) {
  const headers = corsHeaders(request)
  try {
    if (request.method === 'OPTIONS') {
      send(response, 204, headers)
      return
    }
    const url = new URL(request.url ?? '/', `http://${HOST}`)
    const { status, payload } = route(
      state,
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
    'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
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

function route(state, method, url, body) {
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
