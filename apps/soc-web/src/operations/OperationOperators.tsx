import { useId, useState } from 'react'

import type { Member, Operator, OperationState, OperatorRole } from '../backend/backend'
import { ALERT, FIELD } from '../app/styles'
import { Waiting } from '../fleets/Details'
import { changesFleets } from '../fleets/form'
import { useOrganization } from '../organizations/context'
import {
  useChangeOperator,
  useMembers,
  useNameOperator,
  useOperators,
  useRemoveOperator,
} from './data'
import { roleName } from '../organizations/format'
import { memberName, operatorRoleWord } from './format'
import { operatorsOpen } from './definition'

/** What a member is named in the operation: no operator, or a role. */
type Choice = 'none' | OperatorRole

function choiceOf(value: string): Choice {
  return value === 'pilot' || value === 'observer' ? value : 'none'
}

/**
 * The organization's members, each as an operator of the operation or not (FR-OPS-01, IR-OPR).
 * A pilot is an editor or an owner (FR-CMD-01), so only they are offered pilot; a pilot already
 * named who is no longer one stays shown, disabled, so the choice reads true. Each choice writes
 * at once. Frozen from launching on: then the roles only read.
 */
export function OperationOperators({
  operationId,
  state,
}: {
  readonly operationId: string
  readonly state: OperationState
}) {
  const { organization } = useOrganization()
  const members = useMembers()
  const operators = useOperators(operationId)
  const name = useNameOperator()
  const change = useChangeOperator()
  const remove = useRemoveOperator()
  const [busy, setBusy] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<{
    readonly profileId: string
    readonly message: string
  } | null>(null)
  const heading = useId()
  const editable = changesFleets(organization.role) && operatorsOpen(state)

  if (members.isPending || operators.isPending) return <Waiting>Loading the operators…</Waiting>
  if (members.isError) {
    return (
      <p role="alert" className={`${ALERT} mt-5`}>
        {members.error.message}
      </p>
    )
  }
  if (operators.isError) {
    return (
      <p role="alert" className={`${ALERT} mt-5`}>
        {operators.error.message}
      </p>
    )
  }

  const named = operators.data
  const operatorOf = (profileId: string): Operator | undefined =>
    named.find((operator) => operator.profileId === profileId)

  const choose = (member: Member, next: Choice) => {
    const { profileId } = member
    const current = operatorOf(profileId)
    const settle = {
      onSettled: () => {
        setBusy(null)
      },
      onError: (error: unknown) => {
        setRefusal({
          profileId,
          message: error instanceof Error ? error.message : String(error),
        })
      },
    }
    setRefusal(null)
    if (next === 'none') {
      if (current === undefined) return
      setBusy(profileId)
      remove.mutate({ operationId, profileId }, settle)
    } else if (current === undefined) {
      setBusy(profileId)
      name.mutate({ operationId, profileId, role: next }, settle)
    } else if (current.role !== next) {
      setBusy(profileId)
      change.mutate({ operationId, profileId, role: next }, settle)
    }
  }

  return (
    <section aria-labelledby={heading} className="mt-5">
      <h4 id={heading} className="text-muted text-xs font-semibold tracking-wider uppercase">
        Operators
      </h4>
      <ul aria-label="Operators" className="mt-3 flex flex-col gap-2">
        {members.data.map((member) => {
          const current = operatorOf(member.profileId)
          const label = memberName(member)
          const canPilot = member.role !== 'viewer'
          const shown = current?.role ?? 'none'
          return (
            <li key={member.profileId} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-heading truncate text-sm font-medium">{label}</p>
                  <p className="text-muted text-xs">{roleName(member.role)}</p>
                </div>
                {editable ? (
                  <span className="w-44 shrink-0">
                    <select
                      aria-label={`Operator role of ${label}`}
                      className={FIELD}
                      value={shown}
                      disabled={busy === member.profileId}
                      onChange={(event) => {
                        choose(member, choiceOf(event.target.value))
                      }}
                    >
                      <option value="none">None</option>
                      {(canPilot || current?.role === 'pilot') && (
                        <option value="pilot" disabled={!canPilot}>
                          Pilot
                        </option>
                      )}
                      <option value="observer">Observer</option>
                    </select>
                  </span>
                ) : (
                  <span className="text-heading text-sm">
                    {current === undefined ? 'None' : operatorRoleWord(current.role)}
                  </span>
                )}
              </div>
              {refusal?.profileId === member.profileId && (
                <p role="alert" className="text-danger-emphasis text-xs">
                  {refusal.message}
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
