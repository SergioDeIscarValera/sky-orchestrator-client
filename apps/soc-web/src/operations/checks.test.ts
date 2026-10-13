// @vitest-environment node
import type { OperationCheck, OperationState } from '../backend/backend'
import { checksOfTable } from '../test/requirements'
import { checksShown, NON_BLOCKING, shownChecks } from './checks'
import { CHECK_ORDER } from './format'

const ALL_STATES: readonly OperationState[] = [
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

const JUDGED_IN: readonly OperationState[] = [
  'preparing',
  'simulating',
  'simulated',
  'ready',
  'launching',
  'in_flight',
  'paused',
  'returning',
]

function judgement(checkId: string, overrides: Partial<OperationCheck> = {}): OperationCheck {
  return {
    checkId,
    state: 'pass',
    blocking: true,
    value: { satellites: 14 },
    detail: null,
    evaluatedAt: '2026-10-11T10:10:00Z',
    ...overrides,
  }
}

describe('the preflight checks an operation shows (FR-OPS-04, FR-OPS-05)', () => {
  it('judges the checks from preparing to the landing, and in no other state', () => {
    for (const state of ALL_STATES) {
      expect(checksShown(state), state).toBe(JUDGED_IN.includes(state))
    }
  })

  it('marks exactly the checks FR-OPS-05 says do not block', () => {
    expect([...NON_BLOCKING]).toEqual(checksOfTable().notBlocking)
    expect([...NON_BLOCKING]).toEqual(['PF-CLOCK'])
  })

  it('lists every check in the table order, each unknown until it is judged', () => {
    const shown = shownChecks([])
    expect(shown.map(({ id }) => id)).toEqual([...CHECK_ORDER])
    expect(shown.every(({ state }) => state === 'unknown')).toBe(true)
    expect(shown.filter(({ blocking }) => !blocking).map(({ id }) => id)).toEqual(['PF-CLOCK'])
  })

  it('keeps each judgement with its value and detail, in its place in the table', () => {
    const gnss = judgement('PF-GNSS', {
      state: 'fail',
      value: { satellites: 9, gps_quality: 4 },
      detail: 'Nine satellites; twelve are needed.',
    })
    const link = judgement('PF-LINK')
    const shown = shownChecks([gnss, link])
    expect(shown[0]).toEqual({
      id: 'PF-LINK',
      state: 'pass',
      blocking: true,
      value: { satellites: 14 },
      detail: null,
    })
    expect(shown.find(({ id }) => id === 'PF-GNSS')).toEqual({
      id: 'PF-GNSS',
      state: 'fail',
      blocking: true,
      value: { satellites: 9, gps_quality: 4 },
      detail: 'Nine satellites; twelve are needed.',
    })
  })

  it('takes a non-blocking judgement as the database gives it', () => {
    const clock = judgement('PF-CLOCK', { state: 'fail', blocking: false, value: null })
    const shown = shownChecks([clock])
    expect(shown.find(({ id }) => id === 'PF-CLOCK')).toMatchObject({
      state: 'fail',
      blocking: false,
    })
  })

  it('lists a check the table does not name after the table, by its id, so no judgement is hidden', () => {
    const shown = shownChecks([judgement('PF-ZED'), judgement('PF-AAA'), judgement('PF-LINK')])
    expect(shown.map(({ id }) => id).slice(-2)).toEqual(['PF-AAA', 'PF-ZED'])
    expect(shown).toHaveLength(CHECK_ORDER.length + 2)
  })

  it('does not change the judgements it is given', () => {
    const given = [judgement('PF-GNSS', { state: 'fail' }), judgement('PF-ZED')]
    const before = structuredClone(given)
    shownChecks(given)
    expect(given).toEqual(before)
  })
})
