import type { OperationState, Transition } from '../backend/backend'
import type { ShownCheck } from './checks'
import { OFFERED } from './moves'

/**
 * An operation's journey as the inspector shows it (FR-OPS-02): five steps, each done, current or
 * still to come, so the state machine's fourteen states read as where the operation is and what
 * comes next. The states stay the lifecycle's own; the steps only group them.
 */
export const STEPS = ['plan', 'prepare', 'simulate', 'launch', 'done'] as const

export type Step = (typeof STEPS)[number]

export const STEP_WORDS: Readonly<Record<Step, string>> = {
  plan: 'Plan',
  prepare: 'Prepare',
  simulate: 'Simulate',
  launch: 'Launch',
  done: 'Done',
}

/** The step each state is on. A simulated operation waits on the launch, which its checks gate. */
const STEP_OF: Readonly<Record<OperationState, Step>> = {
  draft: 'plan',
  planned: 'prepare',
  preparing: 'prepare',
  simulating: 'simulate',
  simulated: 'launch',
  ready: 'launch',
  launching: 'launch',
  in_flight: 'launch',
  paused: 'launch',
  returning: 'launch',
  completed: 'done',
  aborted: 'done',
  failed: 'done',
  cancelled: 'done',
}

/** Done before the current step; the current one is waiting, running, or how the operation ended. */
export type StepState = 'done' | 'current' | 'running' | 'todo' | 'ended-well' | 'ended-badly'

/** States in which the current step is running on its own: the operator waits, or flies. */
const RUNNING: ReadonlySet<OperationState> = new Set<OperationState>([
  'preparing',
  'simulating',
  'launching',
  'in_flight',
  'paused',
  'returning',
])

/**
 * Each step's state for an operation in `state`. A closed operation's last step says how it ended;
 * the steps before it are done, but for a cancelled one, which never flew: those are left to come.
 */
export function stepsOf(state: OperationState): readonly { step: Step; state: StepState }[] {
  const current = STEPS.indexOf(STEP_OF[state])
  return STEPS.map((step, index) => {
    if (index < current) return { step, state: state === 'cancelled' ? 'todo' : 'done' }
    if (index > current) return { step, state: 'todo' }
    if (step === 'done') {
      return { step, state: state === 'completed' ? 'ended-well' : 'ended-badly' }
    }
    return { step, state: RUNNING.has(state) ? 'running' : 'current' }
  })
}

/**
 * The move that takes an operation to its next step, if a member asks one in this state: planning
 * a draft, preparing a plan, simulating a prepared one, launching a ready one. None while a step
 * runs on its own, or once it has closed. A simulated operation launches in the simulator while its
 * stack is in simulator mode (FR-OPS-13); in real mode, or while the mode is not known, it waits
 * for ready.
 */
const NEXT: Readonly<Partial<Record<OperationState, Transition>>> = {
  draft: 'plan',
  planned: 'prepare',
  preparing: 'simulate',
  ready: 'launch',
}

export function nextMove(
  state: OperationState,
  simulatorMode: boolean | null = null,
): Transition | null {
  if (state === 'simulated') return simulatorMode === true ? 'launch' : null
  return NEXT[state] ?? null
}

/** Whether a launch from this state flies in the simulator: one from simulated does (FR-OPS-13). */
export function launchesInSimulator(state: OperationState): boolean {
  return state === 'simulated'
}

/**
 * The other moves a member may ask in this state, beside the next one: going back, or cancelling
 * the operation. A stop is the flight console's, beside the aircraft it brings home; a launch is
 * only ever the next move.
 */
export function otherMoves(
  state: OperationState,
  simulatorMode: boolean | null = null,
): readonly Transition[] {
  const next = nextMove(state, simulatorMode)
  return OFFERED[state].filter((move) => move !== next && move !== 'stop' && move !== 'launch')
}

/** The moves whose request the checks decide: soc-operations refuses them while a blocking one does not pass. */
const GATED: ReadonlySet<Transition> = new Set<Transition>(['simulate', 'launch'])

/**
 * The blocking checks that keep a gated move from being asked, in the checks' order: every one that
 * has not passed, unknown included, since an unknown check is never a pass (FR-OPS-04). None for a
 * move the checks do not gate.
 */
export function holdingBack(move: Transition, checks: readonly ShownCheck[]): ShownCheck[] {
  if (!GATED.has(move)) return []
  return checks.filter((check) => check.blocking && check.state !== 'pass')
}

/** How the checks stand, as the inspector's summary counts them: passing out of all. */
export function checkCount(checks: readonly ShownCheck[]): {
  readonly passing: number
  readonly total: number
} {
  return { passing: checks.filter(({ state }) => state === 'pass').length, total: checks.length }
}
