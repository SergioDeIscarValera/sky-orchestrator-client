import { screen, waitFor, within } from '@testing-library/react'

import type { FleetDraft } from '../backend/backend'
import { device, FakeBackend, MAVIC_AIR_2, NEIGHBOUR, NORTH } from '../test/FakeBackend'
import { renderApp } from '../test/render'

const DRAFT: FleetDraft = {
  name: 'Norte 1',
  model: MAVIC_AIR_2.model,
  airframeSerial: '1WNBH9',
  controllerSerial: null,
  gatewaySn: 'SOTESTDOCK01',
  aircraftSn: 'SOTESTUAV001',
  flightTimeBeforeSocS: 0,
}

/** North with Norte 1 on SOTESTUAV001, and SOTESTUAV002 seen but in no fleet. */
async function openFarm(at = '/') {
  const backend = new FakeBackend(NEIGHBOUR)
  backend.seen.set(NORTH.id, [device('SOTESTUAV001'), device('SOTESTUAV002', false)])
  const fleet = await backend.registerFleet(NORTH.id, DRAFT)
  window.history.replaceState(null, '', at)
  const rendered = renderApp(backend)
  await screen.findByRole('banner')
  return { ...rendered, fleet }
}

const field = () => screen.getByRole('combobox', { name: 'Search aircraft' })
const results = () => within(screen.getByRole('listbox', { name: 'Aircraft found' }))
const inspector = () => screen.queryByRole('complementary', { name: 'Inspector' })
const said = () => within(screen.getByRole('search')).getByRole('status')
const search = () => new URLSearchParams(window.location.search)

afterEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('the search in the top bar (FR-SCN-05, NFR-UX-03)', () => {
  it('finds a fleet by name and selects it with Enter, so the inspector shows it', async () => {
    const { user, fleet } = await openFarm()
    await user.type(field(), 'norte')
    const found = await results().findAllByRole('option')
    expect(found.map((option) => option.textContent)).toEqual([
      'Norte 1DJI Mavic Air 2 · SOTESTUAV001Fleet',
    ])
    expect(found[0]).toHaveAttribute('aria-selected', 'true')
    expect(said()).toHaveTextContent('1 found')

    await user.keyboard('{Enter}')
    await waitFor(() => {
      expect(search().get('fleet')).toBe(fleet.id)
    })
    expect(
      await within(inspector() ?? document.body).findByRole('heading', { name: 'Norte 1' }),
    ).toBeVisible()
    expect(field()).toHaveValue('')
    expect(field()).not.toHaveFocus()
  })

  it('finds an aircraft in no fleet by serial, and selects it with a click', async () => {
    const { user } = await openFarm()
    await user.type(field(), 'uav00')
    // Both serials hold `uav00`; the result reads in full, its match marked inside.
    const options = await results().findAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      'Norte 1DJI Mavic Air 2 · SOTESTUAV001Fleet',
      'SOTESTUAV002Not registered · via labAircraft',
    ])
    expect(options[1]?.querySelector('mark')).toHaveTextContent(/^UAV00$/)
    // Norte 1 is found by its serial, so the serial is marked in its detail.
    expect(options[0]?.querySelector('mark')).toHaveTextContent(/^UAV00$/)
    await user.click(options[1] as HTMLElement)
    await waitFor(() => {
      expect([search().get('gateway'), search().get('aircraft')]).toEqual([
        'SOTESTDOCK01',
        'SOTESTUAV002',
      ])
    })
  })

  it('lists everything on the arrow key with nothing typed, the fleets first', async () => {
    const { user } = await openFarm()
    await user.click(field())
    await user.keyboard('{ArrowDown}')
    const names = (await results().findAllByRole('option')).map(
      (option) => option.firstElementChild?.nextElementSibling?.firstElementChild?.textContent,
    )
    expect(names).toEqual(['Norte 1', 'SOTESTUAV002'])
  })

  it('says when nothing matches, and selects nothing', async () => {
    const { user } = await openFarm()
    await user.type(field(), 'sur')
    expect(await screen.findByText('No aircraft matches “sur”.')).toBeVisible()
    expect(said()).toHaveTextContent('No aircraft matches')
    expect(results().queryAllByRole('option')).toHaveLength(0)
    await user.keyboard('{Enter}')
    expect(window.location.search).toBe('')
  })

  it('says when the organization has no aircraft yet', async () => {
    window.history.replaceState(null, '', '/')
    const backend = new FakeBackend(NEIGHBOUR)
    backend.seen.set(NORTH.id, [])
    const { user } = renderApp(backend)
    await screen.findByRole('banner')
    await user.click(field())
    await user.keyboard('{ArrowDown}')
    expect(await screen.findByText('No aircraft yet.')).toBeVisible()
  })

  it('never selects on leaving the field, and keeps what was typed', async () => {
    const { user } = await openFarm()
    await user.type(field(), 'norte')
    await results().findByRole('option', { name: /^Norte 1/ })
    await user.tab()
    await user.click(document.body)
    expect(window.location.search).toBe('')
    expect(field()).toHaveValue('norte')
  })

  it('steps back one Escape at a time: the results, the text, then the selection', async () => {
    const { user } = await openFarm('/?gateway=SOTESTDOCK01&aircraft=SOTESTUAV002')
    await screen.findByRole('complementary', { name: 'Inspector' })
    await user.type(field(), 'norte')
    await results().findByRole('option', { name: /^Norte 1/ })
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('option')).toBeNull()
    expect(field()).toHaveValue('norte')
    await user.keyboard('{Escape}')
    expect(field()).toHaveValue('')
    expect(search().get('aircraft')).toBe('SOTESTUAV002')
    // Nothing left to close in the search, Escape steps back as anywhere else.
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(inspector()).toBeNull()
    })
  })

  it('focuses on `/`, but types it in a field', async () => {
    const { user } = await openFarm()
    expect(field()).not.toHaveFocus()
    await user.keyboard('/')
    expect(field()).toHaveFocus()
    expect(field()).toHaveValue('')
    await user.keyboard('a/b')
    expect(field()).toHaveValue('a/b')
  })
})
