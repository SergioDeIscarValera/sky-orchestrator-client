// @vitest-environment node
import type { OperationState } from '../backend/backend'
import type { ShownCheck } from './checks'
import { checkCount, holdingBack, nextMove, otherMoves, stepsOf, STEPS } from './journey'
import { OFFERED } from './moves'

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

const states = (state: OperationState) => stepsOf(state).map((step) => step.state)

function check(id: string, state: ShownCheck['state'], blocking = true): ShownCheck {
  return { id, state, blocking, value: null, detail: null }
}

describe("an operation's journey, in five steps (FR-OPS-02)", () => {
  it('names the five steps in order', () => {
    expect(STEPS).toEqual(['plan', 'prepare', 'simulate', 'launch', 'done'])
  })

  it('puts a draft on its plan, with every other step to come', () => {
    expect(states('draft')).toEqual(['current', 'todo', 'todo', 'todo', 'todo'])
  })

  it('moves on as the operation does, a step running while it runs on its own', () => {
    expect(states('planned')).toEqual(['done', 'current', 'todo', 'todo', 'todo'])
    expect(states('preparing')).toEqual(['done', 'running', 'todo', 'todo', 'todo'])
    expect(states('simulating')).toEqual(['done', 'done', 'running', 'todo', 'todo'])
    expect(states('simulated')).toEqual(['done', 'done', 'done', 'current', 'todo'])
    expect(states('ready')).toEqual(['done', 'done', 'done', 'current', 'todo'])
    for (const flying of ['launching', 'in_flight', 'paused', 'returning'] as const) {
      expect(states(flying)).toEqual(['done', 'done', 'done', 'running', 'todo'])
    }
  })

  it('says how a closed operation ended, and leaves a cancelled one unflown', () => {
    expect(states('completed')).toEqual(['done', 'done', 'done', 'done', 'ended-well'])
    expect(states('aborted')).toEqual(['done', 'done', 'done', 'done', 'ended-badly'])
    expect(states('failed')).toEqual(['done', 'done', 'done', 'done', 'ended-badly'])
    expect(states('cancelled')).toEqual(['todo', 'todo', 'todo', 'todo', 'ended-badly'])
  })

  it('gives every state exactly one step that is not done or to come', () => {
    for (const state of STATES) {
      const open = states(state).filter((step) => step !== 'done' && step !== 'todo')
      expect(open, state).toHaveLength(1)
    }
  })
})

describe('the move to the next step, and the others (FR-OPS-02)', () => {
  it('plans a draft, prepares a plan, simulates a prepared operation and launches a ready one', () => {
    expect(nextMove('draft')).toBe('plan')
    expect(nextMove('planned')).toBe('prepare')
    expect(nextMove('preparing')).toBe('simulate')
    expect(nextMove('ready')).toBe('launch')
  })

  it('offers none while a step runs on its own, while simulated, or once closed', () => {
    for (const state of [
      'simulating',
      'simulated',
      'launching',
      'in_flight',
      'paused',
      'returning',
      'completed',
      'aborted',
      'failed',
      'cancelled',
    ] as const) {
      expect(nextMove(state), state).toBeNull()
    }
  })

  it('is always one the lifecycle offers in that state, and so are the others, the stop aside', () => {
    for (const state of STATES) {
      const next = nextMove(state)
      if (next !== null) expect(OFFERED[state]).toContain(next)
      for (const move of otherMoves(state)) expect(OFFERED[state]).toContain(move)
      expect(otherMoves(state)).not.toContain('stop')
      expect(otherMoves(state)).not.toContain(next)
    }
  })

  it('leaves going back and cancelling beside the next move', () => {
    expect(otherMoves('draft')).toEqual(['cancel'])
    expect(otherMoves('preparing')).toEqual(['unprepare', 'cancel'])
    expect(otherMoves('in_flight')).toEqual([])
  })
})

describe('the checks that hold a move back (FR-OPS-04, FR-OPS-07)', () => {
  const checks = [
    check('PF-LINK', 'pass'),
    check('PF-BATTERY', 'fail'),
    check('PF-GNSS', 'unknown'),
    check('PF-CLOCK', 'fail', false),
  ]

  it('holds a simulation and a launch back by every blocking check not passed, unknown included', () => {
    expect(holdingBack('simulate', checks).map(({ id }) => id)).toEqual(['PF-BATTERY', 'PF-GNSS'])
    expect(holdingBack('launch', checks).map(({ id }) => id)).toEqual(['PF-BATTERY', 'PF-GNSS'])
  })

  it('holds back no move the checks do not gate', () => {
    expect(holdingBack('plan', checks)).toEqual([])
    expect(holdingBack('cancel', checks)).toEqual([])
  })

  it('counts the checks passing out of all', () => {
    expect(checkCount(checks)).toEqual({ passing: 1, total: 4 })
  })
})
