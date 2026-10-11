import { screen, waitFor, within } from '@testing-library/react'

import type { Fleet, FleetDraft } from '../backend/backend'
import {
  device,
  FakeBackend,
  MAVIC_AIR_2,
  NEIGHBOUR,
  NORTH,
  ORCHARD,
  PILOT,
} from '../test/FakeBackend'
import { renderApp } from '../test/render'

const DRAFT: FleetDraft = {
  name: 'Norte 1',
  model: MAVIC_AIR_2.model,
  airframeSerial: '1WNBH9',
  controllerSerial: null,
  gatewaySn: 'SOTESTDOCK01',
  aircraftSn: 'SOTESTUAV001',
  flightTimeBeforeSocS: 5400,
}

async function openAt(backend: FakeBackend, search: string) {
  window.history.replaceState(null, '', `/${search}`)
  const rendered = renderApp(backend)
  await screen.findByRole('banner')
  return rendered
}

const inspector = () => within(screen.getByRole('complementary', { name: 'Inspector' }))
const search = () => new URLSearchParams(window.location.search)

function farm() {
  const backend = new FakeBackend(NEIGHBOUR)
  backend.seen.set(NORTH.id, [device('SOTESTUAV001'), device('SOTESTUAV002', false)])
  return backend
}

describe('registering an aircraft seen (FR-FLE-03)', () => {
  it('asks for what the database needs, then registers it and shows the fleet', async () => {
    const backend = farm()
    const { user } = await openAt(
      backend,
      '?panel=fleet&gateway=SOTESTDOCK01&aircraft=SOTESTUAV001',
    )
    await user.click(await inspector().findByRole('button', { name: 'Register as a fleet' }))
    const form = within(screen.getByRole('form', { name: 'Register SOTESTUAV001' }))
    expect(form.getByText('SOTESTUAV001 via lab')).toBeInTheDocument()

    await user.click(form.getByRole('button', { name: 'Register' }))
    expect(form.getByLabelText('Name')).toHaveFocus()
    expect(form.getByLabelText('Name')).toHaveAccessibleDescription('A fleet needs a name.')
    expect(form.getByLabelText('Model')).toHaveAttribute('aria-invalid', 'true')
    expect(form.getByLabelText('Airframe serial')).toHaveAccessibleDescription(
      'As printed on the airframe. A fleet needs the serial printed on the airframe.',
    )
    expect(backend.registered.get(NORTH.id)).toBeUndefined()

    await user.type(form.getByLabelText('Name'), 'Norte 1')
    await user.selectOptions(form.getByLabelText('Model'), 'DJI Mavic Air 2')
    await user.type(form.getByLabelText('Airframe serial'), '1WNBH9')
    await user.clear(form.getByLabelText('Flight time before SOC, hours'))
    await user.type(form.getByLabelText('Flight time before SOC, hours'), '12')
    await user.clear(form.getByLabelText('Flight time before SOC, minutes'))
    await user.type(form.getByLabelText('Flight time before SOC, minutes'), '34')
    await user.click(form.getByRole('button', { name: 'Register' }))

    expect(await inspector().findByRole('heading', { name: 'Norte 1' })).toBeVisible()
    const [fleet] = backend.registered.get(NORTH.id) ?? []
    expect(fleet).toMatchObject({ flightTimeBeforeSocS: 45240, controllerSerial: null })
    expect(search().get('fleet')).toBe(fleet?.id)
    expect(inspector().getByText('12 h 34 min')).toBeInTheDocument()
  })

  it('shows the field the database refused, where it was typed', async () => {
    const backend = farm()
    const { user } = await openAt(backend, '?gateway=SOTESTDOCK01&aircraft=SOTESTUAV001')
    await user.click(await inspector().findByRole('button', { name: 'Register as a fleet' }))
    const form = within(screen.getByRole('form'))
    await user.type(form.getByLabelText('Name'), 'Norte 1')
    await user.selectOptions(form.getByLabelText('Model'), 'DJI Mavic Air 2')
    await user.type(form.getByLabelText('Airframe serial'), '1WNBH9')
    // Another console registers the same aircraft while this form is open.
    await new FakeBackend(NEIGHBOUR).registerFleet(NORTH.id, DRAFT).then((fleet) => {
      backend.registered.set(NORTH.id, [fleet])
    })
    await user.click(form.getByRole('button', { name: 'Register' }))
    expect(
      await form.findByText('This aircraft already belongs to a live fleet.'),
    ).toBeInTheDocument()
    expect(form.getByRole('button', { name: 'Register' })).toBeEnabled()
  })
})

describe('editing and retiring a fleet (FR-FLE-05)', () => {
  async function withFleet() {
    const backend = farm()
    const fleet = await backend.registerFleet(NORTH.id, DRAFT)
    const changes = vi.spyOn(backend, 'changeFleet')
    const rendered = await openAt(backend, `?panel=fleet&fleet=${fleet.id}`)
    await inspector().findByRole('heading', { name: 'Norte 1' })
    return { ...rendered, backend, fleet, changes }
  }

  it('writes only the fields that changed', async () => {
    const { user, fleet, changes } = await withFleet()
    await user.click(inspector().getByRole('button', { name: 'Edit' }))
    const form = within(screen.getByRole('form', { name: 'Edit Norte 1' }))
    expect(form.getByLabelText('Flight time before SOC, hours')).toHaveValue('1')
    await user.clear(form.getByLabelText('Name'))
    await user.type(form.getByLabelText('Name'), 'Norte Alfa')
    await user.click(form.getByRole('button', { name: 'Save' }))
    expect(await inspector().findByRole('heading', { name: 'Norte Alfa' })).toBeVisible()
    expect(changes).toHaveBeenCalledExactlyOnceWith(fleet.id, { name: 'Norte Alfa' })
  })

  it('writes nothing when nothing changed', async () => {
    const { user, changes } = await withFleet()
    await user.click(inspector().getByRole('button', { name: 'Edit' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await inspector().findByRole('button', { name: 'Edit' })).toBeVisible()
    expect(changes).not.toHaveBeenCalled()
  })

  it('moves the fleet to another aircraft seen, freeing the first', async () => {
    const { user, fleet, backend } = await withFleet()
    await user.click(inspector().getByRole('button', { name: 'Edit' }))
    const choice = screen.getByLabelText('Aircraft on the wire')
    expect(
      within(choice)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['SOTESTUAV001 via lab (now)', 'SOTESTUAV002 via lab'])
    await user.selectOptions(choice, 'SOTESTUAV002 via lab')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(backend.registered.get(NORTH.id)?.[0]?.aircraftSn).toBe('SOTESTUAV002')
    })
    expect(await screen.findByRole('button', { name: /^SOTESTUAV001/ })).toBeVisible()
    expect(search().get('fleet')).toBe(fleet.id)
  })

  it('retires only once confirmed, then shows the aircraft free again', async () => {
    const { user, backend } = await withFleet()
    await user.click(inspector().getByRole('button', { name: 'Retire' }))
    await user.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(backend.registered.get(NORTH.id)).toHaveLength(1)

    await user.click(inspector().getByRole('button', { name: 'Retire' }))
    const confirm = within(screen.getByRole('group', { name: 'Retire Norte 1' }))
    await user.click(confirm.getByRole('button', { name: 'Retire for good' }))
    expect(await inspector().findByRole('heading', { name: 'SOTESTUAV001' })).toBeVisible()
    expect(inspector().getByText('Not registered · via lab')).toBeVisible()
    expect(inspector().getByRole('button', { name: 'Register as a fleet' })).toBeVisible()
    expect(backend.registered.get(NORTH.id)).toEqual([])
    expect([search().get('gateway'), search().get('aircraft')]).toEqual([
      'SOTESTDOCK01',
      'SOTESTUAV001',
    ])
  })
})

describe('a viewer reads fleets (FR-FLE-03, FR-FLE-05)', () => {
  const THEIRS: Fleet = {
    ...DRAFT,
    id: '44444444-4444-4444-8444-444444444444',
    createdAt: '2026-10-11T10:10:00Z',
    updatedAt: '2026-10-11T10:10:00Z',
  }

  function orchard() {
    window.localStorage.setItem(`soc.organization.${PILOT.userId}`, ORCHARD.id)
    const backend = new FakeBackend(PILOT)
    backend.seen.set(ORCHARD.id, [device('SOTESTUAV001'), device('SOTESTUAV002')])
    backend.registered.set(ORCHARD.id, [THEIRS])
    return backend
  }

  it('sees why a fleet cannot be changed, and cannot open the form', async () => {
    const { user } = await openAt(orchard(), `?fleet=${THEIRS.id}`)
    const edit = await inspector().findByRole('button', { name: 'Edit' })
    const reason = 'Your role in Almendral only reads: editors and owners change fleets.'
    expect(edit).toHaveAttribute('aria-disabled', 'true')
    expect(edit).toHaveAccessibleDescription(reason)
    expect(inspector().getByRole('button', { name: 'Retire' })).toHaveAccessibleDescription(reason)
    await user.click(edit)
    await user.click(inspector().getByRole('button', { name: 'Retire' }))
    expect(screen.queryByRole('form')).toBeNull()
    expect(screen.queryByRole('group', { name: /^Retire/ })).toBeNull()
  })

  it("finds no Register nor Edit in the fleet panel, and a form's link opens nothing", async () => {
    await openAt(orchard(), '?panel=fleet&gateway=SOTESTDOCK01&aircraft=SOTESTUAV002&form=register')
    await inspector().findByRole('button', { name: 'Register as a fleet' })
    expect(screen.queryByRole('button', { name: /^Register SOTESTUAV/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull()
    expect(screen.queryByRole('form')).toBeNull()
  })

  it('sees why an aircraft cannot be registered', async () => {
    const { user } = await openAt(orchard(), '?gateway=SOTESTDOCK01&aircraft=SOTESTUAV002')
    const register = await inspector().findByRole('button', { name: 'Register as a fleet' })
    expect(register).toHaveAttribute('aria-disabled', 'true')
    await user.click(register)
    expect(screen.queryByRole('form')).toBeNull()
  })
})
