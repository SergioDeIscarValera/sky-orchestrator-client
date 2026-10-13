import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'

import type {
  AssignmentChanges,
  AssignmentDraft,
  OperationChanges,
  OperationCheck,
  OperationDraft,
  OperationEvent,
  OperatorRole,
  PilotCommandVerb,
  StateEvent,
  Transition,
} from '../backend/backend'
import { useBackend } from '../backend/context'
import { checkBroadcast, eventBroadcast } from '../backend/operationRows'
import { useOrganization } from '../organizations/context'
import {
  ASSIGNMENTS,
  CHECKS,
  COMMAND_INTENTS,
  EVENTS,
  FLIGHTS,
  FLIGHT_STATES,
  MEMBERS,
  OPERATIONS,
  OPERATORS,
  REQUESTS,
  STACKS,
  organizationKey,
} from '../organizations/scope'

/** The operations' queries, under the open organization's key, kept current by useLiveState. */

export function useOperations() {
  const backend = useBackend()
  const { organization } = useOrganization()
  return useQuery({
    queryKey: organizationKey(organization.id, OPERATIONS),
    queryFn: () => backend.operations(organization.id),
  })
}

/** One operation, read with the organization's operations: a change to any refreshes it too. */
export function useOperation(operationId: string) {
  const backend = useBackend()
  const { organization } = useOrganization()
  return useQuery({
    queryKey: organizationKey(organization.id, OPERATIONS),
    queryFn: () => backend.operations(organization.id),
    select: (operations) => operations.find(({ id }) => id === operationId),
  })
}

export function useAssignments(operationId: string) {
  const backend = useBackend()
  const { organization } = useOrganization()
  return useQuery({
    queryKey: organizationKey(organization.id, ASSIGNMENTS, operationId),
    queryFn: () => backend.assignments(operationId),
  })
}

export function useOperators(operationId: string) {
  const backend = useBackend()
  const { organization } = useOrganization()
  return useQuery({
    queryKey: organizationKey(organization.id, OPERATORS, operationId),
    queryFn: () => backend.operators(operationId),
  })
}

/** The members to name as operators: no broadcast carries a membership, so a join reads them again. */
export function useMembers() {
  const backend = useBackend()
  const { organization } = useOrganization()
  return useQuery({
    queryKey: organizationKey(organization.id, MEMBERS),
    queryFn: () => backend.members(organization.id),
  })
}

export function useChecks(operationId: string) {
  const backend = useBackend()
  const { organization } = useOrganization()
  return useQuery({
    queryKey: organizationKey(organization.id, CHECKS, operationId),
    queryFn: () => backend.checks(operationId),
  })
}

export function useEvents(operationId: string) {
  const backend = useBackend()
  const { organization } = useOrganization()
  return useQuery({
    queryKey: organizationKey(organization.id, EVENTS, operationId),
    queryFn: () => backend.events(operationId),
  })
}

export function useRequests(operationId: string) {
  const backend = useBackend()
  const { organization } = useOrganization()
  return useQuery({
    queryKey: organizationKey(organization.id, REQUESTS, operationId),
    queryFn: () => backend.requests(operationId),
  })
}

export function useFlights(operationId: string) {
  const backend = useBackend()
  const { organization } = useOrganization()
  return useQuery({
    queryKey: organizationKey(organization.id, FLIGHTS, operationId),
    queryFn: () => backend.flights(operationId),
  })
}

export function useFlightStates(operationId: string) {
  const backend = useBackend()
  const { organization } = useOrganization()
  return useQuery({
    queryKey: organizationKey(organization.id, FLIGHT_STATES, operationId),
    queryFn: () => backend.flightStates(operationId),
  })
}

export function useCommands(operationId: string) {
  const backend = useBackend()
  const { organization } = useOrganization()
  return useQuery({
    queryKey: organizationKey(organization.id, COMMAND_INTENTS, operationId),
    queryFn: () => backend.commands(operationId),
  })
}

export function useStacks() {
  const backend = useBackend()
  const { organization } = useOrganization()
  return useQuery({
    queryKey: organizationKey(organization.id, STACKS),
    queryFn: () => backend.stacks(organization.id),
  })
}

/** Each write settles once what it changed is read again, so what it changed is on screen by then. */
function useOperationWrite<Input, Output>(
  names: readonly string[],
  write: (organizationId: string, input: Input) => Promise<Output>,
) {
  const queryClient = useQueryClient()
  const { organization } = useOrganization()
  return useMutation({
    mutationFn: (input: Input) => write(organization.id, input),
    onSuccess: () =>
      Promise.all(
        names.map((name) =>
          queryClient.invalidateQueries({ queryKey: organizationKey(organization.id, name) }),
        ),
      ),
  })
}

export function useCreateOperation() {
  const backend = useBackend()
  return useOperationWrite([OPERATIONS], (organizationId, draft: OperationDraft) =>
    backend.createOperation(organizationId, draft),
  )
}

export function useChangeOperation() {
  const backend = useBackend()
  return useOperationWrite(
    [OPERATIONS],
    (_organizationId, input: { id: string; changes: OperationChanges }) =>
      backend.changeOperation(input.id, input.changes),
  )
}

export function useAssign() {
  const backend = useBackend()
  return useOperationWrite(
    [ASSIGNMENTS, OPERATIONS],
    (organizationId, input: { operationId: string; draft: AssignmentDraft }) =>
      backend.assign(input.operationId, organizationId, input.draft),
  )
}

export function useChangeAssignment() {
  const backend = useBackend()
  return useOperationWrite(
    [ASSIGNMENTS, OPERATIONS],
    (_organizationId, input: { id: string; changes: AssignmentChanges }) =>
      backend.changeAssignment(input.id, input.changes),
  )
}

export function useUnassign() {
  const backend = useBackend()
  return useOperationWrite([ASSIGNMENTS, OPERATIONS], (_organizationId, assignmentId: string) =>
    backend.unassign(assignmentId),
  )
}

export function useNameOperator() {
  const backend = useBackend()
  return useOperationWrite(
    [OPERATORS],
    (organizationId, input: { operationId: string; profileId: string; role: OperatorRole }) =>
      backend.nameOperator(input.operationId, organizationId, input.profileId, input.role),
  )
}

export function useChangeOperator() {
  const backend = useBackend()
  return useOperationWrite(
    [OPERATORS],
    (_organizationId, input: { operationId: string; profileId: string; role: OperatorRole }) =>
      backend.changeOperator(input.operationId, input.profileId, input.role),
  )
}

export function useRemoveOperator() {
  const backend = useBackend()
  return useOperationWrite(
    [OPERATORS],
    (_organizationId, input: { operationId: string; profileId: string }) =>
      backend.removeOperator(input.operationId, input.profileId),
  )
}

/** Asks an operation to move. The client request id is the caller's: the same id asks once. */
export function useRequestTransition() {
  const backend = useBackend()
  return useOperationWrite(
    [REQUESTS],
    (
      _organizationId,
      input: { operationId: string; transition: Transition; clientRequestId: string },
    ) => backend.requestTransition(input.operationId, input.transition, input.clientRequestId),
  )
}

/** Asks a flight's aircraft to do a pilot's verb. The client request id is the caller's. */
export function useRequestCommand() {
  const backend = useBackend()
  return useOperationWrite(
    [COMMAND_INTENTS],
    (
      _organizationId,
      input: { flightId: string; verb: PilotCommandVerb; clientRequestId: string },
    ) => backend.requestCommand(input.flightId, input.verb, input.clientRequestId),
  )
}

/** A check with its new judgement in place of the old one, or appended when it is new. */
function withCheck(checks: readonly OperationCheck[], check: OperationCheck): OperationCheck[] {
  const known = checks.some(({ checkId }) => checkId === check.checkId)
  return known
    ? checks.map((existing) => (existing.checkId === check.checkId ? check : existing))
    : [...checks, check]
}

/** The log with an entry appended, once: an entry already read is not written twice. */
function withEvent(events: readonly OperationEvent[], event: OperationEvent): OperationEvent[] {
  return events.some(({ id }) => id === event.id) ? [...events] : [...events, event]
}

function invalidate(queryClient: QueryClient, queryKey: readonly unknown[], exact: boolean) {
  return queryClient.invalidateQueries({ queryKey, exact })
}

/**
 * Writes a log entry or a check the state topic carries whole into its cache, as it came, so the
 * log streams (FR-LOG-03) and a check shows within one sample (FR-OPS-04). A payload it cannot
 * read, or a cache not read yet, is read again instead: nothing is guessed into the cache.
 */
export async function placeRow(
  queryClient: QueryClient,
  organizationId: string,
  event: StateEvent,
): Promise<void> {
  if (event.kind === 'operation_check') {
    const placed = checkBroadcast(event.payload)
    if (placed === null) {
      await invalidate(queryClient, organizationKey(organizationId, CHECKS), false)
      return
    }
    const key = organizationKey(organizationId, CHECKS, placed.operationId)
    const cached = queryClient.getQueryData<OperationCheck[]>(key)
    if (cached === undefined) {
      await invalidate(queryClient, key, true)
      return
    }
    queryClient.setQueryData<OperationCheck[]>(key, withCheck(cached, placed.check))
    return
  }
  const entry = eventBroadcast(event.payload)
  if (entry === null) {
    await invalidate(queryClient, organizationKey(organizationId, EVENTS), false)
    return
  }
  const key = organizationKey(organizationId, EVENTS, entry.operationId)
  const cached = queryClient.getQueryData<OperationEvent[]>(key)
  if (cached === undefined) {
    await invalidate(queryClient, key, true)
    return
  }
  queryClient.setQueryData<OperationEvent[]>(key, withEvent(cached, entry))
}
