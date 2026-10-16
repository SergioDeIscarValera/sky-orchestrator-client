import { useQueries } from '@tanstack/react-query'
import { useState } from 'react'

import { useAccount } from '../account/account'
import { ALERT, CARD } from '../app/styles'
import type { Flight, Operator, PilotCommandVerb } from '../backend/backend'
import { useBackend } from '../backend/context'
import { useOrganization } from '../organizations/context'
import { flightsQuery, operatorsQuery, useOperations, useRequestCommand } from './data'
import { HoldButton } from './HoldButton'
import { airborneOf, barPlan } from './safetyBar'
import { uuidV4 } from './uuid'

/** A refusal's words, whatever it was thrown as. */
function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * Pause all and return all home, on every screen (FR-CMD-07), shown while an operation's aircraft launch
 * or fly. A hold sends its command to every flight not ended of the operations the member pilots, each
 * with a client request id of its own. It reads only the operations, their operators and their flights,
 * so the other regions of the console failing leave it working.
 */
export function SafetyBar() {
  const { organization } = useOrganization()
  const account = useAccount()
  const backend = useBackend()
  const operations = useOperations()
  const command = useRequestCommand()
  const [refusal, setRefusal] = useState<string | null>(null)

  const airborne = airborneOf(operations.data ?? [])
  // One read per airborne operation, under the keys the flight console reads too: the cache holds one copy.
  const flightReads = useQueries({
    queries: airborne.map(({ id }) => flightsQuery(backend, organization.id, id)),
  })
  const operatorReads = useQueries({
    queries: airborne.map(({ id }) => operatorsQuery(backend, organization.id, id)),
  })

  if (operations.isPending) return null
  if (!operations.isError && airborne.length === 0) return null

  const flightsOf = new Map<string, readonly Flight[]>(
    airborne.flatMap((operation, index) => {
      const data = flightReads[index]?.data
      return data === undefined ? [] : [[operation.id, data] as const]
    }),
  )
  const operatorsOf = new Map<string, readonly Operator[]>(
    airborne.flatMap((operation, index) => {
      const data = operatorReads[index]?.data
      return data === undefined ? [] : [[operation.id, data] as const]
    }),
  )
  const failures = [operations, ...flightReads, ...operatorReads].flatMap((read) =>
    read.isError ? [read.error.message] : [],
  )
  const failure = failures[0] ?? null
  const plan = barPlan({
    role: organization.role,
    userId: account.userId,
    operations: operations.data ?? [],
    operators: operatorsOf,
    flights: flightsOf,
    failure,
  })

  const send = (verb: PilotCommandVerb) => {
    setRefusal(null)
    void Promise.allSettled(
      plan.targets.map(({ flightId }) =>
        command.mutateAsync({ flightId, verb, clientRequestId: uuidV4() }),
      ),
    ).then((outcomes) => {
      const refused = outcomes.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      )
      setRefusal(refused === undefined ? null : messageOf(refused.reason))
    })
  }

  const message = refusal ?? failure
  return (
    <section
      aria-label="Safety controls"
      className={`${CARD} pointer-events-auto flex flex-col gap-2 p-2`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <HoldButton
          tone="danger"
          reason={plan.reason}
          onConfirm={() => {
            send('pause')
          }}
        >
          Pause all
        </HoldButton>
        <HoldButton
          tone="danger"
          reason={plan.reason}
          onConfirm={() => {
            send('return_home')
          }}
        >
          Return all home
        </HoldButton>
      </div>
      {message !== null && (
        <p role="alert" className={ALERT}>
          {message}
        </p>
      )}
    </section>
  )
}
