import { act, screen, waitFor, within } from '@testing-library/react'

import { geodeticAt, type Geodetic } from '../geometry/projection'
import { FakeBackend, NEIGHBOUR, NORTH } from '../test/FakeBackend'
import { renderApp } from '../test/render'
import { clicked, handleMoved, toolChosen, useWaylineDesigner, type Tool } from './waylineDesigner'

const FARM: Geodetic = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
const at = (east: number, north: number) => geodeticAt(FARM, { eastM: east, northM: north })

async function openAt(backend: FakeBackend, search: string) {
  window.history.replaceState(null, '', `/${search}`)
  const rendered = renderApp(backend)
  await screen.findByRole('banner')
  return rendered
}

const designing = () => useWaylineDesigner.getState().designing
const search = () => new URLSearchParams(window.location.search)
const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })

/** Clicks on the ground with a tool, as the scene passes them to the designer. */
function draw(tool: Tool, ...clicks: readonly (readonly [number, number])[]) {
  act(() => {
    const { change } = useWaylineDesigner.getState()
    change((current) => toolChosen(current, tool))
    for (const [east, north] of clicks) change((current) => clicked(current, at(east, north)))
  })
}

/** A new wayline named, with its figures typed, its takeoff placed and a route drawn. */
async function corridor(user: ReturnType<typeof renderApp>['user']) {
  await user.click(await screen.findByRole('button', { name: 'New' }))
  await screen.findByRole('form', { name: 'New wayline' })
  await user.type(screen.getByLabelText('Name'), 'North corridor')
  await user.type(screen.getByLabelText('Height'), '30')
  draw('takeoff', [0, 0])
  draw('route', [0, 50], [100, 50])
  await user.click(screen.getByRole('button', { name: 'Finish' }))
}

afterEach(() => {
  window.history.replaceState(null, '', '/')
  useWaylineDesigner.getState().stop()
})

describe('the wayline designer (FR-WAY-01 to FR-WAY-09)', () => {
  it('designs a wayline, bakes it live, and saves its design and its bake selected', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const { user } = await openAt(backend, '?panel=waylines')
    await corridor(user)
    const tiles = within(screen.getByRole('form', { name: 'New wayline' }))
    expect(tiles.getByText('150 m')).toBeVisible()
    expect(
      within(screen.getByRole('list', { name: 'Drawn' })).getByText('Route · 2 points'),
    ).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(designing()).toBeNull()
    })
    const [saved] = await backend.waylines(NORTH.id)
    expect(saved).toMatchObject({
      name: 'North corridor',
      defaultHeightM: 30,
      metrics: { waypointCount: 3 },
      bakeVersion: '2.2.0',
    })
    // Straight up above the takeoff first, then the route.
    expect(saved?.waypoints.map(({ heightM }) => heightM)).toEqual([30, 30, 30])
    expect(Object.keys(saved?.design ?? {}).sort()).toEqual([
      'default_height_m',
      'primitives',
      'schema_version',
      'takeoff',
    ])
    expect(search().get('wayline')).toBe(saved?.id)
    expect(
      await within(inspector()).findByRole('heading', { name: 'North corridor' }),
    ).toBeVisible()
  })

  it('names what it needs before it bakes, and saves nothing until it has it', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const { user } = await openAt(backend, '?panel=waylines')
    await user.click(await screen.findByRole('button', { name: 'New' }))
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    const reasons = within(screen.getByRole('list', { name: 'Cannot be saved' }))
      .getAllByRole('listitem')
      .map((item) => item.textContent)
    expect(reasons).toEqual(['Name missing', 'Takeoff missing', 'Height missing', 'Nothing drawn'])
    expect(await backend.waylines(NORTH.id)).toEqual([])
  })

  it('opens a saved wayline with its design, and saves it baked again', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const { user } = await openAt(backend, '?panel=waylines')
    await corridor(user)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(designing()).toBeNull()
    })
    const changed = vi.spyOn(backend, 'changeWayline')
    const [kept] = await backend.waylines(NORTH.id)
    await user.click(await within(inspector()).findByRole('button', { name: 'Edit' }))
    expect([search().get('panel'), search().get('wayline')]).toEqual(['waylines', kept?.id])
    expect(await screen.findByRole('form', { name: 'Edit North corridor' })).toBeVisible()
    expect(designing()?.sketch.primitives).toEqual([
      { kind: 'route', points: [at(0, 50), at(100, 50)] },
    ])
    expect(screen.getByLabelText('Height')).toHaveValue('30')
    draw('points', [50, 80])
    await user.click(screen.getByRole('button', { name: 'Finish' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(changed).toHaveBeenCalledOnce()
    })
    const [saved] = await backend.waylines(NORTH.id)
    expect(saved?.metrics.waypointCount).toBe(4)
  })

  it('duplicates a wayline as saved, never baked again, and retires one for good', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    const { user } = await openAt(backend, '?panel=waylines')
    await corridor(user)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(designing()).toBeNull()
    })
    const [original] = await backend.waylines(NORTH.id)
    await user.click(await within(inspector()).findByRole('button', { name: 'Duplicate' }))
    await waitFor(() => {
      expect(search().get('wayline')).not.toBe(original?.id)
    })
    const copy = (await backend.waylines(NORTH.id)).find(
      ({ name }) => name === 'North corridor (copy)',
    )
    expect(copy?.waypoints).toEqual(original?.waypoints)
    expect(copy?.design).toEqual(original?.design)
    await user.click(within(inspector()).getByRole('button', { name: 'Retire' }))
    await user.click(screen.getByRole('button', { name: 'Retire for good' }))
    await waitFor(() => {
      expect(search().get('wayline')).toBeNull()
    })
    expect((await backend.waylines(NORTH.id)).map(({ name }) => name)).toEqual(['North corridor'])
  })

  it("leaves a viewer's New off", async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    backend.memberships.set(NEIGHBOUR.userId, [{ ...NORTH, role: 'viewer' }])
    const { user } = await openAt(backend, '?panel=waylines')
    const fresh = await screen.findByRole('button', { name: 'New' })
    expect(fresh).toHaveAttribute('aria-disabled', 'true')
    await user.click(fresh)
    expect(designing()).toBeNull()
  })
})

/** The figures of the primitive open, in its own group under its row. */
const editorOf = (summary: string) => screen.getByRole('group', { name: summary })
const circleOpen = () => {
  const primitive = designing()?.sketch.primitives[designing()?.selected ?? -1]
  return primitive?.kind === 'circle' ? primitive : null
}

describe('what is drawn, edited in the panel (FR-WAY-04 to FR-WAY-06)', () => {
  it('opens a circle just drawn, its radius typed exactly in one undo step', async () => {
    const { user } = await openAt(new FakeBackend(NEIGHBOUR), '?panel=waylines')
    await corridor(user)
    draw('circle', [200, 200], [230, 200])
    const row = screen.getByRole('button', { name: 'Circle · 30 m radius' })
    expect(row).toHaveAttribute('aria-pressed', 'true')
    const radius = within(editorOf('Circle · 30 m radius')).getByLabelText('Radius')
    expect(radius).toHaveValue('30')
    const steps = designing()?.past.length ?? 0
    await user.clear(radius)
    expect(radius).toHaveAttribute('aria-invalid', 'true')
    await user.type(radius, '42.5')
    expect(circleOpen()?.radiusM).toBe(42.5)
    expect(designing()?.past).toHaveLength(steps + 1)
    await user.tab()
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(circleOpen()?.radiusM).toBeCloseTo(30, 6)
  })

  it('shows a drag in the scene at once in the field, while it has no focus', async () => {
    const { user } = await openAt(new FakeBackend(NEIGHBOUR), '?panel=waylines')
    await corridor(user)
    draw('circle', [200, 200], [230, 200])
    act(() => {
      useWaylineDesigner
        .getState()
        .change((current) => handleMoved(current, { kind: 'rim' }, at(200, 250)))
    })
    expect(within(editorOf('Circle · 50 m radius')).getByLabelText('Radius')).toHaveValue('50')
  })

  it('turns a circle, and refuses a radius of zero', async () => {
    const { user } = await openAt(new FakeBackend(NEIGHBOUR), '?panel=waylines')
    await corridor(user)
    draw('circle', [200, 200], [230, 200])
    const editor = within(editorOf('Circle · 30 m radius'))
    await user.click(editor.getByRole('button', { name: 'Anticlockwise' }))
    expect(circleOpen()?.clockwise).toBe(false)
    const radius = editor.getByLabelText('Radius')
    await user.clear(radius)
    await user.type(radius, '0')
    expect(radius).toHaveAttribute('aria-invalid', 'true')
    expect(circleOpen()?.radiusM).toBeCloseTo(30, 6)
  })

  it("gives a route its own height, the default's shown until it has one", async () => {
    const { user } = await openAt(new FakeBackend(NEIGHBOUR), '?panel=waylines')
    await corridor(user)
    const editor = within(editorOf('Route · 2 points'))
    const height = editor.getByLabelText('Height')
    expect(height).toHaveValue('')
    expect(height).toHaveAttribute('placeholder', '30')
    await user.type(height, '55')
    const [route] = designing()?.sketch.primitives ?? []
    expect(route?.kind === 'route' ? route.points.map((p) => p.heightM) : []).toEqual([55, 55])
    await user.clear(height)
    const [back] = designing()?.sketch.primitives ?? []
    expect(back?.kind === 'route' ? back.points.map((p) => p.heightM) : []).toEqual([
      undefined,
      undefined,
    ])
    expect(height).toHaveAttribute('aria-invalid', 'false')
  })

  it('respaces a grid, and opens and closes a primitive from its row', async () => {
    const { user } = await openAt(new FakeBackend(NEIGHBOUR), '?panel=waylines')
    await corridor(user)
    await user.click(screen.getByRole('button', { name: 'Grid' }))
    await user.type(screen.getByLabelText('Between lines'), '20')
    await user.type(screen.getByLabelText('Between points'), '10')
    draw('grid', [0, 100], [100, 100], [100, 160])
    await user.click(screen.getByRole('button', { name: 'Finish' }))
    const editor = within(editorOf('Grid · 20 m lines'))
    const lines = editor.getByLabelText('Between lines')
    await user.clear(lines)
    await user.type(lines, '25')
    expect(designing()?.sketch.primitives[1]).toMatchObject({ lineSpacingM: 25 })
    const route = screen.getByRole('button', { name: 'Route · 2 points' })
    await user.click(route)
    expect(route).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('group', { name: 'Grid · 25 m lines' })).toBeNull()
    await user.click(route)
    expect(route).toHaveAttribute('aria-pressed', 'false')
    expect(designing()?.selected).toBeNull()
  })
})
