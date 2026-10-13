import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'

import {
  BackendError,
  FieldRefusedError,
  type Assignment,
  type AssignmentChanges,
  type AssignmentDraft,
  type CommandIntent,
  type Flight,
  type FlightState,
  type Member,
  type Operation,
  type OperationChanges,
  type OperationCheck,
  type OperationDraft,
  type OperationEvent,
  type Operator,
  type OperatorRole,
  type PilotCommandVerb,
  type RefusedField,
  type StackView,
  type Transition,
  type TransitionRequest,
} from './backend'
import {
  ASSIGNMENT_ROW,
  CHECK_ROW,
  COMMAND_ROW,
  EVENT_ROW,
  FLIGHT_ROW,
  FLIGHT_STATE_ROW,
  MEMBER_ROW,
  OPERATION_ROW,
  OPERATOR_ROW,
  STACK_ROW,
  TRANSITION_REQUEST_ROW,
  assignmentOf,
  checkOf,
  commandOf,
  eventOf,
  flightOf,
  flightStateOf,
  memberOf,
  operationOf,
  operatorOf,
  requestOf,
  stackOf,
} from './operationRows'
import { rows } from './rows'

/** A refusal a constraint stands for: the field it names, and the plain words for it. */
interface Refusal {
  readonly field: RefusedField | null
  readonly message: string
}

/**
 * What each named constraint of migration 0010 means to the person filling the form (FR-OPS-01,
 * FR-ASG, FR-OPR). PostgREST names the constraint in the message of a constraint it checks, and
 * the foreign keys of 0010 that name none get PostgreSQL's own names. The fake backend refuses
 * through this same table, so the two agree.
 */
const REFUSALS = {
  operation_name_given: { field: 'name', message: 'An operation needs a name.' },
  operation_height_positive: {
    field: 'takeoffSecurityHeightM',
    message: 'The takeoff security height must be above zero.',
  },
  assignment_speed_positive: {
    field: 'speedMs',
    message: 'The speed the fleet flies the wayline at must be above zero.',
  },
  assignment_flight_object: {
    field: 'flight',
    message: 'The wayline as the operation flies it must be an object.',
  },
  assignment_wayline_once: {
    field: 'waylineId',
    message: 'The operation already flies this wayline.',
  },
  assignment_fleet_once: {
    field: 'fleetId',
    message: 'The operation already flies with this fleet.',
  },
  assignment_one_in_mvp: {
    field: null,
    message: 'An operation flies one wayline with one fleet in the MVP.',
  },
  operation_definition_frozen: {
    field: null,
    message:
      "The operation's definition is fixed from simulating on, and its operators from launching on.",
  },
  operation_closed: { field: null, message: 'This operation has ended, and does not change.' },
  command_flight_ended: {
    field: null,
    message: 'This flight has ended: its aircraft takes no more commands.',
  },
  command_undo_before_execution: {
    field: null,
    message: 'This flight already executes: an undo cancels only one not started yet.',
  },
  operator_live_member: {
    field: 'profileId',
    message: 'Only a live member of a live organization is named an operator.',
  },
  operations_geofence_id_organization_id_fkey: {
    field: 'geofenceId',
    message: "This geofence is not one of the organization's.",
  },
  assignments_wayline_id_organization_id_fkey: {
    field: 'waylineId',
    message: "This wayline is not one of the organization's.",
  },
  assignments_fleet_id_organization_id_fkey: {
    field: 'fleetId',
    message: "This fleet is not one of the organization's.",
  },
  operators_organization_id_profile_id_fkey: {
    field: 'profileId',
    message: 'Only a member of the organization can be named an operator.',
  },
  operators_pkey: {
    field: 'profileId',
    message: 'This member is already an operator of the operation.',
  },
} satisfies Readonly<Record<string, Refusal>>

export type OperationConstraint = keyof typeof REFUSALS

/**
 * The refusals a trigger or a function raises with USING CONSTRAINT: PostgREST sends their
 * message and no constraint name, so the message names the constraint instead.
 */
export const RAISED: ReadonlyArray<readonly [RegExp, OperationConstraint]> = [
  [/one assignment in the MVP/, 'assignment_one_in_mvp'],
  [/its (?:definition|operators) (?:is|are) fixed once it is/, 'operation_definition_frozen'],
  [/closed when it became/, 'operation_closed'],
  [/it has ended/, 'command_flight_ended'],
  [/it executes, so it is no longer undone/, 'command_undo_before_execution'],
  [/an operator is a live member of its organization/, 'operator_live_member'],
]

/** The words for the role a request needs: soc.request_transition and request_command raise these. */
export const ROLE_MESSAGES = {
  editor: 'Only editors and owners ask an operation to move.',
  pilot: 'Only a pilot of the operation asks it to simulate, launch or stop.',
  command: 'Only a pilot of the operation commands its aircraft.',
} as const

export const ROLE_SAID: ReadonlyArray<readonly [RegExp, string]> = [
  [/an editor of its organization asks it to move/, ROLE_MESSAGES.editor],
  [/only its pilots/, ROLE_MESSAGES.pilot],
  [/only a pilot of its operation commands it/, ROLE_MESSAGES.command],
]

const CHECK_VIOLATION = '23514'
const NOT_ALLOWED = '42501'

function isOperationConstraint(name: string): name is OperationConstraint {
  return Object.hasOwn(REFUSALS, name)
}

/** The refusal a named constraint stands for, from the constraint's name or the words it raised. */
function namedRefusal(message: string): Refusal | undefined {
  const constraint = /constraint "([^"]+)"/.exec(message)?.[1]
  if (constraint !== undefined && isOperationConstraint(constraint)) return REFUSALS[constraint]
  const raised = RAISED.find(([said]) => said.test(message))
  return raised === undefined ? undefined : REFUSALS[raised[1]]
}

/** The refusal a named constraint stands for: its field, and the plain message for it. */
export function refusedBy(
  constraint: OperationConstraint,
  code: string | null = CHECK_VIOLATION,
): FieldRefusedError {
  const { field, message } = REFUSALS[constraint]
  return new FieldRefusedError(message, field, code)
}

/** A write by a member who may only read: row security refuses it with 42501 and names no field. */
export function notAllowedRefusal(): FieldRefusedError {
  return new FieldRefusedError('Only editors and owners change operations.', null, NOT_ALLOWED)
}

/** A request by a member without the role it needs: the function refuses it with 42501. */
export function roleRefusal(message: string): FieldRefusedError {
  return new FieldRefusedError(message, null, NOT_ALLOWED)
}

/**
 * Row security hides a row from a viewer's update or delete instead of refusing it, so a write
 * that returns no row changed nothing: the row is not the organization's, or the role only reads.
 */
export function untouched(kind: 'operation' | 'assignment' | 'operator'): FieldRefusedError {
  return new FieldRefusedError(
    `Nothing changed: this ${kind} is not one your role in this organization can change.`,
    null,
  )
}

/** The refusal a database error means for an operation; any other error passes on unchanged. */
export function refusal(error: PostgrestError): BackendError {
  const named = namedRefusal(error.message)
  if (named !== undefined) return new FieldRefusedError(named.message, named.field, error.code)
  const role = ROLE_SAID.find(([said]) => said.test(error.message))
  if (role !== undefined) return roleRefusal(role[1])
  if (error.code === NOT_ALLOWED) return notAllowedRefusal()
  return new BackendError(error.message, error.code)
}

/** The columns a change gives: a field left out is not written, and a `null` is (takeoff height). */
function givenColumns(columns: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined))
}

function operationColumns(changes: OperationChanges): Record<string, unknown> {
  return givenColumns({
    name: changes.name,
    geofence_id: changes.geofenceId,
    takeoff_security_height_m: changes.takeoffSecurityHeightM,
  })
}

function assignmentColumns(changes: AssignmentChanges): Record<string, unknown> {
  return givenColumns({
    wayline_id: changes.waylineId,
    fleet_id: changes.fleetId,
    speed_ms: changes.speedMs,
    flight: changes.flight,
  })
}

function assignmentDraftColumns(draft: AssignmentDraft): Record<string, unknown> {
  return {
    wayline_id: draft.waylineId,
    fleet_id: draft.fleetId,
    speed_ms: draft.speedMs,
    flight: draft.flight,
  }
}

/** The operations, their assignments, operators, checks, log, requests, flights and commands. */
export function operationOperations(client: SupabaseClient) {
  const soc = () => client.schema('soc')

  return {
    async operations(organizationId: string): Promise<Operation[]> {
      const { data, error } = await soc()
        .from('operations')
        .select('*')
        .eq('organization_id', organizationId)
        .order('created_at', { ascending: false })
      if (error !== null) throw new BackendError(error.message, error.code)
      return rows(OPERATION_ROW, data, 'operations').map((row) => operationOf(row))
    },

    async createOperation(organizationId: string, draft: OperationDraft): Promise<Operation> {
      const response = await soc()
        .from('operations')
        .insert({ organization_id: organizationId, ...operationColumns(draft) })
        .select('*')
        .single()
      if (response.error !== null) throw refusal(response.error)
      const [row] = rows(OPERATION_ROW, [response.data], 'operations')
      if (row === undefined) throw new BackendError('soc.operations answered no row')
      return operationOf(row)
    },

    async changeOperation(operationId: string, changes: OperationChanges): Promise<Operation> {
      const response = await soc()
        .from('operations')
        .update(operationColumns(changes))
        .eq('id', operationId)
        .select('*')
      if (response.error !== null) throw refusal(response.error)
      const [row] = rows(OPERATION_ROW, response.data, 'operations')
      if (row === undefined) throw untouched('operation')
      return operationOf(row)
    },

    async assignments(operationId: string): Promise<Assignment[]> {
      const { data, error } = await soc()
        .from('assignments')
        .select('id, operation_id, wayline_id, fleet_id, speed_ms, flight')
        .eq('operation_id', operationId)
        .order('created_at')
      if (error !== null) throw new BackendError(error.message, error.code)
      return rows(ASSIGNMENT_ROW, data, 'assignments').map((row) => assignmentOf(row))
    },

    async assign(
      operationId: string,
      organizationId: string,
      draft: AssignmentDraft,
    ): Promise<Assignment> {
      const response = await soc()
        .from('assignments')
        .insert({
          operation_id: operationId,
          organization_id: organizationId,
          ...assignmentDraftColumns(draft),
        })
        .select('id, operation_id, wayline_id, fleet_id, speed_ms, flight')
        .single()
      if (response.error !== null) throw refusal(response.error)
      const [row] = rows(ASSIGNMENT_ROW, [response.data], 'assignments')
      if (row === undefined) throw new BackendError('soc.assignments answered no row')
      return assignmentOf(row)
    },

    async changeAssignment(assignmentId: string, changes: AssignmentChanges): Promise<Assignment> {
      const response = await soc()
        .from('assignments')
        .update(assignmentColumns(changes))
        .eq('id', assignmentId)
        .select('id, operation_id, wayline_id, fleet_id, speed_ms, flight')
      if (response.error !== null) throw refusal(response.error)
      const [row] = rows(ASSIGNMENT_ROW, response.data, 'assignments')
      if (row === undefined) throw untouched('assignment')
      return assignmentOf(row)
    },

    async unassign(assignmentId: string): Promise<void> {
      const response = await soc().from('assignments').delete().eq('id', assignmentId).select('id')
      if (response.error !== null) throw refusal(response.error)
      if (response.data.length === 0) throw untouched('assignment')
    },

    async operators(operationId: string): Promise<Operator[]> {
      const { data, error } = await soc()
        .from('operators')
        .select('operation_id, profile_id, role')
        .eq('operation_id', operationId)
        .order('profile_id')
      if (error !== null) throw new BackendError(error.message, error.code)
      return rows(OPERATOR_ROW, data, 'operators').map((row) => operatorOf(row))
    },

    /** The organization's live members, to name as operators: soc.organization_members (IR-OPR). */
    async members(organizationId: string): Promise<Member[]> {
      const response = await soc().rpc('organization_members', { organization: organizationId })
      if (response.error !== null) {
        throw new BackendError(response.error.message, response.error.code)
      }
      return rows(MEMBER_ROW, response.data, 'organization_members').map((row) => memberOf(row))
    },

    async nameOperator(
      operationId: string,
      organizationId: string,
      profileId: string,
      role: OperatorRole,
    ): Promise<Operator> {
      const response = await soc()
        .from('operators')
        .insert({
          operation_id: operationId,
          organization_id: organizationId,
          profile_id: profileId,
          role,
        })
        .select('operation_id, profile_id, role')
        .single()
      if (response.error !== null) throw refusal(response.error)
      const [row] = rows(OPERATOR_ROW, [response.data], 'operators')
      if (row === undefined) throw new BackendError('soc.operators answered no row')
      return operatorOf(row)
    },

    async changeOperator(
      operationId: string,
      profileId: string,
      role: OperatorRole,
    ): Promise<Operator> {
      const response = await soc()
        .from('operators')
        .update({ role })
        .eq('operation_id', operationId)
        .eq('profile_id', profileId)
        .select('operation_id, profile_id, role')
      if (response.error !== null) throw refusal(response.error)
      const [row] = rows(OPERATOR_ROW, response.data, 'operators')
      if (row === undefined) throw untouched('operator')
      return operatorOf(row)
    },

    async removeOperator(operationId: string, profileId: string): Promise<void> {
      const response = await soc()
        .from('operators')
        .delete()
        .eq('operation_id', operationId)
        .eq('profile_id', profileId)
        .select('profile_id')
      if (response.error !== null) throw refusal(response.error)
      if (response.data.length === 0) throw untouched('operator')
    },

    async checks(operationId: string): Promise<OperationCheck[]> {
      const { data, error } = await soc()
        .from('operation_checks')
        .select('*')
        .eq('operation_id', operationId)
        .order('check_id')
      if (error !== null) throw new BackendError(error.message, error.code)
      return rows(CHECK_ROW, data, 'operation_checks').map((row) => checkOf(row))
    },

    /** The log, oldest first: the order it was written in (FR-LOG-01). */
    async events(operationId: string): Promise<OperationEvent[]> {
      const { data, error } = await soc()
        .from('operation_events')
        .select('*')
        .eq('operation_id', operationId)
        .order('recorded_at', { ascending: true })
      if (error !== null) throw new BackendError(error.message, error.code)
      return rows(EVENT_ROW, data, 'operation_events').map((row) => eventOf(row))
    },

    /** The operation's transition requests, newest first. */
    async requests(operationId: string): Promise<TransitionRequest[]> {
      const { data, error } = await soc()
        .from('transition_requests')
        .select(
          'id, operation_id, transition, status, reasons, requested_by, requested_at, decided_at',
        )
        .eq('operation_id', operationId)
        .order('requested_at', { ascending: false })
      if (error !== null) throw new BackendError(error.message, error.code)
      return rows(TRANSITION_REQUEST_ROW, data, 'transition_requests').map((row) => requestOf(row))
    },

    /**
     * Asks the operation to move through soc.request_transition. The database keys the request
     * on its client request id within the organization: the same id answers the same request.
     */
    async requestTransition(
      operationId: string,
      transition: Transition,
      clientRequestId: string,
    ): Promise<TransitionRequest> {
      const response = await soc().rpc('request_transition', {
        operation: operationId,
        wanted: transition,
        client_request: clientRequestId,
      })
      if (response.error !== null) throw refusal(response.error)
      const [row] = rows(TRANSITION_REQUEST_ROW, [response.data], 'transition_requests')
      if (row === undefined) throw new BackendError('soc.request_transition answered no row')
      return requestOf(row)
    },

    /** The operation's flights, newest first. */
    async flights(operationId: string): Promise<Flight[]> {
      const { data, error } = await soc()
        .from('flights')
        .select(
          'id, operation_id, mode, fleet_id, gateway_sn, aircraft_sn, prepared_at, executed_at, took_off_at, landed_at, ended_at, end_reason, breached_at',
        )
        .eq('operation_id', operationId)
        .order('prepared_at', { ascending: false })
      if (error !== null) throw new BackendError(error.message, error.code)
      return rows(FLIGHT_ROW, data, 'flights').map((row) => flightOf(row))
    },

    /** The latest progress of each of the operation's flights, through its flights (IR-FST). */
    async flightStates(operationId: string): Promise<FlightState[]> {
      const { data, error } = await soc()
        .from('flight_states')
        .select(
          'flight_id, status, result, percent, current_waypoint_index, end_reason, updated_at, flights!inner(operation_id)',
        )
        .eq('flights.operation_id', operationId)
        .order('updated_at', { ascending: false })
      if (error !== null) throw new BackendError(error.message, error.code)
      return rows(FLIGHT_STATE_ROW, data, 'flight_states').map((row) => flightStateOf(row))
    },

    /** The operation's command intents, newest first (IR-CMD). */
    async commands(operationId: string): Promise<CommandIntent[]> {
      const { data, error } = await soc()
        .from('command_intents')
        .select(
          'id, operation_id, flight_id, verb, status, result, requested_by, requested_at, sent_at, replied_at',
        )
        .eq('operation_id', operationId)
        .order('requested_at', { ascending: false })
      if (error !== null) throw new BackendError(error.message, error.code)
      return rows(COMMAND_ROW, data, 'command_intents').map((row) => commandOf(row))
    },

    /**
     * Asks a flight's aircraft to do a verb through soc.request_command. Keyed on the client
     * request id as requestTransition is; a flight that has ended refuses even a repeat.
     */
    async requestCommand(
      flightId: string,
      verb: PilotCommandVerb,
      clientRequestId: string,
    ): Promise<CommandIntent> {
      const response = await soc().rpc('request_command', {
        flight: flightId,
        wanted: verb,
        client_request: clientRequestId,
      })
      if (response.error !== null) throw refusal(response.error)
      const [row] = rows(COMMAND_ROW, [response.data], 'command_intents')
      if (row === undefined) throw new BackendError('soc.request_command answered no row')
      return commandOf(row)
    },

    /** The organization's stacks, with the envelope each last reported (IR-STK). */
    async stacks(organizationId: string): Promise<StackView[]> {
      const { data, error } = await soc()
        .from('stacks')
        .select('gateway_sn, name, link_state, envelope, envelope_read_at')
        .eq('organization_id', organizationId)
        .order('name')
      if (error !== null) throw new BackendError(error.message, error.code)
      return rows(STACK_ROW, data, 'stacks').map((row) => stackOf(row))
    },
  }
}
