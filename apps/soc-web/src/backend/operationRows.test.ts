import { checkBroadcast, eventBroadcast } from './operationRows'

const OPERATION = '66666666-6666-4666-8666-666666666666'
const ORGANIZATION = '11111111-1111-4111-8111-111111111111'
const EVENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const STAMP = '2026-10-11T10:10:00+00:00'

/** A check as the database broadcasts it: its whole row, the operation it judges included. */
const CHECK_PAYLOAD = {
  operation_id: OPERATION,
  organization_id: ORGANIZATION,
  check_id: 'PF-GNSS',
  state: 'fail',
  blocking: true,
  value: { satellites: 9 },
  detail: 'Nine satellites; twelve are needed.',
  evaluated_at: STAMP,
}

/** A log entry as the database broadcasts it: every column of its row. */
const EVENT_PAYLOAD = {
  id: EVENT,
  organization_id: ORGANIZATION,
  operation_id: OPERATION,
  flight_id: null,
  fleet_id: null,
  command_id: null,
  occurred_at: STAMP,
  recorded_at: STAMP,
  kind: 'transition_refused',
  severity: 'warning',
  source: 'soc-operations',
  actor_id: null,
  payload: { transition: 'launch', reasons: ['PF-GNSS'] },
}

describe('the rows the state topic carries whole (IR-CHK, IR-EVT)', () => {
  it('reads a check broadcast as the check it judges, on the operation it names', () => {
    expect(checkBroadcast(CHECK_PAYLOAD)).toEqual({
      operationId: OPERATION,
      check: {
        checkId: 'PF-GNSS',
        state: 'fail',
        blocking: true,
        value: { satellites: 9 },
        detail: 'Nine satellites; twelve are needed.',
        evaluatedAt: STAMP,
      },
    })
  })

  it('reads no check from a payload it cannot read, so the checks are read again', () => {
    expect(checkBroadcast({ ...CHECK_PAYLOAD, check_id: 'GNSS' })).toBeNull()
    expect(checkBroadcast({ ...CHECK_PAYLOAD, state: 'maybe' })).toBeNull()
    expect(checkBroadcast({ ...CHECK_PAYLOAD, operation_id: undefined })).toBeNull()
  })

  it('reads a log entry broadcast as the entry it wrote, with its payload as a record', () => {
    expect(eventBroadcast(EVENT_PAYLOAD)).toEqual({
      id: EVENT,
      organizationId: ORGANIZATION,
      operationId: OPERATION,
      flightId: null,
      fleetId: null,
      commandId: null,
      occurredAt: STAMP,
      recordedAt: STAMP,
      kind: 'transition_refused',
      severity: 'warning',
      source: 'soc-operations',
      actorId: null,
      payload: { transition: 'launch', reasons: ['PF-GNSS'] },
    })
  })

  it('reads no log entry from a payload it cannot read, so the log is read again', () => {
    expect(eventBroadcast({ ...EVENT_PAYLOAD, severity: 'critical' })).toBeNull()
    expect(eventBroadcast({ ...EVENT_PAYLOAD, payload: [] })).toBeNull()
  })
})
