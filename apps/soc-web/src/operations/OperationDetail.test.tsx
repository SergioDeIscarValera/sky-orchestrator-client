import { screen, waitFor, within } from '@testing-library/react'

import {
  BackendError,
  FieldRefusedError,
  type Assignment,
  type OperationState,
  type Role,
} from '../backend/backend'
import { bake, type Design } from '../geometry/bake'
import { envelopeFromSkyOrchestrator, flightToJson } from '../geometry/designJson'
import { planFlight } from '../geometry/flight'
import { geodeticAt, type Geodetic } from '../geometry/projection'
import { formatLength } from '../plans/format'
import { draftOf } from '../plans/waylines'
import { FakeBackend, MAVIC_AIR_2, NEIGHBOUR, NORTH } from '../test/FakeBackend'
import { renderApp } from '../test/render'

const FARM: Geodetic = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
const at = (east: number, north: number) => geodeticAt(FARM, { eastM: east, northM: north })

/** A climb to 30 m over the takeoff, then 100 m north and east, as the designer bakes it. */
const DESIGN: Design = {
  takeoff: at(0, 0),
  defaultHeightM: 30,
  primitives: [{ kind: 'route', points: [at(0, 50), at(100, 50)] }],
}
const BAKED = bake(DESIGN, { origin: FARM, maxArcSpacingM: 10 })

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

/** What GET /v1/envelope answers for `envelope`, as soc-cloud records it on the stack. */
function readOf(envelope: Record<string, unknown> | null): Record<string, unknown> | null {
  if (envelope === null) return null
  return {
    envelope,
    envelope_fingerprint: 'e'.repeat(64),
    config_fingerprint: 'c'.repeat(64),
    application_in_force: null,
  }
}

const FLEET = {
  name: 'Norte 1',
  model: MAVIC_AIR_2.model,
  airframeSerial: '1WNBH9',
  controllerSerial: null,
  gatewaySn: 'SOTESTDOCK01',
  aircraftSn: 'SOTESTUAV001',
  flightTimeBeforeSocS: 5400,
}

/** The moves that reach each state from a draft, as the lifecycle allows them (FR-OPS-02). */
const PATH: Partial<Record<OperationState, readonly OperationState[]>> = {
  planned: ['planned'],
  simulating: ['planned', 'preparing', 'simulating'],
  simulated: ['planned', 'preparing', 'simulating', 'simulated'],
  launching: ['planned', 'preparing', 'simulating', 'simulated', 'ready', 'launching'],
}

/**
 * NORTH with Norte 1, the corridor wayline, a stack that reads `envelope`, and one operation in
 * `state`. Written as an owner, then the member's role is set as `role` asks.
 */
async function farm({
  state = 'draft',
  role = 'owner',
  envelope = ENVELOPE,
  stackEnvelope,
  simulatorMode = null,
}: {
  readonly state?: OperationState
  readonly role?: Role
  readonly envelope?: Record<string, unknown> | null
  /** What the stack holds instead of the read of `envelope`, as it is. */
  readonly stackEnvelope?: Record<string, unknown> | null
  /** The mode the stack's status last said. */
  readonly simulatorMode?: boolean | null
} = {}) {
  const backend = new FakeBackend(NEIGHBOUR)
  const fleet = await backend.registerFleet(NORTH.id, FLEET)
  const wayline = await backend.createWayline(NORTH.id, draftOf('North corridor', DESIGN, BAKED))
  backend.stacksOf.set(NORTH.id, [
    {
      gatewaySn: 'SOTESTDOCK01',
      name: 'lab',
      linkState: 'connected',
      envelope: stackEnvelope === undefined ? readOf(envelope) : stackEnvelope,
      envelopeReadAt: envelope === null ? null : '2026-10-11T10:00:00Z',
      simulatorMode,
    },
  ])
  // A square of 1 km round the farm, its ceiling the envelope's: the corridor lies well inside it.
  const geofence = await backend.createGeofence(NORTH.id, {
    name: 'Finca',
    polygon: [at(-500, -500), at(500, -500), at(500, 500), at(-500, 500)],
    maxHeightM: 120,
    origin: 'drawn',
    marginM: null,
  })
  const operation = await backend.createOperation(NORTH.id, {
    name: 'North corridor',
    geofenceId: geofence.id,
    takeoffSecurityHeightM: null,
  })
  for (const step of PATH[state] ?? []) backend.moveOperation(operation.id, step)
  if (role !== 'owner') backend.memberships.set(NEIGHBOUR.userId, [{ ...NORTH, role }])
  return { backend, fleet, wayline, geofence, operation }
}

async function openAt(backend: FakeBackend, operationId: string) {
  window.history.replaceState(null, '', `/?panel=operations&operation=${operationId}`)
  const rendered = renderApp(backend)
  await screen.findByRole('banner')
  await within(inspector()).findByRole('heading', { name: 'North corridor' })
  return rendered
}

const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })

/** The flight the stored assignment must hold: planFlight of the same inputs, written as the file reads it. */
function flightFor(height: number, speed: number, envelope: typeof ENVELOPE | null = ENVELOPE) {
  return planFlight(DESIGN.takeoff, BAKED, {
    origin: FARM,
    takeoffSecurityHeightM: height,
    speedMs: speed,
    finishAction: 'return_home',
    envelope: envelope === null ? null : envelopeFromSkyOrchestrator(envelope),
  })
}

afterEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('an operation in the inspector (FR-OPS-01, FR-OPS-07)', () => {
  it('saves the definition: the operation, and the assignment with the flight planFlight gives', async () => {
    const { backend, fleet, wayline, operation } = await farm()
    const { user } = await openAt(backend, operation.id)
    await user.type(within(inspector()).getByLabelText('Height'), '30')
    await user.selectOptions(within(inspector()).getByLabelText('Wayline'), wayline.id)
    await user.selectOptions(within(inspector()).getByLabelText('Fleet'), fleet.id)
    await user.type(within(inspector()).getByLabelText('Speed'), '10')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(backend.assignmentRows.get(operation.id)).toHaveLength(1)
    })
    const [saved] = await backend.operations(NORTH.id)
    expect(saved).toMatchObject({ name: 'North corridor', takeoffSecurityHeightM: 30 })
    const [assignment] = await backend.assignments(operation.id)
    expect(assignment).toMatchObject({ waylineId: wayline.id, fleetId: fleet.id, speedMs: 10 })
    const flight = flightFor(30, 10)
    expect(assignment?.flight).toEqual(flightToJson(flight))
    // The drone's card says the wayline it flies, at its speed, with the stored flight's figures.
    const card = await within(inspector()).findByRole('article', { name: 'Norte 1' })
    await waitFor(() => {
      expect(card).toHaveTextContent(
        `North corridor · 10 m/s · ${String(flight.waypoints.length)} waypoints · ${formatLength(flight.distanceM)}`,
      )
    })
  })

  it("stays up while the stack's envelope cannot be read: no default speed, and Save says why", async () => {
    // The limits alone, which no stack records: soc-cloud keeps GET /v1/envelope's whole answer.
    const { backend, fleet, wayline, operation } = await farm({ stackEnvelope: ENVELOPE })
    const { user } = await openAt(backend, operation.id)
    expect(screen.queryByText(/The inspector stopped/)).toBeNull()
    await user.type(within(inspector()).getByLabelText('Height'), '30')
    await user.selectOptions(within(inspector()).getByLabelText('Wayline'), wayline.id)
    await user.selectOptions(within(inspector()).getByLabelText('Fleet'), fleet.id)
    expect(within(inspector()).getByLabelText('Speed')).not.toHaveAttribute('placeholder')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(
      await within(inspector()).findByText("Enter a speed: the stack's limit is not known yet."),
    ).toBeVisible()
    await user.type(within(inspector()).getByLabelText('Speed'), '10')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/envelope read/)
    expect(backend.assignmentRows.get(operation.id) ?? []).toHaveLength(0)
  })

  it('marks a stored flight its definition no longer makes, and writes the new one on Save', async () => {
    const { backend, fleet, wayline, operation } = await farm()
    await backend.changeOperation(operation.id, { takeoffSecurityHeightM: 30 })
    // Stored as another console saved it, at 8 m/s, while the assignment now says 10.
    await backend.assign(operation.id, NORTH.id, {
      waylineId: wayline.id,
      fleetId: fleet.id,
      speedMs: 10,
      flight: flightToJson(flightFor(30, 8)),
    })
    const { user } = await openAt(backend, operation.id)
    expect(await within(inspector()).findByText('Out of date')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(async () => {
      const [assignment] = await backend.assignments(operation.id)
      expect(assignment?.flight).toEqual(flightToJson(flightFor(30, 10)))
    })
    await waitFor(() => {
      expect(within(inspector()).queryByText('Out of date')).toBeNull()
    })
  })

  it('judges an out-of-date flight as its definition makes it now, not by what Save judged', async () => {
    const { backend, fleet, wayline, operation } = await farm()
    await backend.changeOperation(operation.id, { takeoffSecurityHeightM: 30 })
    // Saved while the stack's ceiling was 20 m: the stored flight holds the problems of then.
    const then = flightFor(30, 10, { ...ENVELOPE, max_height_m: 20 })
    expect(then.violations.map(({ rule }) => rule)).toContain('height_above_max')
    await backend.assign(operation.id, NORTH.id, {
      waylineId: wayline.id,
      fleetId: fleet.id,
      speedMs: 10,
      flight: flightToJson(then),
    })
    await openAt(backend, operation.id)
    expect(await within(inspector()).findByText('Out of date')).toBeVisible()
    // The ceiling is 120 m now: the flight the definition makes breaks nothing.
    expect(within(inspector()).queryByRole('list', { name: 'Problems' })).toBeNull()
    expect(within(inspector()).queryByText(/height_above_max/)).toBeNull()
  })

  it.each([
    [true, true],
    [false, false],
    [null, false],
  ] as const)(
    "offers a simulated operation a launch by its fleet's stack's mode, %s: only in the simulator (FR-OPS-13)",
    async (simulatorMode, offered) => {
      const { backend, fleet, wayline, operation } = await farm({ simulatorMode })
      await backend.changeOperation(operation.id, { takeoffSecurityHeightM: 30 })
      await backend.assign(operation.id, NORTH.id, {
        waylineId: wayline.id,
        fleetId: fleet.id,
        speedMs: 10,
        flight: flightToJson(flightFor(30, 10)),
      })
      for (const step of PATH.simulated ?? []) backend.moveOperation(operation.id, step)
      await openAt(backend, operation.id)
      expect(
        await within(inspector()).findByRole('button', { name: 'Cancel operation' }),
      ).toBeVisible()
      expect(within(inspector()).queryByRole('button', { name: 'Launch' }) !== null).toBe(offered)
    },
  )

  it("flies the stack's limit when no speed is typed, and stores no flight while the height is not set", async () => {
    const { backend, fleet, wayline, operation } = await farm()
    const { user } = await openAt(backend, operation.id)
    await user.selectOptions(within(inspector()).getByLabelText('Wayline'), wayline.id)
    await user.selectOptions(within(inspector()).getByLabelText('Fleet'), fleet.id)
    // The envelope allows 15 m/s and the model 19: the default is the stack's limit, shown as such.
    expect(within(inspector()).getByLabelText('Speed')).toHaveAttribute('placeholder', '15')
    expect(within(inspector()).getByText('max 15')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(backend.assignmentRows.get(operation.id)).toHaveLength(1)
    })
    const [assignment] = await backend.assignments(operation.id)
    expect(assignment).toMatchObject({ speedMs: 15, flight: null })
    const card = await within(inspector()).findByRole('article', { name: 'Norte 1' })
    await waitFor(() => {
      expect(card).toHaveTextContent('North corridor · 15 m/s')
    })
    expect(card).not.toHaveTextContent('waypoints')
  })

  it('names each envelope and geofence problem of the flight, by its rule and waypoint', async () => {
    const { backend, fleet, wayline, operation } = await farm({
      envelope: { ...ENVELOPE, max_height_m: 20 },
    })
    const geofence = await backend.createGeofence(NORTH.id, {
      name: 'Field',
      polygon: [at(-20, -20), at(20, -20), at(20, 20), at(-20, 20)],
      maxHeightM: 100,
      origin: 'drawn',
      marginM: null,
    })
    const { user } = await openAt(backend, operation.id)
    await user.type(within(inspector()).getByLabelText('Height'), '30')
    await user.selectOptions(within(inspector()).getByLabelText('Geofence'), geofence.id)
    await user.selectOptions(within(inspector()).getByLabelText('Wayline'), wayline.id)
    await user.selectOptions(within(inspector()).getByLabelText('Fleet'), fleet.id)
    await user.type(within(inspector()).getByLabelText('Speed'), '10')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    const problems = await screen.findByRole('list', { name: 'Problems' })
    expect(within(problems).getByText('takeoff_security_height_above_max')).toBeVisible()
    expect(within(problems).getByText('height_above_max · waypoint 0')).toBeVisible()
    expect(within(problems).getByText('outside_geofence_polygon · waypoint 1')).toBeVisible()
    expect(within(problems).getByText('waypoint 1 is outside the geofence')).toBeVisible()
  })

  it('shows the refusal the database names beside the field it is about', async () => {
    const { backend, operation } = await farm()
    vi.spyOn(backend, 'changeOperation').mockRejectedValueOnce(
      new FieldRefusedError('The height must be above zero.', 'takeoffSecurityHeightM', '23514'),
    )
    const { user } = await openAt(backend, operation.id)
    await user.type(within(inspector()).getByLabelText('Height'), '30')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    const message = await screen.findByText('The height must be above zero.')
    const height = within(inspector()).getByLabelText('Height')
    expect(height).toHaveAttribute('aria-invalid', 'true')
    expect(height).toHaveAttribute('aria-describedby', message.id)
  })

  it('shows a refusal that names no field under Save', async () => {
    const { backend, operation } = await farm()
    vi.spyOn(backend, 'changeOperation').mockRejectedValueOnce(
      new BackendError('the connection dropped'),
    )
    const { user } = await openAt(backend, operation.id)
    await user.type(within(inspector()).getByLabelText('Height'), '30')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('the connection dropped')
  })

  it('refuses what it can read before it asks the database, field by field', async () => {
    const { backend, operation } = await farm()
    const change = vi.spyOn(backend, 'changeOperation')
    const { user } = await openAt(backend, operation.id)
    await user.clear(within(inspector()).getByLabelText('Name'))
    await user.type(within(inspector()).getByLabelText('Height'), '0')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('An operation needs a name.')).toBeVisible()
    expect(screen.getByText('The height must be above zero.')).toBeVisible()
    expect(change).not.toHaveBeenCalled()
  })

  it("holds a speed to the stack's limit, below the model's maximum, and names it", async () => {
    const { backend, fleet, wayline, operation } = await farm()
    const { user } = await openAt(backend, operation.id)
    await user.selectOptions(within(inspector()).getByLabelText('Wayline'), wayline.id)
    await user.selectOptions(within(inspector()).getByLabelText('Fleet'), fleet.id)
    await user.type(within(inspector()).getByLabelText('Speed'), '16')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText("Above the stack's limit of 15 m/s.")).toBeVisible()
    expect(backend.assignmentRows.get(operation.id) ?? []).toEqual([])
  })

  it("holds a speed to the model's maximum, below the stack's limit, and names it", async () => {
    const { backend, fleet, wayline, operation } = await farm({
      envelope: { ...ENVELOPE, max_horizontal_speed_ms: 25 },
    })
    const { user } = await openAt(backend, operation.id)
    await user.selectOptions(within(inspector()).getByLabelText('Wayline'), wayline.id)
    await user.selectOptions(within(inspector()).getByLabelText('Fleet'), fleet.id)
    expect(within(inspector()).getByLabelText('Speed')).toHaveAttribute('placeholder', '19')
    await user.type(within(inspector()).getByLabelText('Speed'), '20')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText("Above the model's maximum of 19 m/s.")).toBeVisible()
    expect(backend.assignmentRows.get(operation.id) ?? []).toEqual([])
  })

  it('refuses to save an operation with no geofence, naming it beside its field', async () => {
    const { backend, operation } = await farm()
    await backend.changeOperation(operation.id, { geofenceId: null })
    const { user } = await openAt(backend, operation.id)
    const geofence = within(inspector()).getByLabelText('Geofence')
    expect(within(geofence).queryByRole('option', { name: 'None' })).toBeNull()
    expect(geofence).toHaveValue('')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('An operation needs a geofence.')).toBeVisible()
    expect(geofence).toHaveAttribute('aria-invalid', 'true')
  })

  it("shows the drone's card: its fleet and model, its wayline at its speed, and what it says now", async () => {
    const { backend, fleet, wayline, operation } = await farm()
    backend.assignmentRows.set(operation.id, [
      {
        id: '77777777-7777-4777-8777-777777777777',
        operationId: operation.id,
        waylineId: wayline.id,
        fleetId: fleet.id,
        speedMs: 10,
        flight: flightToJson(flightFor(30, 10)),
      },
    ])
    await openAt(backend, operation.id)
    const card = await within(inspector()).findByRole('article', { name: 'Norte 1' })
    expect(card).toHaveTextContent(MAVIC_AIR_2.displayName)
    expect(within(card).getByText('No sample')).toBeVisible()
    backend.sample(NORTH.id, {
      stack: 'lab',
      gatewaySn: 'SOTESTDOCK01',
      aircraftSn: 'SOTESTUAV001',
      takenAtMs: Date.now(),
      sentAtMs: Date.now(),
      latitudeDeg: 41.6523,
      longitudeDeg: -4.7245,
      heightM: 12.3,
      headingDeg: 90,
      homeDistanceM: 3,
      batteryPct: 87,
      satellites: 14,
      gpsQuality: 5,
      modeCode: 5,
    })
    await waitFor(() => {
      expect(within(card).getByText('Live')).toBeVisible()
    })
    expect(card).toHaveTextContent('87 % · 12.3 m · Wayline')
  })

  it("opens the drone's own detail from its card", async () => {
    const { backend, fleet, wayline, operation } = await farm()
    backend.assignmentRows.set(operation.id, [
      {
        id: '77777777-7777-4777-8777-777777777777',
        operationId: operation.id,
        waylineId: wayline.id,
        fleetId: fleet.id,
        speedMs: 10,
        flight: null,
      },
    ])
    const { user } = await openAt(backend, operation.id)
    const card = await within(inspector()).findByRole('article', { name: 'Norte 1' })
    await user.click(within(card).getByRole('button', { name: 'Open drone' }))
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get('fleet')).toBe(fleet.id)
    })
    expect(await within(inspector()).findByRole('heading', { name: 'Norte 1' })).toBeVisible()
  })

  it('names a stored flight that cannot be read, rather than showing a guess', async () => {
    const { backend, fleet, wayline, operation } = await farm()
    const assignment: Assignment = {
      id: '77777777-7777-4777-8777-777777777777',
      operationId: operation.id,
      waylineId: wayline.id,
      fleetId: fleet.id,
      speedMs: 10,
      flight: { schema_version: '1.0.0' },
    }
    backend.assignmentRows.set(operation.id, [assignment])
    await openAt(backend, operation.id)
    expect(await screen.findByRole('alert')).toHaveTextContent(/flight\./)
    expect(screen.queryByText('Waypoints')).toBeNull()
  })

  it('reads the same values, with nothing to change, for a viewer', async () => {
    const { backend, operation } = await farm()
    await backend.changeOperation(operation.id, { takeoffSecurityHeightM: 30 })
    backend.memberships.set(NEIGHBOUR.userId, [{ ...NORTH, role: 'viewer' }])
    const { user } = await openAt(backend, operation.id)
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByLabelText('Height')).toBeNull()
    // Folded to its summary, opened with a click.
    const definition = within(inspector()).getByText('Definition')
    expect(definition.closest('summary')).toHaveTextContent('Finca · 30 m')
    await user.click(definition)
    expect(within(inspector()).getByText('Height')).toBeVisible()
    expect(within(inspector()).getByText('30 m')).toBeVisible()
    expect(screen.queryByRole('combobox', { name: /Operator role of/ })).toBeNull()
  })

  it('reads the definition once a flight is being prepared, and keeps the operators open', async () => {
    const { backend, operation } = await farm({ state: 'simulating' })
    await openAt(backend, operation.id)
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(within(inspector()).getByText('Simulating')).toBeVisible()
    expect(
      await within(inspector()).findByRole('combobox', {
        name: 'Operator role of neighbour@farm.test',
      }),
    ).toBeEnabled()
  })

  it('reads the operators only from launching on', async () => {
    const { backend, operation } = await farm({ state: 'launching' })
    await openAt(backend, operation.id)
    expect(within(inspector()).getByText('Launching')).toBeVisible()
    expect(screen.queryByRole('combobox', { name: /Operator role of/ })).toBeNull()
    expect(await within(inspector()).findByText('neighbour@farm.test')).toBeVisible()
  })

  it('says so, with the way out, for a link to an operation the organization does not have', async () => {
    const { backend } = await farm()
    window.history.replaceState(
      null,
      '',
      '/?panel=operations&operation=99999999-9999-4999-8999-999999999999',
    )
    renderApp(backend)
    await screen.findByRole('banner')
    const shown = await screen.findByRole('complementary', { name: 'Inspector' })
    expect(
      await within(shown).findByText(
        `${NORTH.name} has no operation with this link: it may belong to another organization.`,
      ),
    ).toBeVisible()
    expect(within(shown).getByRole('button', { name: 'Clear the selection' })).toBeVisible()
  })

  it('reads a definition whose wayline has since been retired, as Retired', async () => {
    const { backend, fleet, wayline, operation } = await farm()
    backend.assignmentRows.set(operation.id, [
      {
        id: '77777777-7777-4777-8777-777777777777',
        operationId: operation.id,
        waylineId: wayline.id,
        fleetId: fleet.id,
        speedMs: null,
        flight: null,
      },
    ])
    await backend.retireWayline(wayline.id)
    backend.memberships.set(NEIGHBOUR.userId, [{ ...NORTH, role: 'viewer' }])
    const { user } = await openAt(backend, operation.id)
    await user.click(within(inspector()).getByText('Definition'))
    expect(within(inspector()).getByText('Wayline').nextElementSibling).toHaveTextContent('Retired')
  })
})
