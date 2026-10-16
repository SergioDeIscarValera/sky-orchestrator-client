import { skipToken, useQueries, useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import {
  aircraftKey,
  type Assignment,
  type Fleet,
  type Operation,
  type OperationState,
} from '../backend/backend'
import { useBackend } from '../backend/context'
import { useFleets } from '../fleets/data'
import { useOrganization } from '../organizations/context'
import { ASSIGNMENTS, organizationKey } from '../organizations/scope'
import { useOperations } from './data'

/**
 * Whether an operation is underway: its fleets are being readied to fly, or fly (FR-OPS-02). A draft
 * and a planned operation are not, nor is one that has ended, so the fleets of none of these are in one.
 */
const UNDERWAY: Readonly<Record<OperationState, boolean>> = {
  draft: false,
  planned: false,
  preparing: true,
  simulating: true,
  simulated: true,
  ready: true,
  launching: true,
  in_flight: true,
  paused: true,
  returning: true,
  completed: false,
  aborted: false,
  failed: false,
  cancelled: false,
}

export function isUnderway(state: OperationState): boolean {
  return UNDERWAY[state]
}

/** An operation with the assignments read for it. */
export interface OperationAssignments {
  readonly operation: Operation
  readonly assignments: readonly Assignment[]
}

/** The operation a fleet is in now, and the assignment that puts it there. */
export interface Involvement {
  readonly operation: Operation
  readonly assignment: Assignment
}

/**
 * The underway operation a fleet is in, and its assignment (FR-SCN-04). Operations that are not
 * underway leave their fleets out. With several underway, the newest by `createdAt` is the one; the
 * MVP has one wayline with one fleet (FR-OPS-01), so that case does not arise there. Null when the
 * fleet is in none.
 */
export function involvementOf(
  fleetId: string,
  operations: readonly OperationAssignments[],
): Involvement | null {
  let found: Involvement | null = null
  for (const { operation, assignments } of operations) {
    if (!isUnderway(operation.state)) continue
    const assignment = assignments.find((candidate) => candidate.fleetId === fleetId)
    if (assignment === undefined) continue
    if (found === null || Date.parse(operation.createdAt) > Date.parse(found.operation.createdAt)) {
      found = { operation, assignment }
    }
  }
  return found
}

/** The ids of the fleets that an operation's assignments fly. */
export function fleetIdsOf(assignments: readonly Assignment[]): ReadonlySet<string> {
  return new Set(assignments.map(({ fleetId }) => fleetId))
}

/**
 * The aircraft of the fleets whose ids are given, by `aircraftKey`. A fleet's aircraft is the one on the
 * wire under its gateway and aircraft serials (IR-FLE, IR-DEV). A fleet missing from `fleets` names none.
 */
export function aircraftKeysOf(
  fleetIds: ReadonlySet<string>,
  fleets: readonly Fleet[],
): ReadonlySet<string> {
  return new Set(
    fleets
      .filter(({ id }) => fleetIds.has(id))
      .map(({ gatewaySn, aircraftSn }) => aircraftKey(gatewaySn, aircraftSn)),
  )
}

/**
 * The aircraft of the selected operation's fleets, by `aircraftKey` (FR-SCN-04): while an operation is
 * selected the scene draws these and no other. Null with no operation selected, when every aircraft is
 * drawn. Empty until the operation's assignments and the fleets are read, so no other aircraft shows then.
 */
export function useOperationAircraft(operationId: string | null): ReadonlySet<string> | null {
  const backend = useBackend()
  const { organization } = useOrganization()
  const fleets = useFleets()
  const assignments = useQuery({
    queryKey: organizationKey(organization.id, ASSIGNMENTS, operationId),
    queryFn: operationId === null ? skipToken : () => backend.assignments(operationId),
  })
  return useMemo(
    () =>
      operationId === null
        ? null
        : aircraftKeysOf(fleetIdsOf(assignments.data ?? []), fleets.data ?? []),
    [operationId, assignments.data, fleets.data],
  )
}

/**
 * The underway operation a fleet is in now (`involvementOf`), read from the operations and from the
 * assignments of those underway. Null with no fleet, and until the operations are read.
 */
export function useFleetInvolvement(fleetId: string | null): Involvement | null {
  const backend = useBackend()
  const { organization } = useOrganization()
  const operations = useOperations()
  const underway = (operations.data ?? []).filter(({ state }) => isUnderway(state))
  const reads = useQueries({
    queries:
      fleetId === null
        ? []
        : underway.map(({ id }) => ({
            queryKey: organizationKey(organization.id, ASSIGNMENTS, id),
            queryFn: () => backend.assignments(id),
          })),
  })
  if (fleetId === null) return null
  const read = underway.flatMap((operation, index) => {
    const assignments = reads[index]?.data
    return assignments === undefined ? [] : [{ operation, assignments }]
  })
  return involvementOf(fleetId, read)
}
