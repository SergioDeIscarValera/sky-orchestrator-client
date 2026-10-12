import { act, screen, waitFor, within } from '@testing-library/react'

import type { GeofenceDraft, WaylineDraft } from '../backend/backend'
import { geodeticAt, type Geodetic } from '../geometry/projection'
import { FakeBackend, NEIGHBOUR, NORTH } from '../test/FakeBackend'
import { renderApp } from '../test/render'
import { closed, placed, useGeofenceEditor } from './geofenceEditor'

/** NORTH's position, the scene's origin without a site model. */
const FARM: Geodetic = { latitudeDeg: NORTH.position?.latitude ?? 0, longitudeDeg: -4.7245 }
const at = (east: number, north: number) => geodeticAt(FARM, { eastM: east, northM: north })

const SQUARE: GeofenceDraft = {
  name: 'North field',
  polygon: [at(0, 0), at(100, 0), at(100, 100), at(0, 100)],
  maxHeightM: 60,
  origin: 'drawn',
  marginM: null,
}

const CORRIDOR: WaylineDraft = {
  name: 'Corridor 1',
  takeoff: at(0, 0),
  defaultHeightM: 30,
  speedMs: 5,
  design: {},
  waypoints: [
    { index: 0, position: at(0, 50), heightM: 30 },
    { index: 1, position: at(200, 50), heightM: 30 },
  ],
  metrics: { waypointCount: 2, distanceM: 250, durationS: 50 },
  bakeVersion: '1',
}

async function farm(role: 'owner' | 'viewer' = 'owner') {
  const backend = new FakeBackend(NEIGHBOUR)
  const square = await backend.createGeofence(NORTH.id, SQUARE)
  await backend.createGeofence(NORTH.id, { ...SQUARE, name: 'Almond rows', maxHeightM: 40 })
  backend.memberships.set(NEIGHBOUR.userId, [{ ...NORTH, role }])
  return { backend, square }
}

async function openAt(backend: FakeBackend, search: string) {
  window.history.replaceState(null, '', `/${search}`)
  const rendered = renderApp(backend)
  await screen.findByRole('banner')
  return rendered
}

const geofences = () => screen.findByRole('list', { name: 'Geofences' })
const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })
const search = () => new URLSearchParams(window.location.search)
const editing = () => useGeofenceEditor.getState().editing

/** Clicks on the ground, as the scene passes them to the editor. */
function place(...corners: readonly (readonly [number, number])[]) {
  act(() => {
    for (const [east, north] of corners) {
      useGeofenceEditor.getState().change((current) => placed(current, at(east, north)))
    }
  })
}

afterEach(() => {
  window.history.replaceState(null, '', '/')
  useGeofenceEditor.getState().stop()
})

describe('the geofence panel (FR-GEO-02)', () => {
  it("lists the organization's geofences by name, each with how it was made and its ceiling", async () => {
    const { backend } = await farm()
    await openAt(backend, '?panel=geofences')
    const rows = within(await geofences()).getAllByRole('button')
    expect(rows.map((row) => row.textContent)).toEqual([
      'Almond rowsDrawn · ceiling 40 m',
      'North fieldDrawn · ceiling 60 m',
    ])
  })

  it('says when there are none', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    await openAt(backend, '?panel=geofences')
    expect(await screen.findByText('No geofences yet.')).toBeVisible()
  })

  it('selects a geofence into the URL, and shows its figures in the inspector', async () => {
    const { backend, square } = await farm()
    const { user } = await openAt(backend, '?panel=geofences')
    await user.click(await within(await geofences()).findByRole('button', { name: /^North field/ }))
    expect(search().get('geofence')).toBe(square.id)
    const detail = within(inspector())
    expect(await detail.findByRole('heading', { name: 'North field' })).toBeVisible()
    expect(detail.getByText('1.00 ha')).toBeVisible()
    expect(detail.getByText('400 m')).toBeVisible()
    expect(detail.getByText('60 m above takeoff')).toBeVisible()
  })
})

describe('drawing a geofence (FR-GEO-01, FR-GEO-04)', () => {
  it('draws a new one vertex by vertex, shows its figures, and saves it selected', async () => {
    const { backend } = await farm()
    const { user } = await openAt(backend, '?panel=geofences')
    await user.click(await screen.findByRole('button', { name: 'New' }))
    expect(await screen.findByRole('form', { name: 'New geofence' })).toBeVisible()
    place([0, 0], [50, 0], [50, 40])
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(editing()?.phase).toBe('shaping')
    expect(screen.getByText('1,000 m²')).toBeVisible()
    expect(screen.getByText('154 m')).toBeVisible()
    await user.type(screen.getByLabelText('Name'), 'Trial plot')
    await user.type(screen.getByLabelText('Ceiling above takeoff'), '45')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(editing()).toBeNull()
    })
    const saved = (await backend.geofences(NORTH.id)).find(({ name }) => name === 'Trial plot')
    expect(saved).toMatchObject({ maxHeightM: 45, origin: 'drawn', marginM: null })
    expect(saved?.polygon).toEqual([at(0, 0), at(50, 0), at(50, 40)])
    expect(search().get('geofence')).toBe(saved?.id)
  })

  it('shows crossing edges as it is drawn, and every other reason once Save is pressed', async () => {
    const { backend } = await farm()
    const { user } = await openAt(backend, '?panel=geofences')
    await user.click(await screen.findByRole('button', { name: 'New' }))
    place([0, 0], [100, 100], [100, 0], [0, 100])
    const reasons = () =>
      within(screen.getByRole('list', { name: 'Cannot be saved' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    expect(reasons()).toEqual(['Edges meet'])
    expect(screen.getByText('—')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(reasons()).toEqual(['Name missing', 'Edges meet', 'Ceiling missing'])
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true')
    expect(await backend.geofences(NORTH.id)).toHaveLength(2)
  })

  it('refuses a ceiling that is not above zero, and saves nothing', async () => {
    const { backend } = await farm()
    const { user } = await openAt(backend, '?panel=geofences')
    await user.click(await screen.findByRole('button', { name: 'New' }))
    place([0, 0], [50, 0], [50, 40])
    await user.type(screen.getByLabelText('Name'), 'Trial plot')
    await user.type(screen.getByLabelText('Ceiling above takeoff'), '0')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText('Ceiling not above 0 m')).toBeVisible()
    expect(await backend.geofences(NORTH.id)).toHaveLength(2)
  })

  it('undoes a step, and removes the vertex chosen', async () => {
    const { backend } = await farm()
    const { user } = await openAt(backend, '?panel=geofences')
    await user.click(await screen.findByRole('button', { name: 'New' }))
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
    place([0, 0], [50, 0], [50, 40], [0, 40])
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(editing()?.drawing.vertices).toHaveLength(3)
    act(() => {
      useGeofenceEditor.getState().change((current) => ({ ...closed(current), picked: 1 }))
    })
    await user.click(screen.getByRole('button', { name: 'Remove vertex 2' }))
    expect(editing()?.drawing.vertices).toEqual([at(0, 0), at(50, 40)])
    expect(editing()?.phase).toBe('placing')
  })

  it('puts the drawing away with the panel, and brings it back as it was', async () => {
    const { backend } = await farm()
    const { user } = await openAt(backend, '?panel=geofences')
    await user.click(await screen.findByRole('button', { name: 'New' }))
    place([0, 0], [50, 0])
    await user.click(screen.getByRole('button', { name: 'Close Geofences' }))
    await user.click(screen.getByRole('button', { name: 'Geofences' }))
    expect(await screen.findByRole('form', { name: 'New geofence' })).toBeVisible()
    expect(editing()?.drawing.vertices).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await geofences()).toBeVisible()
    expect(editing()).toBeNull()
  })
})

describe("a geofence's changes (FR-GEO-02)", () => {
  it('opens a saved one for editing from the inspector, and saves only what changed', async () => {
    const { backend, square } = await farm()
    const changed = vi.spyOn(backend, 'changeGeofence')
    const { user } = await openAt(backend, `?geofence=${square.id}`)
    await user.click(await within(inspector()).findByRole('button', { name: 'Edit' }))
    expect([search().get('panel'), search().get('geofence')]).toEqual(['geofences', square.id])
    expect(await screen.findByRole('form', { name: 'Edit North field' })).toBeVisible()
    const name = screen.getByLabelText('Name')
    await user.clear(name)
    await user.type(name, 'North field, west')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(changed).toHaveBeenCalledWith(square.id, { name: 'North field, west' })
    })
  })

  it('saves a generated geofence reshaped by hand as drawn, its margin gone', async () => {
    const { backend } = await farm()
    const generated = await backend.createGeofence(NORTH.id, {
      ...SQUARE,
      name: 'Round the corridor',
      origin: 'generated',
      marginM: 20,
    })
    const changed = vi.spyOn(backend, 'changeGeofence')
    const { user } = await openAt(backend, `?geofence=${generated.id}`)
    await user.click(await within(inspector()).findByRole('button', { name: 'Edit' }))
    await screen.findByRole('form', { name: 'Edit Round the corridor' })
    act(() => {
      useGeofenceEditor.getState().change((current) => ({
        ...current,
        drawing: { ...current.drawing, vertices: [at(0, 0), at(120, 0), at(0, 120)] },
      }))
    })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(changed).toHaveBeenCalledWith(generated.id, {
        polygon: [at(0, 0), at(120, 0), at(0, 120)],
        origin: 'drawn',
        marginM: null,
      })
    })
  })

  it('duplicates a geofence, and selects the copy', async () => {
    const { backend, square } = await farm()
    const { user } = await openAt(backend, `?geofence=${square.id}`)
    await user.click(await within(inspector()).findByRole('button', { name: 'Duplicate' }))
    await waitFor(() => {
      expect(search().get('geofence')).not.toBe(square.id)
    })
    const copy = (await backend.geofences(NORTH.id)).find(
      ({ id }) => id === search().get('geofence'),
    )
    expect(copy).toMatchObject({
      name: 'North field (copy)',
      maxHeightM: 60,
      polygon: SQUARE.polygon,
    })
  })

  it('retires a geofence for good once confirmed, and clears the selection', async () => {
    const { backend, square } = await farm()
    const { user } = await openAt(backend, `?panel=geofences&geofence=${square.id}`)
    await user.click(await within(inspector()).findByRole('button', { name: 'Retire' }))
    await user.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(await backend.geofences(NORTH.id)).toHaveLength(2)
    await user.click(within(inspector()).getByRole('button', { name: 'Retire' }))
    await user.click(screen.getByRole('button', { name: 'Retire for good' }))
    await waitFor(() => {
      expect(search().get('geofence')).toBeNull()
    })
    expect((await backend.geofences(NORTH.id)).map(({ name }) => name)).toEqual(['Almond rows'])
    await waitFor(async () => {
      expect(within(await geofences()).getAllByRole('button')).toHaveLength(1)
    })
  })

  it("leaves a viewer's buttons off, pointing at the reason", async () => {
    const { backend, square } = await farm('viewer')
    const { user } = await openAt(backend, `?panel=geofences&geofence=${square.id}`)
    expect(await screen.findByRole('button', { name: 'New' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await user.click(screen.getByRole('button', { name: 'New' }))
    expect(editing()).toBeNull()
    for (const action of ['Edit', 'Duplicate', 'Retire']) {
      const button = within(inspector()).getByRole('button', { name: action })
      expect(button).toHaveAttribute('aria-disabled', 'true')
      expect(button).toHaveAccessibleDescription(
        'Your role in Finca Norte only reads: editors and owners change geofences.',
      )
    }
  })
})

describe('a geofence generated round waylines (FR-GEO-03)', () => {
  it('follows the waylines chosen and the margin, and saves as generated', async () => {
    const { backend } = await farm()
    await backend.createWayline(NORTH.id, CORRIDOR)
    const { user } = await openAt(backend, '?panel=geofences')
    await user.click(await screen.findByRole('button', { name: 'Generate' }))
    expect(await screen.findByRole('form', { name: 'Generate a geofence' })).toBeVisible()
    expect(editing()?.drawing.vertices).toEqual([])
    await user.type(screen.getByRole('combobox', { name: 'Waylines' }), 'corridor')
    await user.click(await screen.findByRole('option', { name: /^Corridor 1/ }))
    const vertices = editing()?.drawing.vertices.length ?? 0
    expect(vertices).toBeGreaterThanOrEqual(3)
    expect(vertices).toBeLessThanOrEqual(32)
    const area = () => editing()?.drawing.vertices
    const before = area()
    act(() => {
      const margin = screen.getByLabelText('Margin')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(margin, '50')
      margin.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(screen.getByText('50 m')).toBeVisible()
    expect(area()).not.toEqual(before)
    await user.type(screen.getByLabelText('Name'), 'Round the corridor')
    await user.type(screen.getByLabelText('Ceiling above takeoff'), '60')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(editing()).toBeNull()
    })
    const saved = (await backend.geofences(NORTH.id)).find(
      ({ name }) => name === 'Round the corridor',
    )
    expect(saved).toMatchObject({ origin: 'generated', marginM: 50 })
  })

  it('offers no generation without a saved wayline', async () => {
    const { backend } = await farm()
    await openAt(backend, '?panel=geofences')
    expect(await screen.findByRole('button', { name: 'Generate' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })
})
