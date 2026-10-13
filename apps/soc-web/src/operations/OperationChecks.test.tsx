import { act, screen, waitFor, within } from '@testing-library/react'

import { BackendError, type OperationCheck, type OperationState } from '../backend/backend'
import { FakeBackend, PILOT } from '../test/FakeBackend'
import { operationIn, renderInOrganization } from '../test/inOrganization'
import { CHECK_ORDER, CHECK_WORDS } from './format'
import { OperationChecks } from './OperationChecks'

const AT = '2026-10-11T10:10:00Z'

function judgement(checkId: string, overrides: Partial<OperationCheck> = {}): OperationCheck {
  return {
    checkId,
    state: 'pass',
    blocking: true,
    value: null,
    detail: null,
    evaluatedAt: AT,
    ...overrides,
  }
}

const list = () => screen.findByRole('list', { name: 'Preflight checks' })

/** The check's row, found by its name: each row begins with the name of its check. */
async function rowNamed(name: string): Promise<HTMLElement> {
  const rows = within(await list()).getAllByRole('listitem')
  const row = rows.find((candidate) => candidate.querySelector('p')?.textContent === name)
  if (row === undefined) throw new Error(`no check named ${name}`)
  return row
}

describe('an operation preflight checks (FR-OPS-04, FR-OPS-05)', () => {
  it('lists every check in the order of FR-OPS-05, each unknown until it is judged', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'preparing')
    renderInOrganization(<OperationChecks operationId={operation.id} />, {
      backend,
      account: PILOT,
    })
    const rows = within(await list()).getAllByRole('listitem')
    expect(rows.map((row) => row.querySelector('p')?.textContent)).toEqual(
      CHECK_ORDER.map((id) => CHECK_WORDS[id]),
    )
    expect(screen.getAllByText('Unknown')).toHaveLength(CHECK_ORDER.length)
    expect(screen.queryByText('Pass')).toBeNull()
  })

  it("shows each judgement's state, its measured value and its detail, the last two muted", async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'preparing')
    backend.addCheck(operation.id, judgement('PF-LINK', { value: { link_state: 'connected' } }))
    backend.addCheck(
      operation.id,
      judgement('PF-GNSS', {
        state: 'fail',
        value: { satellites: 9, gps_quality: 4 },
        detail: 'Nine satellites; twelve are needed.',
      }),
    )
    renderInOrganization(<OperationChecks operationId={operation.id} />, {
      backend,
      account: PILOT,
    })
    const positioning = await rowNamed('Positioning')
    expect(within(positioning).getByText('Fail')).toBeVisible()
    expect(within(positioning).getByText('satellites 9 · GPS quality 4')).toHaveClass('text-muted')
    expect(within(positioning).getByText('Nine satellites; twelve are needed.')).toHaveClass(
      'text-muted',
    )
    const link = await rowNamed('Stack link')
    expect(within(link).getByText('Pass')).toBeVisible()
    expect(within(link).getByText('link state connected')).toHaveClass('text-muted')
  })

  it('marks a check that does not block, and leaves the blocking ones unmarked', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'preparing')
    backend.addCheck(
      operation.id,
      judgement('PF-CLOCK', { state: 'fail', blocking: false, value: { clock_offset_ms: 900 } }),
    )
    backend.addCheck(operation.id, judgement('PF-LINK'))
    renderInOrganization(<OperationChecks operationId={operation.id} />, {
      backend,
      account: PILOT,
    })
    const clock = await rowNamed('Clock offset')
    expect(within(clock).getByText('Not blocking')).toBeVisible()
    expect(within(clock).getByText('Fail')).toBeVisible()
    expect(within(await rowNamed('Stack link')).queryByText('Not blocking')).toBeNull()
  })

  it('shows a check nobody has judged as unknown, never as a pass', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'preparing')
    backend.addCheck(operation.id, judgement('PF-LINK'))
    backend.addCheck(operation.id, judgement('PF-BATTERY', { state: 'unknown', value: null }))
    renderInOrganization(<OperationChecks operationId={operation.id} />, {
      backend,
      account: PILOT,
    })
    const battery = await rowNamed('Battery')
    const unknown = within(battery).getByText('Unknown')
    expect(unknown).toHaveClass('text-muted')
    expect(unknown).not.toHaveClass('text-success-emphasis')
    expect(within(await rowNamed('Battery')).queryByText('Pass')).toBeNull()
    const unjudged = await rowNamed('Inside the geofence')
    expect(within(unjudged).getByText('Unknown')).toBeVisible()
    expect(screen.getAllByText('Pass')).toHaveLength(1)
  })

  it.each<OperationState>([
    'preparing',
    'simulating',
    'simulated',
    'ready',
    'launching',
    'in_flight',
    'paused',
    'returning',
  ])('shows the checks while the operation is %s', async (state) => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, state, [PILOT.userId])
    renderInOrganization(<OperationChecks operationId={operation.id} />, {
      backend,
      account: PILOT,
    })
    expect(await list()).toBeVisible()
  })

  it.each<OperationState>(['draft', 'planned', 'completed', 'aborted', 'failed', 'cancelled'])(
    'shows nothing while the operation is %s, and reads no check',
    async (state) => {
      const backend = new FakeBackend(PILOT)
      const operation = await operationIn(backend, state)
      const reads = vi.spyOn(backend, 'checks')
      const { container } = renderInOrganization(<OperationChecks operationId={operation.id} />, {
        backend,
        account: PILOT,
      })
      await waitFor(() => {
        expect(screen.queryByText('Loading the checks…')).toBeNull()
      })
      expect(container).toBeEmptyDOMElement()
      expect(reads).not.toHaveBeenCalled()
    },
  )

  it('shows the checks as they are judged, from the state topic, without reading them again', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'preparing')
    backend.addCheck(operation.id, judgement('PF-GNSS'))
    const reads = vi.spyOn(backend, 'checks')
    renderInOrganization(<OperationChecks operationId={operation.id} />, {
      backend,
      account: PILOT,
    })
    expect(within(await rowNamed('Positioning')).getByText('Pass')).toBeVisible()
    act(() => {
      backend.addCheck(
        operation.id,
        judgement('PF-GNSS', { state: 'fail', detail: 'Nine satellites.' }),
      )
    })
    await waitFor(() => {
      expect(
        within(screen.getByRole('list', { name: 'Preflight checks' })).getByText('Fail'),
      ).toBeVisible()
    })
    expect(reads).toHaveBeenCalledOnce()
  })

  it('says it is loading while the operation is read', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'preparing')
    renderInOrganization(<OperationChecks operationId={operation.id} />, {
      backend,
      account: PILOT,
    })
    expect(screen.getByText('Loading the checks…')).toBeVisible()
    await list()
  })

  it('reads the checks again on Try again when their read fails', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'preparing')
    backend.addCheck(operation.id, judgement('PF-LINK'))
    const reads = vi
      .spyOn(backend, 'checks')
      .mockRejectedValueOnce(new BackendError('Supabase is unreachable'))
    const { user } = renderInOrganization(<OperationChecks operationId={operation.id} />, {
      backend,
      account: PILOT,
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('Supabase is unreachable')
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(within(await rowNamed('Stack link')).getByText('Pass')).toBeVisible()
    expect(reads).toHaveBeenCalledTimes(2)
  })

  it('says why the operation cannot be read, with a way to read it again', async () => {
    const backend = new FakeBackend(PILOT)
    const operation = await operationIn(backend, 'preparing')
    vi.spyOn(backend, 'operations').mockRejectedValueOnce(new BackendError('Operations are down'))
    const { user } = renderInOrganization(<OperationChecks operationId={operation.id} />, {
      backend,
      account: PILOT,
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('Operations are down')
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await list()
  })
})
