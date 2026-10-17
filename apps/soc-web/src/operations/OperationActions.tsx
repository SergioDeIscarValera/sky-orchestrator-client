import { useState } from 'react'

import { useAccount } from '../account/account'
import { ALERT, DANGER_BUTTON, PRIMARY_BUTTON, QUIET_BUTTON, UNAVAILABLE } from '../app/styles'
import type { Operation, OperationState, Transition } from '../backend/backend'
import { Waiting } from '../fleets/Details'
import { useOrganization } from '../organizations/context'
import { checksShown, shownChecks, type ShownCheck } from './checks'
import { useChecks, useOperation, useOperators, useRequests, useRequestTransition } from './data'
import { Failure } from './Failure'
import { asSentence, REQUEST_TONE, REQUEST_WORDS, TRANSITION_WORDS } from './format'
import { holdingBack, launchesInSimulator, nextMove, otherMoves } from './journey'
import { OperationPill } from './OperationPill'
import { reasonsOf, undecided, withheldBy } from './moves'
import { uuidV4 } from './uuid'

/** The moves a member confirms before they are asked: what each does, and the button that asks it. */
type Confirmed = 'simulate' | 'launch' | 'cancel'

interface Confirmation {
  readonly prompt: string
  readonly confirm: string
  readonly style: string
}

const CONFIRMATION: Readonly<Record<Confirmed, Confirmation>> = {
  simulate: { prompt: 'Fly in the simulator', confirm: 'Simulate', style: PRIMARY_BUTTON },
  launch: { prompt: 'Fly for real', confirm: 'Launch', style: DANGER_BUTTON },
  cancel: { prompt: 'Cancel for good', confirm: 'Cancel operation', style: DANGER_BUTTON },
}

/** A launch from simulated flies in the simulator, and is confirmed as such (FR-OPS-13). */
const IN_SIMULATOR: Confirmation = {
  prompt: 'Launch in the simulator',
  confirm: 'Launch',
  style: PRIMARY_BUTTON,
}

function confirmed(transition: Transition): transition is Confirmed {
  return transition in CONFIRMATION
}

function confirmationOf(move: Confirmed, state: OperationState): Confirmation {
  return move === 'launch' && launchesInSimulator(state) ? IN_SIMULATOR : CONFIRMATION[move]
}

/** The next step's button: a real launch in the danger fill; the others primary, the simulator's too. */
function nextStyle(move: Transition, state: OperationState): string {
  const real = move === 'launch' && !launchesInSimulator(state)
  return `${real ? DANGER_BUTTON : PRIMARY_BUTTON} ${UNAVAILABLE}`
}

const OTHER = `${QUIET_BUTTON} ${UNAVAILABLE} disabled:cursor-wait disabled:opacity-70`

/** A confirmed move asked for, and the state it was asked in: a state that has since moved asks again. */
interface Asking {
  readonly move: Confirmed
  readonly state: OperationState
}

/**
 * The operation's moves (FR-OPS-02, FR-OPS-09, FR-OPS-13): the one that takes it to its next step as
 * the main button, held back by the blocking checks that do not pass and saying how many; beside it,
 * going back or cancelling. A move the member may not ask stays shown, disabled, with its reason. The
 * latest request shows with its outcome, and a refusal with its reasons.
 */
export function OperationActions({
  operationId,
  simulatorMode,
}: {
  readonly operationId: string
  /** The mode of the stack the operation flies on, as its status last said; null while not said. */
  readonly simulatorMode: boolean | null
}) {
  const operation = useOperation(operationId)
  if (operation.isPending) return <Waiting>Loading the actions…</Waiting>
  if (operation.isError) {
    return <Failure message={operation.error.message} onRetry={() => void operation.refetch()} />
  }
  if (operation.data === undefined) return null
  return <Moves operation={operation.data} simulatorMode={simulatorMode} />
}

function Moves({
  operation,
  simulatorMode,
}: {
  readonly operation: Operation
  readonly simulatorMode: boolean | null
}) {
  const { organization } = useOrganization()
  const account = useAccount()
  const operators = useOperators(operation.id)
  const requests = useRequests(operation.id)
  const ask = useRequestTransition()
  const [asking, setAsking] = useState<Asking | null>(null)

  if (operators.isPending || requests.isPending) return <Waiting>Loading the actions…</Waiting>
  if (operators.isError) {
    return <Failure message={operators.error.message} onRetry={() => void operators.refetch()} />
  }
  if (requests.isError) {
    return <Failure message={requests.error.message} onRetry={() => void requests.refetch()} />
  }

  const pilot = operators.data.some(
    ({ profileId, role }) => profileId === account.userId && role === 'pilot',
  )
  const member = { role: organization.role, pilot }
  const latest = requests.data[0]
  const busy = ask.isPending || undecided(latest)
  const next = nextMove(operation.state, simulatorMode)
  const others = otherMoves(operation.state, simulatorMode)
  const confirming =
    asking !== null &&
    asking.state === operation.state &&
    (asking.move === next || others.includes(asking.move))
      ? asking
      : null
  const reasons = reasonsOf(latest)
  const confirmation =
    confirming === null ? null : confirmationOf(confirming.move, confirming.state)

  const send = (transition: Transition) => {
    ask.mutate({ operationId: operation.id, transition, clientRequestId: uuidV4() })
  }
  const press = (transition: Transition) => {
    if (confirmed(transition)) setAsking({ move: transition, state: operation.state })
    else send(transition)
  }

  return (
    <div className="mt-4">
      {confirming !== null && confirmation !== null ? (
        <div
          role="group"
          aria-label={confirmation.prompt}
          className="flex flex-wrap items-center gap-2"
        >
          <span className="text-heading text-sm font-semibold">{confirmation.prompt}</span>
          <button
            type="button"
            className={confirmation.style}
            disabled={busy}
            onClick={() => {
              setAsking(null)
              send(confirming.move)
            }}
          >
            {confirmation.confirm}
          </button>
          {/* The safe answer takes the focus: the buttons it replaces would otherwise lose it. */}
          <button
            type="button"
            className={QUIET_BUTTON}
            autoFocus
            onClick={() => {
              setAsking(null)
            }}
          >
            Back
          </button>
        </div>
      ) : (
        (next !== null || others.length > 0) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {next !== null && (
              <NextMove
                operation={operation}
                move={next}
                withheld={withheldBy(next, member)}
                busy={busy}
                onPress={press}
              />
            )}
            {others.length > 0 && (
              <div className="ml-auto flex flex-wrap items-center gap-1">
                {others.map((transition) => {
                  const withheld = withheldBy(transition, member)
                  return (
                    <button
                      key={transition}
                      type="button"
                      className={OTHER}
                      aria-disabled={withheld !== null}
                      disabled={withheld === null && busy}
                      title={withheld ?? undefined}
                      onClick={() => {
                        if (withheld === null) press(transition)
                      }}
                    >
                      {TRANSITION_WORDS[transition]}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )
      )}
      {latest !== undefined && (
        <p role="status" className="mt-3 flex items-center gap-2 text-sm">
          {TRANSITION_WORDS[latest.transition]}
          <OperationPill tone={REQUEST_TONE[latest.status]}>
            {REQUEST_WORDS[latest.status]}
          </OperationPill>
        </p>
      )}
      {reasons.length > 0 && (
        <div role="alert" className={`${ALERT} mt-3`}>
          <ul className="flex flex-col gap-1">
            {reasons.map((reason, index) => (
              <li key={index}>{asSentence(reason)}</li>
            ))}
          </ul>
        </div>
      )}
      {ask.isError && (
        <p role="alert" className={`${ALERT} mt-3`}>
          {ask.error.message}
        </p>
      )}
    </div>
  )
}

/**
 * The next step's button. A simulation or a launch waits for every blocking check: while any does not
 * pass, the button stays disabled and says how many hold it back; the checks below name them.
 */
function NextMove({
  operation,
  move,
  withheld,
  busy,
  onPress,
}: {
  readonly operation: Operation
  readonly move: Transition
  readonly withheld: string | null
  readonly busy: boolean
  readonly onPress: (move: Transition) => void
}) {
  const checks = useChecks(operation.id, checksShown(operation.state))
  const held: ShownCheck[] =
    checks.data === undefined ? [] : holdingBack(move, shownChecks(checks.data))
  const gatedAndUnread = checksShown(operation.state) && checks.data === undefined
  const blocked = withheld !== null || held.length > 0
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        className={nextStyle(move, operation.state)}
        aria-disabled={blocked}
        aria-describedby={held.length > 0 ? `${operation.id}-held` : undefined}
        disabled={!blocked && (busy || gatedAndUnread)}
        title={withheld ?? undefined}
        onClick={() => {
          if (!blocked) onPress(move)
        }}
      >
        {TRANSITION_WORDS[move]}
      </button>
      {held.length > 0 && (
        <span id={`${operation.id}-held`} className="text-muted text-sm">
          {held.length === 1 ? '1 check not passing' : `${String(held.length)} checks not passing`}
        </span>
      )}
    </div>
  )
}
