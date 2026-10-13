import type { Member, OperationState, OperatorRole, Role } from '../backend/backend'

/** An operation's state in words, as the list and the header say it (FR-OPS-02). */
const WORDS: Readonly<Record<OperationState, string>> = {
  draft: 'Draft',
  planned: 'Planned',
  preparing: 'Preparing',
  simulating: 'Simulating',
  simulated: 'Simulated',
  ready: 'Ready',
  launching: 'Launching',
  in_flight: 'In flight',
  paused: 'Paused',
  returning: 'Returning',
  completed: 'Completed',
  aborted: 'Aborted',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export function stateWord(state: OperationState): string {
  return WORDS[state]
}

/** The state pill's tone: the console's own status tokens, as the presence and freshness pills use. */
const TONES: Readonly<Record<OperationState, string>> = {
  draft: 'border-border text-muted border',
  planned: 'border-border text-muted border',
  preparing: 'bg-primary-subtle text-primary-emphasis',
  simulating: 'bg-primary-subtle text-primary-emphasis',
  simulated: 'bg-primary-subtle text-primary-emphasis',
  ready: 'bg-primary-subtle text-primary-emphasis',
  launching: 'bg-success-subtle text-success-emphasis',
  in_flight: 'bg-success-subtle text-success-emphasis',
  paused: 'bg-warning-subtle text-warning-emphasis',
  returning: 'bg-success-subtle text-success-emphasis',
  completed: 'bg-success-subtle text-success-emphasis',
  aborted: 'bg-danger-subtle text-danger-emphasis',
  failed: 'bg-danger-subtle text-danger-emphasis',
  cancelled: 'border-border text-muted border',
}

export function stateTone(state: OperationState): string {
  return TONES[state]
}

/** The muted line under an operation's name: its state, then its fleet's and wayline's names. */
export function operationSummary({
  state,
  fleet,
  wayline,
}: {
  readonly state: OperationState
  readonly fleet: string | null
  readonly wayline: string | null
}): string {
  return [stateWord(state), fleet, wayline]
    .filter((part): part is string => part !== null)
    .join(' · ')
}

const ROLES: Readonly<Record<Role, string>> = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' }

/** A member's role in the organization, as the operators list shows it beside the name. */
export function roleWord(role: Role): string {
  return ROLES[role]
}

const OPERATOR_ROLES: Readonly<Record<OperatorRole, string>> = {
  pilot: 'Pilot',
  observer: 'Observer',
}

export function operatorRoleWord(role: OperatorRole): string {
  return OPERATOR_ROLES[role]
}

/** A member's name, else their address, else their profile id: the first one there is. */
export function memberName(member: Member): string {
  const name = member.displayName?.trim() ?? ''
  if (name !== '') return name
  if (member.email !== null && member.email.trim() !== '') return member.email
  return member.profileId
}
