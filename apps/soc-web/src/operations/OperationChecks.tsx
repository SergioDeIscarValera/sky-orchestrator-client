import { Waiting } from '../fleets/Details'
import { useChecks, useOperation } from './data'
import { Failure } from './Failure'
import { checksShown, shownChecks, type ShownCheck } from './checks'
import { CHECK_STATE_TONE, CHECK_STATE_WORDS, checkWords, valueWords } from './format'
import { OperationPill } from './OperationPill'
import { Section } from './Section'

/**
 * An operation's preflight checks in FR-OPS-05's order, each with its state and what it measured
 * (FR-OPS-04). Nothing shows while the operation is a draft or planned, or once it is closed.
 */
export function OperationChecks({ operationId }: { readonly operationId: string }) {
  const operation = useOperation(operationId)
  if (operation.isPending) return <Waiting>Loading the checks…</Waiting>
  if (operation.isError) {
    return <Failure message={operation.error.message} onRetry={() => void operation.refetch()} />
  }
  if (operation.data === undefined || !checksShown(operation.data.state)) return null
  return (
    <Section title="Checks">
      <Judgements operationId={operationId} />
    </Section>
  )
}

/** The checks are read only once they show, so a draft or a closed operation reads none. */
function Judgements({ operationId }: { readonly operationId: string }) {
  const checks = useChecks(operationId)
  if (checks.isPending) return <Waiting>Loading the checks…</Waiting>
  if (checks.isError) {
    return <Failure message={checks.error.message} onRetry={() => void checks.refetch()} />
  }
  return (
    <ul aria-label="Preflight checks" className="divide-border mt-3 flex flex-col divide-y">
      {shownChecks(checks.data).map((check) => (
        <CheckRow key={check.id} check={check} />
      ))}
    </ul>
  )
}

function CheckRow({ check }: { readonly check: ShownCheck }) {
  const value = valueWords(check.value)
  return (
    <li className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-heading text-sm font-medium">{checkWords(check.id)}</p>
          {!check.blocking && <OperationPill tone="muted">Not blocking</OperationPill>}
        </div>
        {value !== null && <p className="text-muted text-xs break-words tabular-nums">{value}</p>}
        {check.detail !== null && check.detail !== '' && (
          <p className="text-muted text-xs break-words">{check.detail}</p>
        )}
      </div>
      <OperationPill tone={CHECK_STATE_TONE[check.state]}>
        {CHECK_STATE_WORDS[check.state]}
      </OperationPill>
    </li>
  )
}
