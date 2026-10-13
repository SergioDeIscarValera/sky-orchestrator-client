import { useId } from 'react'

import { ALERT } from '../app/styles'
import { useAircraftModels, useFleets } from '../fleets/data'
import { Gone, Waiting } from '../fleets/Details'
import { changesFleets } from '../fleets/form'
import { useOrganization } from '../organizations/context'
import { useGeofences, useWaylines } from '../plans/data'
import { useSiteFrame } from '../scene/siteFrame'
import { useAssignments, useOperation, useStacks } from './data'
import { definitionOpen, fenceProblems, storedFlight } from './definition'
import { OperationActions } from './OperationActions'
import { OperationChecks } from './OperationChecks'
import { OperationDefinition, type Choices } from './OperationDefinition'
import { OperationFlight } from './OperationFlight'
import { OperationLog } from './OperationLog'
import { OperationOperators } from './OperationOperators'
import { STATE_TONE, STATE_WORDS } from './format'
import { OperationPill } from './OperationPill'

/**
 * An operation in the inspector (M4): its state, its definition and the flight its assignment
 * stores, its operators, and the preparation's three slots (checks, transitions, log) that
 * another branch fills. The definition may change only while its state is open (FR-OPS-07).
 */
export function OperationDetail({ operationId }: { readonly operationId: string }) {
  const { organization } = useOrganization()
  const operation = useOperation(operationId)
  const assignments = useAssignments(operationId)
  const waylines = useWaylines()
  const fleets = useFleets()
  const geofences = useGeofences()
  const stacks = useStacks()
  const models = useAircraftModels()
  const { origin, siteModel } = useSiteFrame()
  const heading = useId()

  // Every list the definition takes its choices from, and the catalogue its speed is held to, read first.
  const reads = [operation, assignments, waylines, fleets, geofences, stacks, models]
  const failed = reads.find((read) => read.isError)
  if (failed !== undefined) {
    return (
      <p role="alert" className={ALERT}>
        {failed.error.message}
      </p>
    )
  }
  // The site's frame is read before a flight is measured in it: the terrain's origin, when there is one.
  const siteReading = siteModel.isPending && organization.position !== null
  if (reads.some((read) => read.isPending) || siteReading) {
    return <Waiting>Loading the operation…</Waiting>
  }
  const current = operation.data
  if (current === undefined) {
    return (
      <Gone>
        {organization.name} has no operation with this link: it may belong to another organization.
      </Gone>
    )
  }

  const assignment = assignments.data?.[0] ?? null
  const stored = storedFlight(assignment?.flight ?? null)
  const flight = stored.ok ? stored.flight : null
  const geofence = geofences.data?.find(({ id }) => id === current.geofenceId)
  const problems =
    flight === null ? [] : [...flight.violations, ...fenceProblems(flight, geofence, origin)]
  const choices: Choices = {
    waylines: waylines.data ?? [],
    fleets: fleets.data ?? [],
    geofences: geofences.data ?? [],
    stacks: stacks.data ?? [],
    models: models.data ?? [],
    origin,
  }
  const editable = changesFleets(organization.role) && definitionOpen(current.state)

  return (
    <article aria-labelledby={heading}>
      <div className="flex items-start justify-between gap-3">
        <h3 id={heading} className="min-w-0 text-lg font-semibold break-words">
          {current.name}
        </h3>
        <OperationPill tone={STATE_TONE[current.state]}>{STATE_WORDS[current.state]}</OperationPill>
      </div>
      <OperationDefinition
        operation={current}
        assignment={assignment}
        choices={choices}
        editable={editable}
      />
      <OperationFlight
        flight={flight}
        problems={problems}
        error={stored.ok ? null : stored.message}
      />
      <OperationOperators operationId={operationId} state={current.state} />
      <OperationChecks operationId={operationId} />
      <OperationActions operationId={operationId} />
      <OperationLog operationId={operationId} />
    </article>
  )
}
