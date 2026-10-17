import { useId } from 'react'

import { ALERT } from '../app/styles'
import { useAircraftModels, useFleets } from '../fleets/data'
import { Gone, Waiting } from '../fleets/Details'
import { changesFleets } from '../fleets/form'
import { useOrganization } from '../organizations/context'
import { useGeofences, useWaylines } from '../plans/data'
import { useSiteFrame } from '../scene/siteFrame'
import { useAssignments, useOperation, useStacks } from './data'
import {
  currentFlight,
  definitionOpen,
  fenceProblems,
  fleetStack,
  flightOutdated,
  storedFlight,
  type Choices,
} from './definition'
import { FlightConsole } from './FlightConsole'
import { OperationActions } from './OperationActions'
import { OperationChecks } from './OperationChecks'
import { OperationDefinition } from './OperationDefinition'
import { OperationDrones } from './OperationDrones'
import { OperationLog } from './OperationLog'
import { OperationOperators } from './OperationOperators'
import { STATE_TONE, STATE_WORDS } from './format'
import { CONSOLE_STATES } from './moves'
import { OperationPill } from './OperationPill'
import { OperationSteps } from './OperationSteps'

/**
 * An operation in the inspector (M4), what matters now first: its state and its steps, the move to
 * the next step, the flight console while it flies, the checks, and the drones it flies with their
 * live values; then its definition, folded once it may no longer change (FR-OPS-07), its operators
 * and its log.
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
  const choices: Choices = {
    waylines: waylines.data ?? [],
    fleets: fleets.data ?? [],
    geofences: geofences.data ?? [],
    stacks: stacks.data ?? [],
    models: models.data ?? [],
    origin,
  }
  const outdated = flightOutdated(current, assignment, choices)
  // The stored flight's own problems were judged at Save: once it is out of date, the flight the
  // definition makes now is judged instead, as Save and soc-operations would judge it.
  const fresh = outdated ? storedFlight(currentFlight(current, assignment, choices)) : stored
  const judged = fresh.ok ? fresh.flight : flight
  const problems =
    judged === null ? [] : [...judged.violations, ...fenceProblems(judged, geofence, origin)]
  const simulatorMode = fleetStack(assignment?.fleetId, choices)?.simulatorMode ?? null
  const editable = changesFleets(organization.role) && definitionOpen(current.state)

  return (
    <article aria-labelledby={heading}>
      <div className="flex items-start justify-between gap-3">
        <h3 id={heading} className="min-w-0 text-lg font-semibold break-words">
          {current.name}
        </h3>
        <OperationPill tone={STATE_TONE[current.state]}>{STATE_WORDS[current.state]}</OperationPill>
      </div>
      <OperationSteps state={current.state} />
      <OperationActions operationId={operationId} simulatorMode={simulatorMode} />
      {CONSOLE_STATES.includes(current.state) && (
        <FlightConsole
          operation={current}
          waypoints={flight === null ? null : flight.waypoints.length}
        />
      )}
      <OperationChecks operationId={operationId} />
      <OperationDrones
        assignment={assignment}
        flight={flight}
        problems={problems}
        error={stored.ok ? null : stored.message}
        outdated={outdated}
        choices={choices}
      />
      <OperationDefinition
        operation={current}
        assignment={assignment}
        choices={choices}
        editable={editable}
      />
      <OperationOperators operationId={operationId} state={current.state} />
      <OperationLog operationId={operationId} />
    </article>
  )
}
