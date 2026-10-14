// @vitest-environment node
import { randomUUID } from 'node:crypto'

import {
  CHECK_ROW,
  COMMAND_ROW,
  EVENT_ROW,
  FLIGHT_STATE_ROW,
  TRANSITION_REQUEST_ROW,
} from '../../src/backend/operationRows'
import { z } from '../../src/schema'
import { sampleOf as consoleSampleOf } from '../../src/telemetry/sample'
import { startFakeSupabase, type FakeSupabase } from './fake-supabase.mjs'
import { demoSupabaseKey } from './run.mjs'

// The Realtime topic the console joins for the operations of Finca Norte (src/backend/supabaseFleets.ts).
const NORTH = '11111111-1111-4111-8111-111111111111'
const OPERATION = '66666666-6666-4666-8666-666666666666'
const ASSIGNMENT = '77777777-7777-4777-8777-777777777777'
const STATE_TOPIC = `realtime:org:${NORTH}:soc:state`
// The topic the console joins for the live telemetry of Finca Norte (src/backend/supabaseTelemetry.ts).
const TELEMETRY_TOPIC = `realtime:org:${NORTH}:soc:telemetry`
const OTHER_TOPIC = 'realtime:org:22222222-2222-4222-8222-222222222222:soc:state'

/** The state events of an operation: the seven the console's STATE_EVENTS lists for it. */
const OPERATION_EVENTS = [
  'operation',
  'flight',
  'flight_state',
  'operation_event',
  'transition_request',
  'operation_check',
  'command_intent',
]

/** Short timings, so a whole operation runs in well under a second of real time. */
const FAST = {
  claimMs: 2,
  decideMs: 8,
  commandStepMs: 3,
  progressTickMs: 4,
  taskMs: 40,
  telemetryTickMs: 3,
  takeOffMs: 6,
  landMs: 6,
  returnHomeMs: 10,
  readyMs: 4,
}

/** A frame of the Realtime protocol, vsn 2.0.0: [join_ref, ref, topic, event, payload]. */
const FRAME = z.tuple([z.unknown(), z.unknown(), z.string(), z.string(), z.unknown()])

/** A broadcast the server sent: its event name, and the row it carries. */
const BROADCAST = z.object({
  type: z.literal('broadcast'),
  event: z.string(),
  payload: z.record(z.string(), z.unknown()),
})

interface Reply {
  readonly status: number
  readonly payload: unknown
}

interface Broadcast {
  readonly event: string
  readonly payload: Record<string, unknown>
}

async function call(url: string, method: string, path: string, body?: unknown): Promise<Reply> {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  const payload: unknown = text === '' ? null : JSON.parse(text)
  return { status: response.status, payload }
}

/** A socket to the fake's Realtime, with every broadcast it receives kept in order. */
interface Listener {
  readonly socket: WebSocket
  readonly broadcasts: Broadcast[]
  join(topic: string): Promise<void>
  leave(topic: string): Promise<void>
}

async function listen(url: string): Promise<Listener> {
  const address = new URL('/realtime/v1/websocket', url)
  address.protocol = 'ws:'
  address.searchParams.set('apikey', demoSupabaseKey())
  address.searchParams.set('vsn', '2.0.0')
  const socket = new WebSocket(address)
  const broadcasts: Broadcast[] = []
  const replies = new Map<string, () => void>()
  socket.addEventListener('message', (event: MessageEvent<string>) => {
    const frame = FRAME.safeParse(JSON.parse(event.data))
    if (!frame.success) return
    const [, , topic, name, body] = frame.data
    if (name === 'phx_reply') {
      replies.get(topic)?.()
      return
    }
    const broadcast = BROADCAST.safeParse(body)
    if (name === 'broadcast' && broadcast.success) {
      broadcasts.push({ event: broadcast.data.event, payload: broadcast.data.payload })
    }
  })
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener(
      'open',
      () => {
        resolve()
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
  const send = (topic: string, event: string): Promise<void> =>
    new Promise<void>((resolve) => {
      replies.set(topic, resolve)
      socket.send(JSON.stringify(['1', '1', topic, event, { config: { private: true } }]))
    })
  return {
    socket,
    broadcasts,
    join: (topic) => send(topic, 'phx_join'),
    leave: (topic) => send(topic, 'phx_leave'),
  }
}

/** Resolves once `predicate` holds, polling every few milliseconds; fails after five seconds. */
async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 3))
  }
}

/** The operation's state as the console reads it through PostgREST. */
async function stateOf(url: string): Promise<unknown> {
  const parsed = z
    .array(z.record(z.string(), z.unknown()))
    .safeParse((await call(url, 'GET', `/rest/v1/operations?id=eq.${OPERATION}`)).payload)
  return parsed.success ? parsed.data[0]?.state : undefined
}

/** The operation's height, and its one assignment's speed and flight: what a plan needs of them. */
async function makeFlyable(url: string): Promise<void> {
  await call(url, 'PATCH', `/rest/v1/operations?id=eq.${OPERATION}`, {
    takeoff_security_height_m: 30,
  })
  await call(url, 'PATCH', `/rest/v1/assignments?id=eq.${ASSIGNMENT}`, {
    speed_ms: 5,
    flight: {
      schema_version: '2.2.0',
      waypoints: [
        { index: 0, position: [-4.7245, 41.6523], height_m: 30 },
        { index: 1, position: [-4.72, 41.653], height_m: 30 },
        { index: 2, position: [-4.7195, 41.654], height_m: 30 },
      ],
    },
  })
}

/** A member asks a transition through the RPC, as the console does. */
function ask(url: string, wanted: string): Promise<Reply> {
  return call(url, 'POST', '/rest/v1/rpc/request_transition', {
    operation: OPERATION,
    wanted,
    client_request: randomUUID(),
  })
}

let fake: FakeSupabase
let listeners: Listener[] = []

/** A socket listening to the state topic of Finca Norte, kept until the test ends. */
async function listenTo(topic: string): Promise<Listener> {
  const listener = await listen(fake.url)
  listeners.push(listener)
  await listener.join(topic)
  return listener
}

beforeEach(async () => {
  fake = await startFakeSupabase({ port: 0, timings: FAST })
})

afterEach(async () => {
  for (const listener of listeners) listener.socket.close()
  listeners = []
  await fake.close()
})

describe('the operations broadcast on the state topic, as the database does', () => {
  it('sends the console every change to an operation, each one parsing as the console reads it', async () => {
    const client = await listenTo(STATE_TOPIC)
    await makeFlyable(fake.url)
    expect((await ask(fake.url, 'plan')).status).toBe(200)
    await waitFor(async () => (await stateOf(fake.url)) === 'planned', 'planned')
    await ask(fake.url, 'prepare')
    await waitFor(async () => (await stateOf(fake.url)) === 'preparing', 'preparing')
    await ask(fake.url, 'simulate')
    await waitFor(
      () =>
        client.broadcasts.some(
          (each) => each.event === 'operation' && each.payload.state === 'simulated',
        ),
      'the simulated broadcast',
    )

    const events = new Set(client.broadcasts.map((each) => each.event))
    expect([...events].sort()).toEqual([...OPERATION_EVENTS].sort())
    for (const { event, payload } of client.broadcasts) {
      if (event === 'transition_request')
        expect(TRANSITION_REQUEST_ROW.safeParse(payload).success).toBe(true)
      if (event === 'command_intent') expect(COMMAND_ROW.safeParse(payload).success).toBe(true)
      if (event === 'flight_state') expect(FLIGHT_STATE_ROW.safeParse(payload).success).toBe(true)
      if (event === 'operation_check') expect(CHECK_ROW.safeParse(payload).success).toBe(true)
      if (event === 'operation_event') expect(EVENT_ROW.safeParse(payload).success).toBe(true)
      if (event === 'operation') {
        expect(Object.keys(payload).sort()).toEqual(['end_reason', 'id', 'state', 'updated_at'])
      }
    }
    expect(client.broadcasts.filter((each) => each.event === 'operation_check')).toHaveLength(16)
    const logged = client.broadcasts
      .filter((each) => each.event === 'operation_event')
      .map((each) => each.payload.kind)
    expect(logged).toContain('operation_state_changed')
    expect(logged).toContain('checks_at_simulation')
  })

  it('answers a request with the row the database inserted, pending and not yet decided', async () => {
    const reply = await ask(fake.url, 'cancel')
    expect(reply.status).toBe(200)
    expect(reply.payload).toMatchObject({
      transition: 'cancel',
      status: 'pending',
      reasons: null,
      decided_at: null,
    })
    await waitFor(async () => (await stateOf(fake.url)) === 'cancelled', 'cancelled')
  })

  it('sends a broadcast to a socket joined to the state topic, and none to one joined elsewhere', async () => {
    const member = await listenTo(STATE_TOPIC)
    const stranger = await listenTo(OTHER_TOPIC)
    await makeFlyable(fake.url)
    await ask(fake.url, 'plan')
    await waitFor(async () => (await stateOf(fake.url)) === 'planned', 'planned')
    expect(member.broadcasts.length).toBeGreaterThan(0)
    expect(stranger.broadcasts).toEqual([])
  })

  it('stops sending broadcasts to a socket that has left the state topic', async () => {
    const member = await listenTo(STATE_TOPIC)
    const leaver = await listenTo(STATE_TOPIC)
    await leaver.leave(STATE_TOPIC)
    await makeFlyable(fake.url)
    await ask(fake.url, 'plan')
    await waitFor(async () => (await stateOf(fake.url)) === 'planned', 'planned')
    expect(member.broadcasts.length).toBeGreaterThan(0)
    expect(leaver.broadcasts).toEqual([])
  })

  it("refuses a request on a closed operation with the database's status and message", async () => {
    await ask(fake.url, 'cancel')
    await waitFor(async () => (await stateOf(fake.url)) === 'cancelled', 'cancelled')
    const refused = await ask(fake.url, 'plan')
    expect(refused.status).toBe(400)
    expect(refused.payload).toMatchObject({
      code: '23514',
      message: `operation ${OPERATION}: closed when it became cancelled`,
    })
  })

  it('refuses a stranger who asks an operation to move, as the database does', async () => {
    const refused = await call(fake.url, 'POST', '/rest/v1/rpc/request_transition', {
      operation: '99999999-9999-4999-8999-999999999999',
      wanted: 'plan',
      client_request: randomUUID(),
    })
    expect(refused.status).toBe(403)
    expect(refused.payload).toMatchObject({ code: '42501' })
  })
})

/** A flight of the operation as PostgREST answers it: when it executed, and when it ended. */
const FLIGHT = z.object({ id: z.string(), executed_at: z.string(), ended_at: z.string() })

/** A sample of a flight's track, as the console's track read selects it (FR-TEL-05). */
const TRACK_SAMPLE = z.object({
  sampled_at: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  height_m: z.number(),
})

/** The operation's flights, in the order they were prepared. */
async function flightsOf(url: string): Promise<z.infer<typeof FLIGHT>[]> {
  const path = `/rest/v1/flights?operation_id=eq.${OPERATION}`
  const parsed = z.array(FLIGHT).safeParse((await call(url, 'GET', path)).payload)
  if (!parsed.success) throw new Error('the flights are not a list of flights')
  return parsed.data
}

/** A flight's track, asked for as the console asks for it: its samples in time order. */
async function trackOf(url: string, flight: string): Promise<z.infer<typeof TRACK_SAMPLE>[]> {
  const path = `/rest/v1/telemetry_samples?flight_id=eq.${flight}&select=sampled_at,latitude,longitude,height_m&order=sampled_at.asc`
  const parsed = z.array(TRACK_SAMPLE).safeParse((await call(url, 'GET', path)).payload)
  if (!parsed.success) throw new Error('the track is not a list of samples')
  return parsed.data
}

describe("the aircraft's telemetry, sent on its topic and stored as its flight's track (FR-TEL-01, FR-TEL-05)", () => {
  it("sends the aircraft's samples to a socket joined to the telemetry topic, each one parsing as the console reads it", async () => {
    const client = await listenTo(TELEMETRY_TOPIC)
    await waitFor(() => client.broadcasts.length >= 3, 'three samples')
    for (const { event, payload } of client.broadcasts) {
      expect(event).toBe('sample')
      expect(consoleSampleOf(payload)).not.toBeNull()
      expect(payload).toMatchObject({
        stack: 'lab',
        gateway_sn: 'SOTESTDOCK01',
        aircraft_sn: '1WNBH9E00A0042',
      })
    }
  })

  it("stores each flight's samples as its track, in time order, a simulation's apart from a launch's", async () => {
    await makeFlyable(fake.url)
    await ask(fake.url, 'plan')
    await waitFor(async () => (await stateOf(fake.url)) === 'planned', 'planned')
    await ask(fake.url, 'prepare')
    await waitFor(async () => (await stateOf(fake.url)) === 'preparing', 'preparing')
    await ask(fake.url, 'simulate')
    await waitFor(async () => (await stateOf(fake.url)) === 'ready', 'ready after the simulation')
    await ask(fake.url, 'launch')
    await waitFor(async () => (await stateOf(fake.url)) === 'completed', 'completed')

    const [simulated, launched] = await flightsOf(fake.url)
    if (simulated === undefined || launched === undefined) throw new Error('two flights were flown')
    const simulation = await trackOf(fake.url, simulated.id)
    const launch = await trackOf(fake.url, launched.id)
    expect(simulation.length).toBeGreaterThan(0)
    expect(launch.length).toBeGreaterThan(0)
    for (const track of [simulation, launch]) {
      const times = track.map((sample) => Date.parse(sample.sampled_at))
      expect(times).toEqual([...times].sort((a, b) => a - b))
      expect(new Set(times).size).toBe(times.length)
    }
    // Each track lies within its own flight, from its execute until it ended.
    for (const sample of simulation) {
      expect(sample.sampled_at >= simulated.executed_at).toBe(true)
      expect(sample.sampled_at <= simulated.ended_at).toBe(true)
    }
    for (const sample of launch) {
      expect(sample.sampled_at >= launched.executed_at).toBe(true)
      expect(sample.sampled_at <= launched.ended_at).toBe(true)
    }
    expect(simulated.ended_at <= launched.executed_at).toBe(true)
  })
})
