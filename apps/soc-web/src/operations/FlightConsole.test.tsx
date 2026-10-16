import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'

import {
  BackendError,
  type CommandIntent,
  type Flight,
  type FlightState,
  type FlightStatus,
  type Operation,
  type OperationState,
} from '../backend/backend'
import { flightToJson } from '../geometry/designJson'
import { bake, type Design } from '../geometry/bake'
import { planFlight } from '../geometry/flight'
import { geodeticAt, type Geodetic } from '../geometry/projection'
import { draftOf } from '../plans/waylines'
import { FakeBackend, MAVIC_AIR_2, NEIGHBOUR, NORTH } from '../test/FakeBackend'
import { operationIn } from '../test/inOrganization'
import { renderApp } from '../test/render'
import { HOLD_MS } from './HoldButton'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const STATES: readonly OperationState[] = [
  'draft',
  'planned',
  'preparing',
  'simulating',
  'simulated',
  'ready',
  'launching',
  'in_flight',
  'paused',
  'returning',
  'completed',
  'aborted',
  'failed',
  'cancelled',
]

/** The states the console shows in (FR-CMD-01): a flight is prepared, executing or in the air. */
const FLYING: readonly OperationState[] = [
  'simulating',
  'launching',
  'in_flight',
  'paused',
  'returning',
]

const FLIGHT_ID = '5d9c2a6e-3f1b-4a7c-9e2d-0000000000f1'
const OLD_FLIGHT_ID = '5d9c2a6e-3f1b-4a7c-9e2d-0000000000f0'
const FLEET_ID = '1f0c9d3e-7b1a-4c2e-8f5d-000000000001'

/** The corridor a flight is stored from: a climb and a route, as the designer bakes it (FR-OPS-01). */
const FARM: Geodetic = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
const at = (east: number, north: number) => geodeticAt(FARM, { eastM: east, northM: north })
const DESIGN: Design = {
  takeoff: at(0, 0),
  defaultHeightM: 30,
  primitives: [{ kind: 'route', points: [at(0, 50), at(100, 50)] }],
}
const BAKED = bake(DESIGN, { origin: FARM, maxArcSpacingM: 10 })

const FLEET = {
  name: 'Norte 1',
  model: MAVIC_AIR_2.model,
  airframeSerial: '1WNBH9',
  controllerSerial: null,
  gatewaySn: 'SOTESTDOCK01',
  aircraftSn: 'SOTESTUAV001',
  flightTimeBeforeSocS: 5400,
}

/** The moves that reach a flying state from a draft, as the lifecycle allows them (FR-OPS-02). */
const PATH: Partial<Record<OperationState, readonly OperationState[]>> = {
  simulating: ['planned', 'preparing', 'simulating'],
  in_flight: ['planned', 'preparing', 'simulating', 'simulated', 'ready', 'launching', 'in_flight'],
  paused: [
    'planned',
    'preparing',
    'simulating',
    'simulated',
    'ready',
    'launching',
    'in_flight',
    'paused',
  ],
  returning: [
    'planned',
    'preparing',
    'simulating',
    'simulated',
    'ready',
    'launching',
    'in_flight',
    'returning',
  ],
}

/** A flight of the operation, prepared and executed, unless the test says otherwise. */
function flightOf(operation: Operation, changes: Partial<Flight> = {}): Flight {
  return {
    id: FLIGHT_ID,
    operationId: operation.id,
    mode: 'simulated',
    fleetId: FLEET_ID,
    gatewaySn: 'SOTESTDOCK01',
    aircraftSn: 'SOTESTUAV001',
    preparedAt: '2026-10-11T10:00:00Z',
    executedAt: '2026-10-11T10:01:00Z',
    tookOffAt: null,
    landedAt: null,
    endedAt: null,
    endReason: null,
    breachedAt: null,
    ...changes,
  }
}

/** The stack's latest word on a flight: in progress at 42 % on the fourth waypoint, unless the test says otherwise. */
function progressOf(changes: Partial<FlightState> = {}): FlightState {
  return {
    flightId: FLIGHT_ID,
    status: 'in_progress',
    result: null,
    percent: 42,
    currentWaypointIndex: 3,
    endReason: null,
    updatedAt: '2026-10-11T10:02:00Z',
    ...changes,
  }
}

function commandOf(changes: Partial<CommandIntent> = {}): CommandIntent {
  return {
    id: '00000000-0000-4000-d000-000000000001',
    operationId: '',
    flightId: FLIGHT_ID,
    verb: 'pause',
    status: 'accepted',
    result: 0,
    requestedBy: null,
    requestedAt: '2026-10-11T10:05:00Z',
    sentAt: null,
    repliedAt: null,
    ...changes,
  }
}

/**
 * An operation of North in `state`, its operators named as the pilots given, with its flight of
 * `flight` changes, and the stack's progress of `progress` (none when it is null).
 */
async function flyingOperation(
  backend: FakeBackend,
  state: OperationState,
  {
    pilots = [NEIGHBOUR.userId],
    flight = {},
    progress = progressOf(),
  }: {
    readonly pilots?: readonly string[]
    readonly flight?: Partial<Flight> | null
    readonly progress?: Partial<FlightState> | null
  } = {},
): Promise<Operation> {
  const operation = await operationIn(backend, state, pilots)
  if (flight !== null) backend.addFlight(flightOf(operation, flight))
  if (progress !== null) backend.setFlightState(progressOf(progress))
  return operation
}

/**
 * An operation flown by the corridor's stored flight, so the console reads its waypoint count from the
 * assignment, as it does for a real operation.
 */
async function operationWithStoredFlight(backend: FakeBackend, state: 'in_flight' | 'simulating') {
  const fleet = await backend.registerFleet(NORTH.id, FLEET)
  const wayline = await backend.createWayline(NORTH.id, draftOf('North corridor', DESIGN, BAKED))
  const operation = await backend.createOperation(NORTH.id, {
    name: 'North corridor',
    geofenceId: null,
    takeoffSecurityHeightM: 30,
  })
  const stored = planFlight(DESIGN.takeoff, BAKED, {
    origin: FARM,
    takeoffSecurityHeightM: 30,
    speedMs: 5,
    finishAction: 'return_home',
    envelope: null,
  })
  await backend.assign(operation.id, NORTH.id, {
    waylineId: wayline.id,
    fleetId: fleet.id,
    speedMs: 5,
    flight: flightToJson(stored),
  })
  backend.operatorRows.set(operation.id, [
    { operationId: operation.id, profileId: NEIGHBOUR.userId, role: 'pilot' },
  ])
  let current = operation
  for (const step of PATH[state] ?? []) current = backend.moveOperation(operation.id, step)
  return { operation: current, waypoints: stored.waypoints.length }
}

/** Opens the operation in the inspector, as a member does, and waits for the console to show. */
async function openOperation(backend: FakeBackend, operation: Operation) {
  window.history.replaceState(null, '', `/?operation=${operation.id}`)
  const rendered = renderApp(backend)
  await screen.findByRole('banner')
  const inspector = await screen.findByRole('complementary', { name: 'Inspector' })
  await within(inspector).findByRole('heading', { name: operation.name })
  return { ...rendered, inspector }
}

async function consoleOf(inspector: HTMLElement) {
  return within(inspector).findByRole('region', { name: 'Flight console' })
}

/** The button names of the commands the console offers, in the order it shows them. */
function commandsOffered(consoleElement: HTMLElement): string[] {
  const group = within(consoleElement).queryByRole('group', { name: 'Flight commands' })
  if (group === null) return []
  return within(group)
    .queryAllByRole('button')
    .map((button) => button.textContent)
}

/**
 * Lets the page's promises settle on the fake clock, so the mutations the test asked finish: their
 * answers reach the page on the query client's own short timers.
 */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5)
  })
}

/** Holds a button for `ms` on the fake clock, then lets it go, as a pilot's press does. */
async function hold(button: HTMLElement, ms = HOLD_MS) {
  fireEvent.pointerDown(button, { button: 0 })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
  fireEvent.pointerUp(button, { button: 0 })
  await settle()
}

/** The clock the holds run on: only the timers the holds and the test's waits use are faked. */
function freezeClock() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
}

afterEach(() => {
  vi.useRealTimers()
  window.history.replaceState(null, '', '/')
})

describe('the flight console in an operation (FR-CMD-01, FR-SAF-04)', () => {
  it.each(STATES)('shows the console only while the operation is %s if it flies', async (state) => {
    const backend = new FakeBackend(NEIGHBOUR)
    const operation = await flyingOperation(backend, state)
    const { inspector } = await openOperation(backend, operation)
    if (FLYING.includes(state)) {
      await consoleOf(inspector)
    } else {
      expect(within(inspector).queryByRole('region', { name: 'Flight console' })).toBeNull()
    }
  })

  it("sits under the operation's steps and moves, above its drones and its definition", async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const operation = await flyingOperation(backend, 'in_flight')
    const { inspector } = await openOperation(backend, operation)
    const steps = within(inspector).getByRole('list', { name: 'Steps' })
    const consoleElement = await consoleOf(inspector)
    const drones = within(inspector).getByRole('region', { name: 'Drones' })
    const follows = (a: Node, b: Node) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    expect(follows(steps, consoleElement)).toBe(true)
    expect(follows(consoleElement, drones)).toBe(true)
  })
})

describe('the mode of the flight, unmistakable (FR-SAF-04)', () => {
  it.each([
    ['simulated', 'Simulated flight', 'bg-info-subtle'],
    ['real', 'Real flight', 'bg-danger-subtle'],
  ] as const)('names a %s flight %s, in its tone', async (mode, words, tone) => {
    const backend = new FakeBackend(NEIGHBOUR)
    const operation = await flyingOperation(backend, 'in_flight', { flight: { mode } })
    const { inspector } = await openOperation(backend, operation)
    const banner = within(await consoleOf(inspector)).getByRole('status')
    expect(banner).toHaveTextContent(words)
    expect(banner).toHaveAttribute('data-mode', mode)
    expect(banner).toHaveClass(tone)
  })

  it('names the latest flight that has not ended, though an ended flight was prepared after it', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const operation = await flyingOperation(backend, 'in_flight', {
      flight: { mode: 'simulated' },
      progress: null,
    })
    backend.addFlight(
      flightOf(operation, {
        id: OLD_FLIGHT_ID,
        mode: 'real',
        preparedAt: '2026-10-11T11:00:00Z',
        executedAt: '2026-10-11T11:01:00Z',
        endedAt: '2026-10-11T11:30:00Z',
        endReason: 'completed',
      }),
    )
    const { inspector } = await openOperation(backend, operation)
    expect(within(await consoleOf(inspector)).getByRole('status')).toHaveTextContent(
      'Simulated flight',
    )
  })

  it('reads an operation with no flight to fly as a mode unknown, never as one of the two', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const operation = await flyingOperation(backend, 'simulating', { flight: null, progress: null })
    const { inspector } = await openOperation(backend, operation)
    const banner = within(await consoleOf(inspector)).getByRole('status')
    expect(banner).toHaveTextContent('Mode unknown')
    expect(banner).not.toHaveTextContent('Simulated')
    expect(banner).not.toHaveTextContent('Real')
  })
})

describe("a flight's progress, unavailable when the stack has not said (FR-SAF-03)", () => {
  it('shows the status in words, the percent as a bar, and the waypoint as n of the stored flight', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const { operation, waypoints } = await operationWithStoredFlight(backend, 'in_flight')
    backend.addFlight(flightOf(operation))
    backend.setFlightState(progressOf())
    const { inspector } = await openOperation(backend, operation)
    const consoleElement = await consoleOf(inspector)
    expect(within(consoleElement).getByText('In progress')).toBeVisible()
    const bar = within(consoleElement).getByRole('progressbar', { name: 'Progress' })
    expect(bar).toHaveAttribute('aria-valuenow', '42')
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '100')
    expect(within(consoleElement).getByText('42%')).toBeVisible()
    expect(within(consoleElement).getByText('Waypoint').nextElementSibling).toHaveTextContent(
      `4 / ${String(waypoints)}`,
    )
  })

  it('shows what the stack has not said as unavailable, with no bar and never a zero', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const operation = await flyingOperation(backend, 'in_flight', {
      progress: { percent: null, currentWaypointIndex: null, status: 'sent' },
    })
    const { inspector } = await openOperation(backend, operation)
    const consoleElement = await consoleOf(inspector)
    expect(within(consoleElement).queryByRole('progressbar')).toBeNull()
    expect(consoleElement).not.toHaveTextContent('0%')
    expect(within(consoleElement).getByText('Waypoint').nextElementSibling).toHaveTextContent(
      'Unavailable / Unavailable',
    )
  })

  it('shows a flight the stack has not reported at all with its status unavailable', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const operation = await flyingOperation(backend, 'in_flight', { progress: null })
    const { inspector } = await openOperation(backend, operation)
    const consoleElement = await consoleOf(inspector)
    expect(within(consoleElement).getByText('Status').nextElementSibling).toHaveTextContent(
      'Unavailable',
    )
    expect(within(consoleElement).queryByRole('progressbar')).toBeNull()
  })
})

const OFFERS: readonly {
  readonly case: string
  readonly state: OperationState
  readonly flight: Partial<Flight>
  readonly status: FlightStatus | null
  readonly offered: readonly string[]
}[] = [
  {
    case: 'in progress, executed, in flight',
    state: 'in_flight',
    flight: {},
    status: 'in_progress',
    offered: ['Pause', 'Return home', 'Stop'],
  },
  {
    case: 'paused, executed, in flight',
    state: 'paused',
    flight: {},
    status: 'paused',
    offered: ['Resume', 'Return home', 'Stop'],
  },
  {
    case: 'in progress while returning, where the operation offers no stop',
    state: 'returning',
    flight: {},
    status: 'in_progress',
    offered: ['Pause', 'Return home'],
  },
  {
    case: 'sent but not executed, launching: only undo',
    state: 'launching',
    flight: { executedAt: null },
    status: 'sent',
    offered: ['Undo'],
  },
  {
    case: 'prepared in the simulator and not executing: only undo',
    state: 'simulating',
    flight: { executedAt: null },
    status: null,
    offered: ['Undo'],
  },
  {
    case: 'executing in the simulator: pause and return home, no stop while simulating',
    state: 'simulating',
    flight: {},
    status: 'in_progress',
    offered: ['Pause', 'Return home'],
  },
  {
    case: 'executed with no progress reported: return home and stop',
    state: 'in_flight',
    flight: {},
    status: null,
    offered: ['Return home', 'Stop'],
  },
]

describe('the commands a flight offers in its state (FR-CMD-02 to FR-CMD-05)', () => {
  it.each(OFFERS)('offers $case, and nothing else', async ({ state, flight, status, offered }) => {
    const backend = new FakeBackend(NEIGHBOUR)
    const operation = await flyingOperation(backend, state, {
      flight,
      progress: status === null ? null : { status },
    })
    const { inspector } = await openOperation(backend, operation)
    expect(commandsOffered(await consoleOf(inspector))).toEqual(offered)
  })
})

describe('sending a command: held to confirm, once, with a fresh request id (FR-CMD-07)', () => {
  it('sends a pause once per completed hold, each with a client request id of its own', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const operation = await flyingOperation(backend, 'in_flight', {
      progress: { status: 'in_progress' },
    })
    const ask = vi.spyOn(backend, 'requestCommand')
    const { inspector } = await openOperation(backend, operation)
    const consoleElement = await consoleOf(inspector)
    freezeClock()
    const pause = within(consoleElement).getByRole('button', { name: 'Pause' })
    await hold(pause)
    await hold(pause)
    expect(ask).toHaveBeenCalledTimes(2)
    const [first, second] = ask.mock.calls
    expect(first?.[0]).toBe(FLIGHT_ID)
    expect(first?.[1]).toBe('pause')
    expect(first?.[2]).toMatch(UUID)
    expect(second?.[2]).toMatch(UUID)
    expect(second?.[2]).not.toBe(first?.[2])
  })

  it('sends nothing on a click, nor on a press let go before the hold completes', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const operation = await flyingOperation(backend, 'in_flight', {
      progress: { status: 'in_progress' },
    })
    const ask = vi.spyOn(backend, 'requestCommand')
    const { inspector } = await openOperation(backend, operation)
    const consoleElement = await consoleOf(inspector)
    freezeClock()
    const pause = within(consoleElement).getByRole('button', { name: 'Pause' })
    fireEvent.pointerDown(pause, { button: 0 })
    fireEvent.pointerUp(pause, { button: 0 })
    fireEvent.click(pause, { button: 0 })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_MS * 2)
    })
    fireEvent.pointerDown(pause, { button: 0 })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_MS - 100)
    })
    fireEvent.pointerUp(pause, { button: 0 })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_MS * 2)
    })
    expect(ask).not.toHaveBeenCalled()
  })

  it('sends nothing by itself while the flight flies and its telemetry is absent (FR-SAF-06)', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const operation = await flyingOperation(backend, 'in_flight', {
      progress: { status: 'in_progress' },
    })
    const ask = vi.spyOn(backend, 'requestCommand')
    const { inspector } = await openOperation(backend, operation)
    await consoleOf(inspector)
    freezeClock()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(ask).not.toHaveBeenCalled()
  })

  it('sends Resume as the recovery verb, and Return home as return_home', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const paused = await flyingOperation(backend, 'paused', {
      progress: { status: 'paused' },
    })
    const ask = vi.spyOn(backend, 'requestCommand')
    const { inspector } = await openOperation(backend, paused)
    const consoleElement = await consoleOf(inspector)
    freezeClock()
    await hold(within(consoleElement).getByRole('button', { name: 'Resume' }))
    expect(ask.mock.calls.map(([, verb]) => verb)).toEqual(['recovery'])
    await hold(within(consoleElement).getByRole('button', { name: 'Return home' }))
    expect(ask.mock.calls.map(([, verb]) => verb)).toEqual(['recovery', 'return_home'])
  })

  it('sends Undo as undo only while the flight is not executing', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const operation = await flyingOperation(backend, 'launching', {
      flight: { executedAt: null },
      progress: null,
    })
    const ask = vi.spyOn(backend, 'requestCommand')
    const { inspector } = await openOperation(backend, operation)
    const consoleElement = await consoleOf(inspector)
    freezeClock()
    await hold(within(consoleElement).getByRole('button', { name: 'Undo' }))
    expect(ask.mock.calls.map(([, verb]) => verb)).toEqual(['undo'])
  })

  it('sends Stop through the stop transition, which the operation records as its request', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const operation = await flyingOperation(backend, 'in_flight', {
      progress: { status: 'in_progress' },
    })
    const ask = vi.spyOn(backend, 'requestTransition')
    const { inspector } = await openOperation(backend, operation)
    const consoleElement = await consoleOf(inspector)
    freezeClock()
    await hold(within(consoleElement).getByRole('button', { name: 'Stop' }))
    expect(ask).toHaveBeenCalledOnce()
    const [operationId, transition, clientRequestId] = ask.mock.calls[0] ?? []
    expect(operationId).toBe(operation.id)
    expect(transition).toBe('stop')
    expect(clientRequestId).toMatch(UUID)
    expect(await backend.requests(operation.id)).toHaveLength(1)
  })

  it('withholds every command from a viewer, saying Editors only, and sends none', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const operation = await flyingOperation(backend, 'in_flight', {
      progress: { status: 'in_progress' },
    })
    // Written as an owner, the operation is made; the member's role is then a viewer's.
    backend.memberships.set(NEIGHBOUR.userId, [{ ...NORTH, role: 'viewer' }])
    const ask = vi.spyOn(backend, 'requestCommand')
    const transitions = vi.spyOn(backend, 'requestTransition')
    const { inspector } = await openOperation(backend, operation)
    const consoleElement = await consoleOf(inspector)
    freezeClock()
    for (const name of ['Pause', 'Return home', 'Stop']) {
      const button = within(consoleElement).getByRole('button', { name })
      expect(button).toHaveAttribute('aria-disabled', 'true')
      expect(button).toHaveAccessibleDescription('Editors only')
      await hold(button)
    }
    expect(ask).not.toHaveBeenCalled()
    expect(transitions).not.toHaveBeenCalled()
  })

  it('withholds every command from an editor who is not a pilot, saying Pilots only', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    backend.memberships.set(NEIGHBOUR.userId, [{ ...NORTH, role: 'editor' }])
    const operation = await flyingOperation(backend, 'in_flight', {
      pilots: [],
      progress: { status: 'in_progress' },
    })
    const ask = vi.spyOn(backend, 'requestCommand')
    const { inspector } = await openOperation(backend, operation)
    const consoleElement = await consoleOf(inspector)
    freezeClock()
    const pause = within(consoleElement).getByRole('button', { name: 'Pause' })
    expect(pause).toHaveAttribute('title', 'Pilots only')
    expect(pause).toHaveAccessibleDescription('Pilots only')
    await hold(pause)
    expect(ask).not.toHaveBeenCalled()
  })

  it('shows a refused command as the alert the database gave, and offers the buttons again', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const operation = await flyingOperation(backend, 'in_flight', {
      progress: { status: 'in_progress' },
    })
    vi.spyOn(backend, 'requestCommand').mockRejectedValueOnce(
      new BackendError('Sky Orchestrator is down'),
    )
    const { inspector } = await openOperation(backend, operation)
    const consoleElement = await consoleOf(inspector)
    freezeClock()
    await hold(within(consoleElement).getByRole('button', { name: 'Pause' }))
    expect(within(consoleElement).getByRole('alert')).toHaveTextContent('Sky Orchestrator is down')
    expect(within(consoleElement).getByRole('button', { name: 'Pause' })).toBeEnabled()
  })
})

describe("the commands' feed, newest first (FR-CMD-06)", () => {
  it('lists the commands newest first, with each verb, its status and who asked it', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const operation = await flyingOperation(backend, 'in_flight', {
      progress: { status: 'in_progress' },
    })
    backend.commandRows.set(operation.id, [
      commandOf({
        id: '00000000-0000-4000-d000-00000000000a',
        operationId: operation.id,
        verb: 'pause',
        status: 'accepted',
        requestedBy: NEIGHBOUR.userId,
        requestedAt: '2026-10-11T10:00:00Z',
      }),
      commandOf({
        id: '00000000-0000-4000-d000-00000000000b',
        operationId: operation.id,
        verb: 'return_home',
        status: 'sent',
        requestedBy: null,
        requestedAt: '2026-10-11T10:05:00Z',
      }),
      commandOf({
        id: '00000000-0000-4000-d000-00000000000c',
        operationId: operation.id,
        verb: 'recovery',
        status: 'pending',
        requestedBy: NEIGHBOUR.userId,
        requestedAt: '2026-10-11T10:03:00Z',
      }),
    ])
    const { inspector } = await openOperation(backend, operation)
    const feed = within(await consoleOf(inspector)).getByRole('log', { name: 'Commands' })
    expect(
      within(feed)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Return homeSentSOC',
      'ResumePendingneighbour@farm.test',
      'PauseAcceptedneighbour@farm.test',
    ])
  })

  it.each([
    ['pending', 'Pending'],
    ['sent', 'Sent'],
    ['accepted', 'Accepted'],
    ['refused', 'Refused'],
    ['failed', 'Failed'],
    ['timed_out', 'Timed out'],
    ['expired', 'Expired'],
  ] as const)('says a %s command %s', async (status, words) => {
    const backend = new FakeBackend(NEIGHBOUR)
    const operation = await flyingOperation(backend, 'in_flight', {
      progress: { status: 'in_progress' },
    })
    backend.commandRows.set(operation.id, [commandOf({ operationId: operation.id, status })])
    const { inspector } = await openOperation(backend, operation)
    const feed = within(await consoleOf(inspector)).getByRole('log', { name: 'Commands' })
    expect(within(feed).getByText(words)).toBeVisible()
  })

  it("says a refused command's meaning with its code, and none for a reply with no code", async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const operation = await flyingOperation(backend, 'in_flight', {
      progress: { status: 'in_progress' },
    })
    backend.commandRows.set(operation.id, [
      commandOf({
        id: '00000000-0000-4000-d000-00000000000e',
        operationId: operation.id,
        verb: 'recovery',
        status: 'refused',
        result: 319999,
        requestedAt: '2026-10-11T10:06:00Z',
      }),
      commandOf({
        id: '00000000-0000-4000-d000-00000000000f',
        operationId: operation.id,
        verb: 'undo',
        status: 'refused',
        result: 318000,
        requestedAt: '2026-10-11T10:04:00Z',
      }),
      commandOf({
        id: '00000000-0000-4000-d000-00000000000d',
        operationId: operation.id,
        verb: 'pause',
        status: 'timed_out',
        result: null,
        requestedAt: '2026-10-11T10:03:00Z',
      }),
    ])
    const { inspector } = await openOperation(backend, operation)
    const feed = within(await consoleOf(inspector)).getByRole('log', { name: 'Commands' })
    const [recovery, undo, pause] = within(feed).getAllByRole('listitem')
    expect(recovery).toHaveTextContent(
      "The outcome is not known yet: SOC reads the flight's progress · 319999",
    )
    expect(undo).toHaveTextContent('Sky Orchestrator refused it · 318000')
    expect(pause).not.toHaveTextContent('·')
  })

  it('names a requester who has left the organization by their profile id', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const operation = await flyingOperation(backend, 'in_flight', {
      progress: { status: 'in_progress' },
    })
    backend.commandRows.set(operation.id, [
      commandOf({ operationId: operation.id, requestedBy: 'user-gone' }),
    ])
    const { inspector } = await openOperation(backend, operation)
    const feed = within(await consoleOf(inspector)).getByRole('log', { name: 'Commands' })
    expect(within(feed).getByRole('listitem')).toHaveTextContent('user-gone')
  })
})

describe("the aircraft's live values, as everywhere else (FR-TEL-02)", () => {
  it('shows the flight aircraft with its live values and their age', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const operation = await flyingOperation(backend, 'in_flight', {
      progress: { status: 'in_progress' },
    })
    const { inspector } = await openOperation(backend, operation)
    const consoleElement = await consoleOf(inspector)
    expect(within(consoleElement).getByText('No sample since the console opened')).toBeVisible()
    backend.sample(NORTH.id, {
      stack: 'lab',
      gatewaySn: 'SOTESTDOCK01',
      aircraftSn: 'SOTESTUAV001',
      takenAtMs: Date.now(),
      sentAtMs: Date.now(),
      latitudeDeg: 41.652312,
      longitudeDeg: -4.724512,
      heightM: 12.3,
      headingDeg: -90,
      homeDistanceM: 34.5,
      batteryPct: 87,
      satellites: 14,
      gpsQuality: 5,
      modeCode: 5,
    })
    await waitFor(() => {
      expect(within(consoleElement).getByText('87 %')).toBeVisible()
    })
  })
})

describe('the flight that cannot be read (FR-OPS-01)', () => {
  it('says why it cannot be read, and reads it again on Try again', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const operation = await flyingOperation(backend, 'in_flight', {
      progress: { status: 'in_progress' },
    })
    // The safety controls read the same flights, so the failure holds until the test lets it go.
    const failing = vi
      .spyOn(backend, 'flights')
      .mockRejectedValue(new BackendError('The flights are down'))
    const { inspector, user } = await openOperation(backend, operation)
    expect(await within(inspector).findByRole('alert')).toHaveTextContent('The flights are down')
    failing.mockRestore()
    await user.click(within(inspector).getByRole('button', { name: 'Try again' }))
    expect(await consoleOf(inspector)).toBeVisible()
  })
})
