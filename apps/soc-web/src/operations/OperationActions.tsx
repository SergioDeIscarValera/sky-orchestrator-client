import { useState } from 'react'

import { useAccount } from '../account/account'
import { ALERT, DANGER_BUTTON, PRIMARY_BUTTON, QUIET_BUTTON, UNAVAILABLE } from '../app/styles'
import type { Operation, OperationState, Transition } from '../backend/backend'
import { Waiting } from '../fleets/Details'
import { useOrganization } from '../organizations/context'
import { useOperation, useOperators, useRequests, useRequestTransition } from './data'
import { Failure } from './Failure'
import { REQUEST_TONE, REQUEST_WORDS, TRANSITION_WORDS } from './format'
import { OperationPill } from './OperationPill'
import { OFFERED, isFlightMove, reasonsOf, undecided, withheldBy, type FlightMove } from './moves'
import { uuidV4 } from './uuid'

/** What a pilot confirms before a flight move is asked: what it does, and the button that asks it (FR-OPS-09). */
const CONFIRMATION: Readonly<
  Record<FlightMove, { readonly prompt: string; readonly confirm: string; readonly style: string }>
> = {
  simulate: { prompt: 'Fly in the simulator', confirm: 'Simulate', style: PRIMARY_BUTTON },
  launch: { prompt: 'Fly for real', confirm: 'Launch', style: DANGER_BUTTON },
  stop: { prompt: 'Every aircraft returns home', confirm: 'Stop', style: DANGER_BUTTON },
}

const MOVE = `${QUIET_BUTTON} ${UNAVAILABLE} disabled:cursor-wait disabled:opacity-70`

/** A flight move asked, and the state it was asked in: a state that has since moved asks again. */
interface Asking {
  readonly move: FlightMove
  readonly state: OperationState
}

/**
 * The moves a member may ask an operation now, as buttons, and the latest request with its outcome
 * (FR-OPS-02, FR-OPS-09). A move the member may not ask stays shown, disabled, with its reason.
 */
export function OperationActions({ operationId }: { readonly operationId: string }) {
  const operation = useOperation(operationId)
  if (operation.isPending) return <Waiting>Loading the actions…</Waiting>
  if (operation.isError) {
    return <Failure message={operation.error.message} onRetry={() => void operation.refetch()} />
  }
  if (operation.data === undefined) return null
  return <Moves operation={operation.data} />
}

function Moves({ operation }: { readonly operation: Operation }) {
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
  const latest = requests.data[0]
  const busy = ask.isPending || undecided(latest)
  const offered = OFFERED[operation.state]
  const confirming =
    asking !== null && asking.state === operation.state && offered.includes(asking.move)
      ? asking
      : null
  const reasons = reasonsOf(latest)

  const send = (transition: Transition) => {
    ask.mutate({ operationId: operation.id, transition, clientRequestId: uuidV4() })
  }

  return (
    <div className="mt-3">
      {confirming !== null ? (
        <div
          role="group"
          aria-label={CONFIRMATION[confirming.move].prompt}
          className="flex flex-wrap items-center gap-2"
        >
          <span className="text-heading text-sm font-semibold">
            {CONFIRMATION[confirming.move].prompt}
          </span>
          <button
            type="button"
            className={CONFIRMATION[confirming.move].style}
            disabled={busy}
            onClick={() => {
              setAsking(null)
              send(confirming.move)
            }}
          >
            {CONFIRMATION[confirming.move].confirm}
          </button>
          <button
            type="button"
            className={QUIET_BUTTON}
            onClick={() => {
              setAsking(null)
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="-ml-3 flex flex-wrap items-center gap-1">
          {offered.map((transition) => {
            const withheld = withheldBy(transition, { role: organization.role, pilot })
            return (
              <button
                key={transition}
                type="button"
                className={MOVE}
                aria-disabled={withheld !== null}
                disabled={withheld === null && busy}
                title={withheld ?? undefined}
                onClick={() => {
                  if (withheld !== null) return
                  if (isFlightMove(transition)) {
                    setAsking({ move: transition, state: operation.state })
                  } else {
                    send(transition)
                  }
                }}
              >
                {TRANSITION_WORDS[transition]}
              </button>
            )
          })}
        </div>
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
              <li key={index}>{reason}</li>
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
