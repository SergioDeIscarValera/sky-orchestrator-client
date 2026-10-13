// @vitest-environment node
import type { Member, OperationState } from '../backend/backend'
import {
  memberName,
  operationSummary,
  operatorRoleWord,
  roleWord,
  stateTone,
  stateWord,
} from './format'

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

describe('an operation in words (FR-OPS-02)', () => {
  it('names each of the fourteen states, in the words the list and the header show', () => {
    expect(STATES.map(stateWord)).toEqual([
      'Draft',
      'Planned',
      'Preparing',
      'Simulating',
      'Simulated',
      'Ready',
      'Launching',
      'In flight',
      'Paused',
      'Returning',
      'Completed',
      'Aborted',
      'Failed',
      'Cancelled',
    ])
  })

  it('gives every state a pill tone from the console tokens, a failure in danger', () => {
    for (const state of STATES) expect(stateTone(state)).toMatch(/^(?:bg-|border-|text-)/)
    expect(stateTone('failed')).toContain('bg-danger-subtle')
    expect(stateTone('aborted')).toContain('text-danger-emphasis')
    expect(stateTone('paused')).toContain('bg-warning-subtle')
  })

  it("puts the state, then the fleet's and the wayline's names, on the muted line", () => {
    expect(
      operationSummary({ state: 'planned', fleet: 'Norte 1', wayline: 'North corridor' }),
    ).toBe('Planned · Norte 1 · North corridor')
  })

  it('leaves out the names an operation does not have yet', () => {
    expect(operationSummary({ state: 'draft', fleet: null, wayline: null })).toBe('Draft')
    expect(operationSummary({ state: 'draft', fleet: 'Norte 1', wayline: null })).toBe(
      'Draft · Norte 1',
    )
  })
})

describe('the members and their roles (IR-OPR, FR-CMD-01)', () => {
  const member: Member = { profileId: 'user-ana', displayName: null, email: null, role: 'editor' }

  it('names a member by name, else address, else profile id', () => {
    expect(memberName({ ...member, displayName: 'Ana Ruiz', email: 'ana@farm.test' })).toBe(
      'Ana Ruiz',
    )
    expect(memberName({ ...member, displayName: '  ', email: 'ana@farm.test' })).toBe(
      'ana@farm.test',
    )
    expect(memberName({ ...member, displayName: null, email: null })).toBe('user-ana')
  })

  it('says the organization role and the operator role in words', () => {
    expect([roleWord('owner'), roleWord('editor'), roleWord('viewer')]).toEqual([
      'Owner',
      'Editor',
      'Viewer',
    ])
    expect([operatorRoleWord('pilot'), operatorRoleWord('observer')]).toEqual(['Pilot', 'Observer'])
  })
})
