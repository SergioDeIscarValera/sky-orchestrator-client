import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'

import { BackendError, type OperationEvent } from '../backend/backend'
import { FakeBackend, NORTH, PILOT } from '../test/FakeBackend'
import { operationIn, renderInOrganization } from '../test/inOrganization'
import { OperationLog } from './OperationLog'

/** A time on this device, so the clock reads the same wherever the suite runs. */
const at = (hour: number, minute: number, second: number) =>
  new Date(2026, 9, 11, hour, minute, second).toISOString()

function entry(
  id: string,
  operationId: string,
  overrides: Partial<OperationEvent> & Pick<OperationEvent, 'kind'>,
): OperationEvent {
  return {
    id,
    organizationId: NORTH.id,
    operationId,
    flightId: null,
    fleetId: null,
    commandId: null,
    occurredAt: at(9, 5, 3),
    recordedAt: at(9, 5, 3),
    severity: 'info',
    source: 'operator',
    actorId: null,
    payload: {},
    ...overrides,
  }
}

const log = () => screen.findByRole('log', { name: 'Log' })

/** Each entry as the reader sees it, in the order shown: its time, its mark, its words and value. */
async function lines(): Promise<(string | null)[]> {
  const list = await log()
  return Array.from(list.querySelectorAll('li'), (line) => line.textContent)
}

function renderFor(backend: FakeBackend, operationId: string) {
  return renderInOrganization(<OperationLog operationId={operationId} />, {
    backend,
    account: PILOT,
  })
}

describe('an operation log (FR-LOG-02, FR-LOG-03)', () => {
  it('lists the entries oldest first, each with its time and its words', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'draft')
    backend.eventRows.set(operation.id, [
      entry('e1', operation.id, { kind: 'operation_created', occurredAt: at(9, 5, 3) }),
      entry('e2', operation.id, {
        kind: 'took_off',
        occurredAt: at(9, 6, 0),
        source: 'aircraft',
        payload: { mode_code: 1 },
      }),
      entry('e3', operation.id, { kind: 'landed', occurredAt: at(9, 7, 30), source: 'aircraft' }),
    ])
    renderFor(backend, operation.id)
    expect(await lines()).toEqual([
      '09:05:03InfoCreated',
      '09:06:00InfoTook off',
      '09:07:30InfoLanded',
    ])
  })

  it('marks a warning and an error with their words, and an info with a quiet dot', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'draft')
    backend.eventRows.set(operation.id, [
      entry('w', operation.id, {
        kind: 'transition_refused',
        severity: 'warning',
        occurredAt: at(9, 8, 0),
        source: 'soc-operations',
        payload: { transition: 'launch', reasons: ['No pilot.'] },
      }),
      entry('x', operation.id, {
        kind: 'flight_ended',
        severity: 'error',
        occurredAt: at(9, 8, 1),
        source: 'soc-operations',
        payload: { status: 'failed' },
      }),
    ])
    renderFor(backend, operation.id)
    expect(await lines()).toEqual(['09:08:00WarningMove refused', '09:08:01ErrorFlight ended'])
  })

  it('shows a safety entry in the alert style, so it stands out from the rest', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'draft')
    backend.eventRows.set(operation.id, [
      entry('a', operation.id, { kind: 'took_off', source: 'aircraft', payload: {} }),
      entry('b', operation.id, {
        kind: 'geofence_breach',
        severity: 'safety',
        occurredAt: at(9, 9, 0),
        source: 'soc-cloud',
        payload: { distance_outside_m: 12.5, height_m: 40 },
      }),
    ])
    renderFor(backend, operation.id)
    const breach = (await screen.findByText('Geofence breach')).closest('li')
    const calm = screen.getByText('Took off').closest('li')
    expect(breach).toHaveClass('bg-danger-subtle', 'text-danger-emphasis')
    expect(within(breach as HTMLElement).getByText('Safety')).toBeVisible()
    expect(breach).toHaveTextContent('09:09:00SafetyGeofence breach · 12.5 m outside')
    expect(calm).not.toHaveClass('bg-danger-subtle')
  })

  it('shows the value that matters in an entry inline, muted, and none for the other kinds', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'draft')
    backend.eventRows.set(operation.id, [
      entry('s', operation.id, {
        kind: 'operation_state_changed',
        payload: { from: 'ready', to: 'launching', cause: 'launch' },
      }),
      entry('c', operation.id, {
        kind: 'command_outcome',
        payload: { verb: 'pause', status: 'accepted', result: 0 },
      }),
      entry('f', operation.id, {
        kind: 'flight_status_changed',
        payload: { status: 'in_progress', percent: 40 },
      }),
    ])
    renderFor(backend, operation.id)
    expect(await lines()).toEqual([
      '09:05:03InfoState changed · Ready to Launching',
      '09:05:03InfoCommand answered · Pause · Accepted',
      '09:05:03InfoFlight status changed · In progress · 40%',
    ])
    expect(within(await log()).getByText('· Ready to Launching')).toHaveClass('text-muted')
  })

  it('appends an entry as it is recorded, without reading the log again', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'draft')
    const reads = vi.spyOn(backend, 'events')
    renderFor(backend, operation.id)
    expect(await lines()).toHaveLength(1)
    act(() => {
      backend.addEvent(operation.id, 'took_off', 'aircraft', { mode_code: 1 })
    })
    await waitFor(() => {
      expect(screen.getByText('Took off')).toBeVisible()
    })
    expect(within(await log()).getAllByRole('listitem')).toHaveLength(2)
    expect(reads).toHaveBeenCalledOnce()
  })

  it('follows the newest entry to the bottom, unless the member has scrolled up', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'draft')
    renderFor(backend, operation.id)
    const box = await log()
    // The page has no layout here: the box is 500 pixels tall, 100 of them in view.
    Object.defineProperties(box, {
      scrollHeight: { value: 500, configurable: true },
      clientHeight: { value: 100, configurable: true },
      scrollTop: { value: 0, writable: true, configurable: true },
    })

    act(() => {
      backend.addEvent(operation.id, 'took_off', 'aircraft')
    })
    await waitFor(() => {
      expect(box.scrollTop).toBe(500)
    })

    box.scrollTop = 0
    fireEvent.scroll(box)
    act(() => {
      backend.addEvent(operation.id, 'landed', 'aircraft')
    })
    await waitFor(() => {
      expect(within(box).getAllByRole('listitem')).toHaveLength(3)
    })
    expect(box.scrollTop).toBe(0)

    box.scrollTop = 400
    fireEvent.scroll(box)
    act(() => {
      backend.addEvent(operation.id, 'fleet_online', 'soc-cloud')
    })
    await waitFor(() => {
      expect(box.scrollTop).toBe(500)
    })
  })

  it('is bounded in height, with its own scroll', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'draft')
    renderFor(backend, operation.id)
    expect(await log()).toHaveClass('max-h-72', 'overflow-y-auto')
  })

  it('says None when the operation has no entry yet', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'draft')
    backend.eventRows.set(operation.id, [])
    renderFor(backend, operation.id)
    expect(await screen.findByText('None')).toBeVisible()
    expect(screen.queryByRole('log')).toBeNull()
    expect(screen.getByRole('region', { name: 'Log' })).toContainElement(screen.getByText('None'))
  })

  it('says it is loading while the log is read', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'draft')
    renderFor(backend, operation.id)
    expect(screen.getByText('Loading the log…')).toBeVisible()
    await log()
  })

  it('says why the log cannot be read, and reads it again on Try again', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'draft')
    vi.spyOn(backend, 'events').mockRejectedValueOnce(new BackendError('The log is down'))
    const { user } = renderFor(backend, operation.id)
    expect(await screen.findByRole('alert')).toHaveTextContent('The log is down')
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await lines()).toHaveLength(1)
  })
})
