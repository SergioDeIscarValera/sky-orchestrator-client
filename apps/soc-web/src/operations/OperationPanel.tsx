import { Plus, RotateCw } from 'lucide-react'

import type { Fleet, Operation, Wayline } from '../backend/backend'
import { useSelect, useSelection } from '../app/router'
import { ALERT, QUIET_BUTTON, UNAVAILABLE } from '../app/styles'
import { useFleets } from '../fleets/data'
import { Waiting } from '../fleets/Details'
import { changesFleets } from '../fleets/form'
import { useOrganization } from '../organizations/context'
import { useWaylines } from '../plans/data'
import { useAssignments, useCreateOperation, useOperations } from './data'
import { operationSummary } from './format'

const ROW =
  'hover:bg-primary-subtle aria-pressed:bg-primary-subtle flex min-w-0 flex-1 items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition-colors duration-200'

/** The name a new operation starts with, until its definition is saved in its detail (FR-OPS-01). */
const NEW_NAME = 'New operation'

/**
 * The organization's operations, newest first (M4). A row selects its operation for the
 * inspector; New creates a draft and selects it. Editors and owners create operations (FR-AUT-03).
 */
export function OperationPanel() {
  const operations = useOperations()
  const fleets = useFleets()
  const waylines = useWaylines()
  const selection = useSelection()
  const select = useSelect()
  const create = useCreateOperation()
  const { organization } = useOrganization()

  if (operations.isPending) return <Waiting>Loading the operations…</Waiting>
  if (operations.isError) {
    return (
      <div className="mt-3">
        <p role="alert" className={ALERT}>
          {operations.error.message}
        </p>
        <button
          type="button"
          className={`${QUIET_BUTTON} mt-3 -ml-3`}
          onClick={() => void operations.refetch()}
        >
          <RotateCw size={16} aria-hidden />
          Try again
        </button>
      </div>
    )
  }

  const writes = changesFleets(organization.role)
  const selectedId = selection?.kind === 'operation' ? selection.operationId : null
  const newestFirst = [...operations.data].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  )

  return (
    <div className="-mx-2 mt-3 flex min-h-0 flex-col gap-3 overflow-y-auto px-2">
      <div className="-ml-1 flex flex-wrap items-center gap-1">
        <button
          type="button"
          className={`${QUIET_BUTTON} ${UNAVAILABLE}`}
          aria-disabled={!writes || create.isPending}
          onClick={() => {
            if (!writes || create.isPending) return
            create.mutate(
              { name: NEW_NAME, geofenceId: null, takeoffSecurityHeightM: null },
              {
                onSuccess: (made) => {
                  select({ kind: 'operation', operationId: made.id })
                },
              },
            )
          }}
        >
          <Plus size={15} aria-hidden />
          New
        </button>
      </div>
      {create.isError && (
        <p role="alert" className={ALERT}>
          {create.error.message}
        </p>
      )}
      {newestFirst.length === 0 ? (
        <Waiting>No operations yet.</Waiting>
      ) : (
        <ul aria-label="Operations" className="flex flex-col gap-1">
          {newestFirst.map((operation) => (
            <OperationRow
              key={operation.id}
              operation={operation}
              fleets={fleets.data ?? []}
              waylines={waylines.data ?? []}
              selected={operation.id === selectedId}
              onToggle={() => {
                select(
                  operation.id === selectedId
                    ? null
                    : { kind: 'operation', operationId: operation.id },
                )
              }}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

/** One operation: its name, and on a muted line its state and its assignment's fleet and wayline. */
function OperationRow({
  operation,
  fleets,
  waylines,
  selected,
  onToggle,
}: {
  readonly operation: Operation
  readonly fleets: readonly Fleet[]
  readonly waylines: readonly Wayline[]
  readonly selected: boolean
  readonly onToggle: () => void
}) {
  const assignments = useAssignments(operation.id)
  const assignment = assignments.data?.[0]
  const fleet = fleets.find(({ id }) => id === assignment?.fleetId)
  const wayline = waylines.find(({ id }) => id === assignment?.waylineId)
  return (
    <li className="flex">
      <button type="button" aria-pressed={selected} className={ROW} onClick={onToggle}>
        <span className="flex min-w-0 flex-col">
          <span className="text-heading font-heading truncate text-sm font-semibold">
            {operation.name}
          </span>
          <span className="text-muted truncate text-xs">
            {operationSummary({
              state: operation.state,
              fleet: fleet?.name ?? null,
              wayline: wayline?.name ?? null,
            })}
          </span>
        </span>
      </button>
    </li>
  )
}
