// @vitest-environment node
import type { Assignment, Fleet, Geofence, Operation, StackView, Wayline } from '../backend/backend'
import { bake, type Design } from '../geometry/bake'
import { envelopeFromSkyOrchestrator, flightFromJson, flightToJson } from '../geometry/designJson'
import { planFlight } from '../geometry/flight'
import type { Envelope } from '../geometry/limits'
import { geodeticAt, type Geodetic } from '../geometry/projection'
import { draftOf } from '../plans/waylines'
import {
  bakedOf,
  definitionFieldOf,
  currentFlight,
  draftFlight,
  fleetStack,
  flightOutdated,
  sameJson,
  type Choices,
  definitionOpen,
  envelopeOf,
  fenceProblems,
  flightFor,
  limitsFor,
  MAX_HEIGHT_M,
  NO_LIMITS,
  operatorsOpen,
  planSave,
  readDefinition,
  speedLimits,
  storedFlight,
  storedText,
  type DefinitionDraft,
  type DefinitionText,
  type SpeedLimits,
} from './definition'

const FARM: Geodetic = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
const at = (east: number, north: number) => geodeticAt(FARM, { eastM: east, northM: north })
const T = '2026-10-11T10:00:00Z'
const ORGANIZATION = '11111111-1111-4111-8111-111111111111'
const OPERATION = '66666666-6666-4666-8666-666666666666'
const ASSIGNMENT = '77777777-7777-4777-8777-777777777777'
const WAYLINE = '55555555-5555-4555-8555-555555555555'
const FLEET = '33333333-3333-4333-8333-333333333333'
const OTHER_WAYLINE = '88888888-8888-4888-8888-888888888888'
const OTHER_FLEET = '99999999-9999-4999-8999-999999999999'

const ENVELOPE_JSON = {
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

const TIGHT_ENVELOPE: Envelope = {
  geofenceCenter: FARM,
  geofenceRadiusM: 50,
  maxHeightM: 20,
  maxHomeDistanceM: 50,
  maxLegM: 300,
  maxTransitM: 300,
  maxTotalDistanceM: 5000,
  maxWaypoints: 200,
  maxHorizontalSpeedMs: 15,
}

/** A 100 m route north of the takeoff, climbing straight up to 30 m first, as the designer bakes it. */
const DESIGN: Design = {
  takeoff: at(0, 0),
  defaultHeightM: 30,
  primitives: [{ kind: 'route', points: [at(0, 50), at(100, 50)] }],
}

function waylineOf(design: Design): Wayline {
  const baked = bake(design, { origin: FARM, maxArcSpacingM: 10 })
  return { id: WAYLINE, createdAt: T, updatedAt: T, ...draftOf('North corridor', design, baked) }
}

const CORRIDOR = waylineOf(DESIGN)

const FLEET_RECORD: Fleet = {
  id: FLEET,
  name: 'Norte 1',
  model: 'mavic-air-2',
  airframeSerial: '1WNBH9',
  controllerSerial: null,
  gatewaySn: 'SOTESTDOCK01',
  aircraftSn: 'SOTESTUAV001',
  flightTimeBeforeSocS: 5400,
  createdAt: T,
  updatedAt: T,
}

/** What GET /v1/envelope answers, as soc-cloud records it on the stack: the limits under `envelope`. */
const ENVELOPE_READ = {
  envelope: ENVELOPE_JSON,
  envelope_fingerprint: 'e'.repeat(64),
  config_fingerprint: 'c'.repeat(64),
  application_in_force: null,
}

const STACK: StackView = {
  gatewaySn: 'SOTESTDOCK01',
  name: 'lab',
  linkState: 'connected',
  envelope: ENVELOPE_READ,
  envelopeReadAt: T,
  simulatorMode: true,
}

function operationOf(overrides: Partial<Operation> = {}): Operation {
  return {
    id: OPERATION,
    organizationId: ORGANIZATION,
    name: 'North corridor',
    geofenceId: null,
    takeoffSecurityHeightM: null,
    state: 'draft',
    endReason: null,
    createdBy: null,
    createdAt: T,
    updatedAt: T,
    startedAt: null,
    endedAt: null,
    ...overrides,
  }
}

function assignmentOf(overrides: Partial<Assignment> = {}): Assignment {
  return {
    id: ASSIGNMENT,
    operationId: OPERATION,
    waylineId: WAYLINE,
    fleetId: FLEET,
    speedMs: null,
    flight: null,
    ...overrides,
  }
}

const GEOFENCE = '22222222-2222-4222-8222-222222222222'

const TYPED: DefinitionText = {
  name: 'North corridor',
  geofenceId: GEOFENCE,
  heightM: '30',
  waylineId: WAYLINE,
  fleetId: FLEET,
  speedMs: '10',
}

function draftOver(overrides: Partial<DefinitionDraft> = {}): DefinitionDraft {
  return {
    name: 'North corridor',
    geofenceId: null,
    heightM: 30,
    waylineId: WAYLINE,
    fleetId: FLEET,
    speedMs: 10,
    ...overrides,
  }
}

/** The limits of a stack whose envelope allows 12 m/s, for a model whose maximum is 19 m/s. */
const LIMITS: SpeedLimits = speedLimits(12, 19)

function readOk(text: DefinitionText, limits: SpeedLimits = LIMITS): DefinitionDraft {
  const read = readDefinition(text, limits)
  if (!read.ok) throw new Error(`refused: ${JSON.stringify(read.errors)}`)
  return read.draft
}

function errorsOf(text: Partial<DefinitionText>, limits: SpeedLimits = LIMITS) {
  const read = readDefinition({ ...TYPED, ...text }, limits)
  if (read.ok) throw new Error('expected a refusal')
  return read.errors
}

describe('the speed an assignment may fly at (FR-WAY-10)', () => {
  it("defaults to the stack's limit and caps there, below the model's maximum", () => {
    expect(speedLimits(3, 12)).toEqual({ defaultMs: 3, capMs: 3, capOf: "the stack's limit" })
  })

  it("caps at the model's maximum below the stack's limit, and defaults there too", () => {
    expect(speedLimits(15, 12)).toEqual({
      defaultMs: 12,
      capMs: 12,
      capOf: "the model's maximum",
    })
  })

  it("defaults to nothing while the stack's limit is unknown, the model still capping", () => {
    expect(speedLimits(null, 12)).toEqual({
      defaultMs: null,
      capMs: 12,
      capOf: "the model's maximum",
    })
    expect(speedLimits(3, null)).toEqual({ defaultMs: 3, capMs: 3, capOf: "the stack's limit" })
    expect(speedLimits(null, null)).toEqual(NO_LIMITS)
  })
})

describe('the definition the operator types (FR-OPS-01, FR-WAY-10)', () => {
  it('reads the typed values, the name trimmed and a blank height as not set', () => {
    expect(readOk({ ...TYPED, name: '  North corridor  ', heightM: '' })).toEqual(
      draftOver({ name: 'North corridor', geofenceId: GEOFENCE, heightM: null }),
    )
    expect(readOk({ ...TYPED, heightM: '30.5', speedMs: '.5' })).toMatchObject({
      heightM: 30.5,
      speedMs: 0.5,
    })
  })

  it('refuses an empty name, as the database does', () => {
    expect(errorsOf({ name: '   ' })).toEqual({ name: 'An operation needs a name.' })
  })

  it('refuses an operation with no geofence: it holds for every wayline the operation flies', () => {
    expect(errorsOf({ geofenceId: '' })).toEqual({ geofenceId: 'An operation needs a geofence.' })
  })

  it('refuses a height that is not a number, not above zero, or above the schema bound', () => {
    expect(errorsOf({ heightM: 'thirty' })).toEqual({ heightM: 'Enter a number.' })
    expect(errorsOf({ heightM: '-5' })).toEqual({ heightM: 'Enter a number.' })
    expect(errorsOf({ heightM: '0' })).toEqual({ heightM: 'The height must be above zero.' })
    expect(errorsOf({ heightM: '120.5' })).toEqual({
      heightM: `The height is at most ${String(MAX_HEIGHT_M)} m.`,
    })
    expect(readOk({ ...TYPED, heightM: '120' }).heightM).toBe(120)
  })

  it("flies a blank speed at the default, the stack's limit", () => {
    expect(readOk({ ...TYPED, speedMs: '' }).speedMs).toBe(12)
    expect(readOk({ ...TYPED, speedMs: '' }, speedLimits(3, 12)).speedMs).toBe(3)
  })

  it("asks for a speed while the stack's limit is not known, since there is no default", () => {
    expect(errorsOf({ speedMs: '' }, speedLimits(null, 12))).toEqual({
      speedMs: "Enter a speed: the stack's limit is not known yet.",
    })
    expect(readOk({ ...TYPED, speedMs: '8' }, speedLimits(null, 12)).speedMs).toBe(8)
  })

  it('refuses a speed above the cap, naming whose limit it is', () => {
    expect(errorsOf({ speedMs: '12.5' })).toEqual({
      speedMs: "Above the stack's limit of 12 m/s.",
    })
    expect(errorsOf({ speedMs: '13' }, speedLimits(15, 12))).toEqual({
      speedMs: "Above the model's maximum of 12 m/s.",
    })
    expect(readOk({ ...TYPED, speedMs: '12' }).speedMs).toBe(12)
    expect(readOk({ ...TYPED, speedMs: '40' }, NO_LIMITS).speedMs).toBe(40)
  })

  it('refuses a speed that is not above zero', () => {
    expect(errorsOf({ speedMs: '0' })).toEqual({
      speedMs: 'The speed the fleet flies the wayline at must be above zero.',
    })
  })

  it('names a wayline and a fleet together, and a speed only with both', () => {
    expect(errorsOf({ fleetId: '' })).toEqual({
      fleetId: 'Choose the fleet that flies this wayline.',
    })
    expect(errorsOf({ waylineId: '' })).toEqual({
      waylineId: 'Choose the wayline this fleet flies.',
    })
    expect(errorsOf({ waylineId: '', fleetId: '' })).toEqual({
      speedMs: 'Choose a wayline and a fleet first.',
    })
    expect(readOk({ ...TYPED, waylineId: '', fleetId: '', speedMs: '' })).toMatchObject({
      waylineId: null,
      fleetId: null,
      speedMs: null,
    })
  })

  it('reports every refused field at once, not the first alone', () => {
    expect(errorsOf({ name: '', geofenceId: '', heightM: 'x', speedMs: '0' })).toEqual({
      name: 'An operation needs a name.',
      geofenceId: 'An operation needs a geofence.',
      heightM: 'Enter a number.',
      speedMs: 'The speed the fleet flies the wayline at must be above zero.',
    })
  })
})

describe('what the operation and its assignment hold (FR-OPS-02, IR-OPS-02)', () => {
  it('opens the definition in draft, planned, preparing, simulated and ready only', () => {
    const open = ['draft', 'planned', 'preparing', 'simulated', 'ready'] as const
    const frozen = [
      'simulating',
      'launching',
      'in_flight',
      'paused',
      'returning',
      'completed',
      'aborted',
      'failed',
      'cancelled',
    ] as const
    for (const state of open) expect(definitionOpen(state)).toBe(true)
    for (const state of frozen) expect(definitionOpen(state)).toBe(false)
  })

  it('opens the operators until launching, simulating included (the database refuses from launching)', () => {
    const open = ['draft', 'planned', 'preparing', 'simulating', 'simulated', 'ready'] as const
    for (const state of open) expect(operatorsOpen(state)).toBe(true)
    for (const state of ['launching', 'in_flight', 'paused', 'returning', 'completed'] as const) {
      expect(operatorsOpen(state)).toBe(false)
    }
  })

  it('reads the stored values back as the form shows them', () => {
    expect(storedText(operationOf(), null)).toEqual({
      name: 'North corridor',
      geofenceId: '',
      heightM: '',
      waylineId: '',
      fleetId: '',
      speedMs: '',
    })
    expect(
      storedText(
        operationOf({
          geofenceId: '22222222-2222-4222-8222-222222222222',
          takeoffSecurityHeightM: 30,
        }),
        assignmentOf({ speedMs: 10 }),
      ),
    ).toEqual({
      name: 'North corridor',
      geofenceId: '22222222-2222-4222-8222-222222222222',
      heightM: '30',
      waylineId: WAYLINE,
      fleetId: FLEET,
      speedMs: '10',
    })
  })
})

describe('the flight an assignment stores (FR-WAY-10, FR-WAY-11)', () => {
  const inputs = {
    wayline: CORRIDOR,
    fleet: FLEET_RECORD,
    heightM: 30,
    speedMs: 10,
    origin: FARM,
    envelope: envelopeFromSkyOrchestrator(ENVELOPE_JSON),
  }

  it('is planFlight of the wayline, written as the flight file reads it', () => {
    const expected = flightToJson(
      planFlight(CORRIDOR.takeoff, bakedOf(CORRIDOR), {
        origin: FARM,
        takeoffSecurityHeightM: 30,
        speedMs: 10,
        finishAction: 'return_home',
        envelope: inputs.envelope,
      }),
    )
    expect(flightFor(inputs)).toEqual(expected)
    expect(flightFromJson(flightFor(inputs))).toEqual(
      planFlight(CORRIDOR.takeoff, bakedOf(CORRIDOR), {
        origin: FARM,
        takeoffSecurityHeightM: 30,
        speedMs: 10,
        finishAction: 'return_home',
        envelope: inputs.envelope,
      }),
    )
  })

  it('is null while any of the height, the wayline, the fleet, the speed or the origin is missing', () => {
    expect(flightFor({ ...inputs, heightM: null })).toBeNull()
    expect(flightFor({ ...inputs, wayline: undefined })).toBeNull()
    expect(flightFor({ ...inputs, fleet: undefined })).toBeNull()
    expect(flightFor({ ...inputs, speedMs: null })).toBeNull()
    expect(flightFor({ ...inputs, origin: null })).toBeNull()
  })

  it('judges the flight by the envelope, and flies it unjudged while none is read', () => {
    const judged = flightFor({ ...inputs, envelope: TIGHT_ENVELOPE }) as ReturnType<
      typeof flightToJson
    >
    expect(judged.violations.map(({ rule }) => rule)).toContain('height_above_max')
    const unjudged = flightFor({ ...inputs, envelope: null }) as ReturnType<typeof flightToJson>
    expect(unjudged.violations).toEqual([])
  })

  it('refuses to write a flight the schema refuses, rather than storing it', () => {
    const many: Wayline = {
      ...CORRIDOR,
      waypoints: Array.from({ length: 201 }, (_, index) => ({
        index,
        position: at(index * 0.1, 0),
        heightM: 10,
      })),
    }
    expect(() => flightFor({ ...inputs, wayline: many })).toThrow(/flight\.waypoints/)
  })
})

describe('the envelope and the stored flight (FR-LNK-09, FR-WAY-11)', () => {
  it('reads the stack envelope, or none while the stack has not read one', () => {
    expect(envelopeOf(undefined)).toBeNull()
    expect(envelopeOf({ ...STACK, envelope: null, envelopeReadAt: null })).toBeNull()
    expect(envelopeOf(STACK)).toEqual(envelopeFromSkyOrchestrator(ENVELOPE_JSON))
  })

  it('refuses an envelope it cannot read, and the limits alone, which a stack never records', () => {
    expect(() => envelopeOf({ ...STACK, envelope: { geofence_center: 'here' } })).toThrow()
    expect(() => envelopeOf({ ...STACK, envelope: ENVELOPE_JSON })).toThrow(/envelope read/)
  })

  it('reads a stored flight, and none while it holds none', () => {
    const json = flightFor({
      wayline: CORRIDOR,
      fleet: FLEET_RECORD,
      heightM: 30,
      speedMs: 10,
      origin: FARM,
      envelope: null,
    })
    expect(storedFlight(null)).toEqual({ ok: true, flight: null })
    expect(storedFlight(json)).toMatchObject({ ok: true, flight: { takeoffSecurityHeightM: 30 } })
    expect(storedFlight({ schema_version: '1.0.0' })).toMatchObject({ ok: false })
  })

  it('judges a flight against its geofence, naming the rule and the waypoint', () => {
    const flight = flightFromJson(
      flightFor({
        wayline: CORRIDOR,
        fleet: FLEET_RECORD,
        heightM: 30,
        speedMs: 10,
        origin: FARM,
        envelope: null,
      }),
    )
    const fence: Geofence = {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Field',
      polygon: [at(-20, -20), at(20, -20), at(20, 20), at(-20, 20)],
      maxHeightM: 100,
      origin: 'drawn',
      marginM: null,
      createdAt: T,
      updatedAt: T,
    }
    const found = fenceProblems(flight, fence, FARM)
    expect(found.map(({ rule }) => rule)).toContain('outside_geofence_polygon')
    expect(found.find(({ rule }) => rule === 'outside_geofence_polygon')?.waypointIndex).toBe(1)
    expect(fenceProblems(flight, undefined, FARM)).toEqual([])
    expect(fenceProblems(flight, fence, null)).toEqual([])
  })

  it('names the field a database refusal is about, and no other', () => {
    expect(definitionFieldOf('takeoffSecurityHeightM')).toBe('heightM')
    expect(definitionFieldOf('speedMs')).toBe('speedMs')
    expect(definitionFieldOf('flight')).toBeNull()
    expect(definitionFieldOf(null)).toBeNull()
  })
})

/** A JSON value with every object's keys in reverse order, as a jsonb column may give it back. */
function reordered(value: unknown): Record<string, unknown> {
  const turn = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(turn)
    if (typeof item !== 'object' || item === null) return item
    return Object.fromEntries(
      Object.entries(item)
        .reverse()
        .map(([key, inner]) => [key, turn(inner)]),
    )
  }
  return turn(value) as Record<string, unknown>
}

describe('what a save writes (FR-OPS-01, FR-OPS-07)', () => {
  const stackedFlight = (height: number, speed: number, envelope: Envelope | null = null) =>
    flightFor({
      wayline: CORRIDOR,
      fleet: FLEET_RECORD,
      heightM: height,
      speedMs: speed,
      origin: FARM,
      envelope,
    })

  it('writes nothing when nothing changed, its stored flight read back with its keys reordered', () => {
    const stored = {
      operation: operationOf({ takeoffSecurityHeightM: 30 }),
      assignment: assignmentOf({ speedMs: 10, flight: reordered(stackedFlight(30, 10)) }),
    }
    expect(planSave(stored, draftOver(), stackedFlight(30, 10))).toEqual({
      operation: null,
      assignment: null,
    })
  })

  it('writes the operation alone for its name or its geofence, which the flight does not take', () => {
    const stored = {
      operation: operationOf({ takeoffSecurityHeightM: 30 }),
      assignment: assignmentOf({ speedMs: 10 }),
    }
    expect(
      planSave(
        stored,
        draftOver({ name: 'Renamed', geofenceId: '22222222-2222-4222-8222-222222222222' }),
        null,
      ),
    ).toEqual({
      operation: { name: 'Renamed', geofenceId: '22222222-2222-4222-8222-222222222222' },
      assignment: null,
    })
  })

  it('writes the assignment with its flight when its speed changes, and the operation not', () => {
    const stored = {
      operation: operationOf({ takeoffSecurityHeightM: 30 }),
      assignment: assignmentOf({ speedMs: 10 }),
    }
    const flight = stackedFlight(30, 12)
    expect(planSave(stored, draftOver({ speedMs: 12 }), flight)).toEqual({
      operation: null,
      assignment: { kind: 'change', id: ASSIGNMENT, changes: { speedMs: 12, flight } },
    })
  })

  it('writes the assignment with a new flight when the height changes, though its own fields did not', () => {
    const stored = {
      operation: operationOf({ takeoffSecurityHeightM: 30 }),
      assignment: assignmentOf({ speedMs: 10 }),
    }
    const flight = stackedFlight(40, 10)
    expect(planSave(stored, draftOver({ heightM: 40 }), flight)).toEqual({
      operation: { takeoffSecurityHeightM: 40 },
      assignment: { kind: 'change', id: ASSIGNMENT, changes: { flight } },
    })
  })

  it('moves the assignment to another wayline or fleet, and clears its flight while the speed is unset', () => {
    const stored = {
      operation: operationOf({ takeoffSecurityHeightM: 30 }),
      assignment: assignmentOf({ speedMs: 10 }),
    }
    expect(
      planSave(
        stored,
        draftOver({ waylineId: OTHER_WAYLINE, fleetId: OTHER_FLEET, speedMs: null }),
        null,
      ),
    ).toEqual({
      operation: null,
      assignment: {
        kind: 'change',
        id: ASSIGNMENT,
        changes: { waylineId: OTHER_WAYLINE, fleetId: OTHER_FLEET, speedMs: null, flight: null },
      },
    })
  })

  it('creates the assignment when its wayline and fleet are chosen, with its flight', () => {
    const stored = { operation: operationOf(), assignment: null }
    const flight = stackedFlight(30, 10)
    expect(planSave(stored, draftOver(), flight)).toEqual({
      operation: { takeoffSecurityHeightM: 30 },
      assignment: {
        kind: 'assign',
        draft: { waylineId: WAYLINE, fleetId: FLEET, speedMs: 10, flight },
      },
    })
  })

  it('creates no assignment without both its wayline and its fleet', () => {
    const stored = { operation: operationOf(), assignment: null }
    expect(
      planSave(stored, draftOver({ fleetId: null, speedMs: null }), null).assignment,
    ).toBeNull()
  })
})

describe("the speed limits of a definition's fleet (FR-WAY-10)", () => {
  const choices = (stack: StackView): Choices => ({
    waylines: [CORRIDOR],
    fleets: [FLEET_RECORD],
    geofences: [],
    stacks: [stack],
    models: [],
    origin: FARM,
  })

  it("takes the stack's limit from what GET /v1/envelope answered", () => {
    expect(limitsFor(FLEET_RECORD.id, choices(STACK))).toEqual({
      defaultMs: 15,
      capMs: 15,
      capOf: "the stack's limit",
    })
  })

  it('knows no limit, rather than failing, while the envelope cannot be read', () => {
    expect(limitsFor(FLEET_RECORD.id, choices({ ...STACK, envelope: ENVELOPE_JSON }))).toEqual(
      NO_LIMITS,
    )
    expect(limitsFor(FLEET_RECORD.id, choices({ ...STACK, envelope: null }))).toEqual(NO_LIMITS)
  })
})

describe("the stack a definition's fleet flies on (FR-OPS-13)", () => {
  const lists = { fleets: [FLEET_RECORD], stacks: [STACK] }

  it("finds the stack by the fleet's gateway, and none for a fleet or a gateway it does not know", () => {
    expect(fleetStack(FLEET, lists)).toBe(STACK)
    expect(fleetStack(OTHER_FLEET, lists)).toBeUndefined()
    expect(fleetStack(null, lists)).toBeUndefined()
    expect(fleetStack(undefined, lists)).toBeUndefined()
    expect(fleetStack(FLEET, { ...lists, stacks: [] })).toBeUndefined()
  })
})

describe('a stored flight its definition no longer makes (FR-OPS-07)', () => {
  const choices: Choices = {
    waylines: [CORRIDOR],
    fleets: [FLEET_RECORD],
    geofences: [],
    stacks: [{ ...STACK, envelope: null }],
    models: [],
    origin: FARM,
  }
  const operation = operationOf({ takeoffSecurityHeightM: 30, geofenceId: GEOFENCE })
  const made = flightFor({
    wayline: CORRIDOR,
    fleet: FLEET_RECORD,
    heightM: 30,
    speedMs: 10,
    origin: FARM,
    envelope: null,
  })

  it('reads two JSON values as the same whatever the order of their keys, never of their items', () => {
    expect(sameJson({ a: 1, b: [1, { c: 2, d: null }] }, { b: [1, { d: null, c: 2 }], a: 1 })).toBe(
      true,
    )
    expect(sameJson([1, 2], [2, 1])).toBe(false)
    expect(sameJson({ a: 1 }, { a: 1, b: undefined })).toBe(false)
    expect(sameJson({ a: 1 }, null)).toBe(false)
    expect(sameJson(null, null)).toBe(true)
  })

  it('is not outdated while it is the flight the definition makes', () => {
    const assignment = assignmentOf({ speedMs: 10, flight: reordered(made) })
    expect(flightOutdated(operation, assignment, choices)).toBe(false)
  })

  it('is outdated once its wayline was edited elsewhere, and the next save writes the new flight', () => {
    const edited: Wayline = {
      ...CORRIDOR,
      waypoints: CORRIDOR.waypoints.map((waypoint) => ({
        ...waypoint,
        heightM: waypoint.heightM + 5,
      })),
    }
    const assignment = assignmentOf({ speedMs: 10, flight: made })
    const now = { ...choices, waylines: [edited] }
    expect(flightOutdated(operation, assignment, now)).toBe(true)
    const fresh = draftFlight(readOk(storedText(operation, assignment)), now)
    expect(
      planSave({ operation, assignment }, readOk(storedText(operation, assignment)), fresh),
    ).toEqual({
      operation: null,
      assignment: { kind: 'change', id: ASSIGNMENT, changes: { flight: fresh } },
    })
  })

  it('is outdated once the stack has read an envelope the stored flight was not judged by', () => {
    const assignment = assignmentOf({ speedMs: 10, flight: made })
    const judged = {
      ...choices,
      stacks: [
        {
          ...STACK,
          envelope: { ...ENVELOPE_READ, envelope: { ...ENVELOPE_JSON, max_height_m: 20 } },
        },
      ],
    }
    expect(flightOutdated(operation, assignment, judged)).toBe(true)
  })

  it('makes the flight the stored definition makes now, judged by the envelope the stack reads now', () => {
    const tight = {
      ...choices,
      stacks: [
        {
          ...STACK,
          envelope: { ...ENVELOPE_READ, envelope: { ...ENVELOPE_JSON, max_height_m: 20 } },
        },
      ],
    }
    const assignment = assignmentOf({ speedMs: 10, flight: made })
    const now = currentFlight(operation, assignment, tight)
    expect(now).not.toBeNull()
    expect(flightFromJson(now ?? {}).violations.map(({ rule }) => rule)).toContain(
      'height_above_max',
    )
    expect(currentFlight(operation, assignment, choices)).toEqual(made)
    expect(currentFlight(operation, null, choices)).toBeNull()
    const unreadable = { ...choices, stacks: [{ ...STACK, envelope: { nonsense: true } }] }
    expect(currentFlight(operation, assignment, unreadable)).toBeNull()
  })

  it('is never outdated with nothing to compare: no assignment, no flight, or a flight it cannot make', () => {
    expect(flightOutdated(operation, null, choices)).toBe(false)
    expect(flightOutdated(operation, assignmentOf({ speedMs: 10 }), choices)).toBe(false)
    const unreadable = { ...choices, stacks: [{ ...STACK, envelope: { nonsense: true } }] }
    const assignment = assignmentOf({ speedMs: 10, flight: made })
    expect(flightOutdated(operation, assignment, unreadable)).toBe(false)
  })
})
