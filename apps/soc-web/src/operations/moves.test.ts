// @vitest-environment node
import type {
  OperationState,
  Transition,
  TransitionRequest,
  TransitionStatus,
} from '../backend/backend'
import {
  AIRBORNE_STATES,
  CONSOLE_STATES,
  FLIGHT_MOVES,
  OFFERED,
  commandWithheldBy,
  isFlightMove,
  reasonsOf,
  undecided,
  withheldBy,
} from './moves'

const TRANSITIONS: readonly Transition[] = [
  'plan',
  'prepare',
  'unprepare',
  'simulate',
  'launch',
  'stop',
  'cancel',
]

/** FR-OPS-02's states, with the moves the console offers each one (the brief's table). */
const TABLE: Readonly<Record<OperationState, readonly Transition[]>> = {
  draft: ['plan', 'cancel'],
  planned: ['prepare', 'cancel'],
  preparing: ['simulate', 'unprepare', 'cancel'],
  simulating: [],
  simulated: ['launch', 'cancel'],
  ready: ['launch', 'cancel'],
  launching: [],
  in_flight: ['stop'],
  paused: ['stop'],
  returning: [],
  completed: [],
  aborted: [],
  failed: [],
  cancelled: [],
}

function request(status: TransitionStatus, reasons: readonly string[] | null = null) {
  return {
    id: 'request-1',
    operationId: 'operation-1',
    transition: 'launch',
    status,
    reasons,
    requestedBy: null,
    requestedAt: '2026-10-11T10:10:00Z',
    decidedAt: null,
  } satisfies TransitionRequest
}

describe('the moves a member may ask (FR-OPS-02, FR-AUT-03, FR-CMD-01)', () => {
  it('offers each state its moves, and none while it runs or once it is closed', () => {
    expect(OFFERED).toEqual(TABLE)
  })

  it('takes simulate, launch and stop as the flight moves, and no other', () => {
    expect([...FLIGHT_MOVES]).toEqual(['simulate', 'launch', 'stop'])
    expect(TRANSITIONS.filter(isFlightMove)).toEqual(['simulate', 'launch', 'stop'])
  })

  it('asks an editor or owner for plan, prepare, unprepare and cancel', () => {
    for (const transition of ['plan', 'prepare', 'unprepare', 'cancel'] as const) {
      expect(withheldBy(transition, { role: 'editor', pilot: false })).toBeNull()
      expect(withheldBy(transition, { role: 'owner', pilot: false })).toBeNull()
      expect(withheldBy(transition, { role: 'viewer', pilot: true })).toBe('Editors only')
    }
  })

  it('asks an editor who is also a pilot for simulate, launch and stop', () => {
    for (const transition of ['simulate', 'launch', 'stop'] as const) {
      expect(withheldBy(transition, { role: 'editor', pilot: true })).toBeNull()
      expect(withheldBy(transition, { role: 'owner', pilot: true })).toBeNull()
      expect(withheldBy(transition, { role: 'editor', pilot: false })).toBe('Pilots only')
      expect(withheldBy(transition, { role: 'viewer', pilot: true })).toBe('Editors only')
    }
  })

  it('names the editor rule first, for a viewer who is not a pilot either', () => {
    expect(withheldBy('launch', { role: 'viewer', pilot: false })).toBe('Editors only')
  })

  it('waits while a request is pending or running, and not once it is decided', () => {
    expect(undecided(undefined)).toBe(false)
    expect(undecided(request('pending'))).toBe(true)
    expect(undecided(request('running'))).toBe(true)
    for (const status of ['accepted', 'refused', 'failed', 'expired'] as const) {
      expect(undecided(request(status))).toBe(false)
    }
  })

  it('shows the reasons of a refused or failed request, and none of any other outcome', () => {
    expect(reasonsOf(undefined)).toEqual([])
    expect(reasonsOf(request('refused', ['No geofence.', 'No pilot.']))).toEqual([
      'No geofence.',
      'No pilot.',
    ])
    expect(reasonsOf(request('failed', ['Sky Orchestrator is down.']))).toEqual([
      'Sky Orchestrator is down.',
    ])
    expect(reasonsOf(request('refused', null))).toEqual([])
    expect(reasonsOf(request('accepted', ['stale']))).toEqual([])
  })
})

const MEMBERS = [
  { role: 'owner', pilot: true },
  { role: 'owner', pilot: false },
  { role: 'editor', pilot: true },
  { role: 'editor', pilot: false },
  { role: 'viewer', pilot: true },
  { role: 'viewer', pilot: false },
] as const

describe("who commands an operation's aircraft (FR-CMD-01, FR-AUT-03)", () => {
  it('asks an editor or owner who is a pilot, and names the reason of anyone else', () => {
    expect(commandWithheldBy({ role: 'owner', pilot: true })).toBeNull()
    expect(commandWithheldBy({ role: 'editor', pilot: true })).toBeNull()
    expect(commandWithheldBy({ role: 'editor', pilot: false })).toBe('Pilots only')
    expect(commandWithheldBy({ role: 'owner', pilot: false })).toBe('Pilots only')
    expect(commandWithheldBy({ role: 'viewer', pilot: true })).toBe('Editors only')
    expect(commandWithheldBy({ role: 'viewer', pilot: false })).toBe('Editors only')
  })

  it('withholds the flight moves exactly as it withholds a command', () => {
    for (const member of MEMBERS) {
      for (const move of FLIGHT_MOVES) {
        expect(withheldBy(move, member)).toEqual(commandWithheldBy(member))
      }
    }
  })

  it('names the states the console shows in, and the airborne ones the safety controls command', () => {
    expect(CONSOLE_STATES).toEqual(['simulating', 'launching', 'in_flight', 'paused', 'returning'])
    expect(AIRBORNE_STATES).toEqual(['launching', 'in_flight', 'paused', 'returning'])
    expect(AIRBORNE_STATES.every((state) => CONSOLE_STATES.includes(state))).toBe(true)
  })
})
