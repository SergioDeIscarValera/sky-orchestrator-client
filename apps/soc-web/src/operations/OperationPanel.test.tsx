import { screen, waitFor, within } from '@testing-library/react'

import { BackendError, type OperationDraft } from '../backend/backend'
import { FakeBackend, NEIGHBOUR, NORTH } from '../test/FakeBackend'
import { renderApp } from '../test/render'

const DRAFT: OperationDraft = {
  name: 'North corridor',
  geofenceId: null,
  takeoffSecurityHeightM: null,
}

async function openAt(backend: FakeBackend, search = '') {
  window.history.replaceState(null, '', `/${search}`)
  const rendered = renderApp(backend)
  await screen.findByRole('banner')
  return rendered
}

const list = () => screen.getByRole('list', { name: 'Operations' })
const params = () => new URLSearchParams(window.location.search)

afterEach(() => {
  window.history.replaceState(null, '', '/')
})

describe("the organization's operations (FR-OPS-01, FR-AUT-03)", () => {
  it('lists them newest first, each with its state and its assignment in words', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const fleet = await backend.registerFleet(NORTH.id, {
      name: 'Norte 1',
      model: 'mavic-air-2',
      airframeSerial: '1WNBH9',
      controllerSerial: null,
      gatewaySn: 'SOTESTDOCK01',
      aircraftSn: 'SOTESTUAV001',
      flightTimeBeforeSocS: 5400,
    })
    const wayline = await backend.createWayline(NORTH.id, {
      name: 'North corridor',
      takeoff: { latitudeDeg: 41.6523, longitudeDeg: -4.7245 },
      defaultHeightM: 30,
      design: {},
      waypoints: [
        { index: 0, position: { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }, heightM: 30 },
      ],
      metrics: { waypointCount: 1, distanceM: 0 },
      bakeVersion: '2.2.0',
    })
    const first = await backend.createOperation(NORTH.id, DRAFT)
    await backend.assign(first.id, NORTH.id, {
      waylineId: wayline.id,
      fleetId: fleet.id,
      speedMs: null,
      flight: null,
    })
    await backend.createOperation(NORTH.id, { ...DRAFT, name: 'South field' })
    await openAt(backend, '?panel=operations')

    // Each row reads its own assignment, so the line is there once the read has settled.
    expect(await screen.findByText('Defining · Norte 1 · North corridor')).toBeVisible()
    const rows = within(list()).getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual([
      'South fieldDefining',
      'North corridorDefining · Norte 1 · North corridor',
    ])
  })

  it('says plainly that there are none yet', async () => {
    await openAt(new FakeBackend(NEIGHBOUR), '?panel=operations')
    expect(await screen.findByText('No operations yet.')).toBeVisible()
  })

  it('names a failed read, and reads again on Try again', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    vi.spyOn(backend, 'operations').mockRejectedValueOnce(
      new BackendError('the connection dropped'),
    )
    const { user } = await openAt(backend, '?panel=operations')
    expect(await screen.findByRole('alert')).toHaveTextContent('the connection dropped')
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('No operations yet.')).toBeVisible()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('creates a draft named for a new operation, and selects it, for an editor or an owner', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const { user } = await openAt(backend, '?panel=operations')
    await user.click(await screen.findByRole('button', { name: 'New' }))
    const [made] = await backend.operations(NORTH.id)
    expect(made).toMatchObject({ name: 'New operation', state: 'draft' })
    expect(await within(list()).findByText('Defining')).toBeVisible()
    await waitFor(() => {
      expect(params().get('operation')).toBe(made?.id)
    })
    expect(
      await within(screen.getByRole('complementary', { name: 'Inspector' })).findByRole('heading', {
        name: 'New operation',
      }),
    ).toBeVisible()
  })

  it('leaves New to a viewer, who cannot create an operation', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    backend.memberships.set(NEIGHBOUR.userId, [{ ...NORTH, role: 'viewer' }])
    const { user } = await openAt(backend, '?panel=operations')
    const add = await screen.findByRole('button', { name: 'New' })
    expect(add).toHaveAttribute('aria-disabled', 'true')
    await user.click(add)
    expect(await backend.operations(NORTH.id)).toEqual([])
    expect(params().get('operation')).toBeNull()
  })

  it('selects a row, and lets it go on a second click', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const operation = await backend.createOperation(NORTH.id, DRAFT)
    const { user } = await openAt(backend, '?panel=operations')
    const row = await screen.findByRole('button', { name: /North corridor/ })
    expect(row).toHaveAttribute('aria-pressed', 'false')
    await user.click(row)
    expect(row).toHaveAttribute('aria-pressed', 'true')
    expect(params().get('operation')).toBe(operation.id)
    await user.click(row)
    expect(row).toHaveAttribute('aria-pressed', 'false')
    expect(params().get('operation')).toBeNull()
  })
})
