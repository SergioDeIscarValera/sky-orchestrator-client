import type { CheckState, OperationCheck, OperationState } from '../backend/backend'
import { CHECK_ORDER } from './format'

/** The states the checks are judged in: from preparing, when they start (FR-OPS-04), to the landing. */
const JUDGED: ReadonlySet<OperationState> = new Set<OperationState>([
  'preparing',
  'simulating',
  'simulated',
  'ready',
  'launching',
  'in_flight',
  'paused',
  'returning',
])

/** Whether an operation in this state shows its checks: never as a draft, a plan, or once it is closed. */
export function checksShown(state: OperationState): boolean {
  return JUDGED.has(state)
}

/** The checks FR-OPS-05 marks as a warning that does not block: every other check blocks a launch. */
export const NON_BLOCKING: ReadonlySet<string> = new Set(['PF-CLOCK'])

export interface ShownCheck {
  readonly id: string
  readonly state: CheckState
  readonly blocking: boolean
  readonly value: unknown
  readonly detail: string | null
}

const KNOWN: ReadonlySet<string> = new Set<string>(CHECK_ORDER)

function judged({ checkId, state, blocking, value, detail }: OperationCheck): ShownCheck {
  return { id: checkId, state, blocking, value, detail }
}

/** A check nobody has judged yet is unknown: it is never shown as a pass (FR-OPS-04). */
function unjudged(id: string): ShownCheck {
  return { id, state: 'unknown', blocking: !NON_BLOCKING.has(id), value: null, detail: null }
}

/**
 * Every check of FR-OPS-05 in the table's order, each judged or unknown, then any check the
 * database names that the table does not, by its id, so that no judgement is hidden.
 */
export function shownChecks(judgements: readonly OperationCheck[]): ShownCheck[] {
  const byId = new Map(judgements.map((check) => [check.checkId, check]))
  const listed = CHECK_ORDER.map((id) => {
    const check = byId.get(id)
    return check === undefined ? unjudged(id) : judged(check)
  })
  const others = judgements
    .filter(({ checkId }) => !KNOWN.has(checkId))
    .sort((a, b) => a.checkId.localeCompare(b.checkId))
  return [...listed, ...others.map(judged)]
}
