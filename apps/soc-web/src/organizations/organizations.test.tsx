import { screen, waitFor, within } from '@testing-library/react'

import { BackendError, type Fleet } from '../backend/backend'
import { FakeBackend, NEIGHBOUR, NORTH, ORCHARD, PILOT } from '../test/FakeBackend'
import { renderApp, signIn } from '../test/render'
import { organizationKey } from './scope'

const switcher = (name: string) => screen.findByRole('button', { name: `Organization: ${name}` })

describe('organization first (FR-AUT-02)', () => {
  it('opens the only organization of a member of one', async () => {
    const { user } = renderApp()
    await signIn(user, NEIGHBOUR.email)
    expect(await switcher(NORTH.name)).toBeInTheDocument()
    expect(screen.getByRole('main', { name: 'Scene' })).toBeInTheDocument()
  })

  it('asks a member of several to choose, then remembers the choice on this device', async () => {
    const { user, unmount } = renderApp()
    await signIn(user, PILOT.email)
    const picker = await screen.findByRole('main', { name: 'Choose an organization' })
    expect(within(picker).getByText('41.6523° N, 4.7245° W')).toBeInTheDocument()
    expect(within(picker).getByText('No position set')).toBeInTheDocument()
    await user.click(within(picker).getByRole('button', { name: /Almendral/ }))
    expect(await switcher(ORCHARD.name)).toBeInTheDocument()
    unmount()

    renderApp(new FakeBackend(PILOT))
    expect(await switcher(ORCHARD.name)).toBeInTheDocument()
  })

  it('asks again when the remembered organization is no longer theirs', async () => {
    window.localStorage.setItem(`soc.organization.${PILOT.userId}`, 'gone')
    renderApp(new FakeBackend(PILOT))
    expect(await screen.findByRole('main', { name: 'Choose an organization' })).toBeInTheDocument()
  })

  it("does not open another user's choice on a shared device", async () => {
    window.localStorage.setItem(`soc.organization.${NEIGHBOUR.userId}`, ORCHARD.id)
    renderApp(new FakeBackend(PILOT))
    expect(await screen.findByRole('main', { name: 'Choose an organization' })).toBeInTheDocument()
  })

  it('says so when the account has no organization, and lets the user leave', async () => {
    const backend = new FakeBackend(PILOT)
    backend.memberships.set(PILOT.userId, [])
    const { user } = renderApp(backend)
    expect(await screen.findByRole('heading', { name: 'No organization to open' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('names the missing schema and loads once it is served', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    backend.organizationsFailure = new BackendError('Invalid schema: soc', 'PGRST106')
    const { user } = renderApp(backend)
    expect(await screen.findByRole('alert')).toHaveTextContent('PGRST_DB_SCHEMAS')
    backend.organizationsFailure = null
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await switcher(NORTH.name)).toBeInTheDocument()
  })

  it('switches organization from the top bar and drops what the other one had', async () => {
    window.localStorage.setItem(`soc.organization.${PILOT.userId}`, NORTH.id)
    const backend = new FakeBackend(PILOT)
    const { user, queryClient } = renderApp(backend)
    await user.click(await switcher(NORTH.name))
    await waitFor(() => {
      expect([backend.watching(NORTH.id), backend.watching(ORCHARD.id)]).toEqual([1, 0])
    })
    const north: Fleet = {
      id: '55555555-5555-4555-8555-555555555555',
      name: 'Norte 1',
      model: 'mavic-air-2',
      airframeSerial: '1WNBH9',
      controllerSerial: null,
      gatewaySn: 'SOTESTDOCK01',
      aircraftSn: 'SOTESTUAV001',
      flightTimeBeforeSocS: 0,
      createdAt: '2026-10-11T10:10:00Z',
      updatedAt: '2026-10-11T10:10:00Z',
    }
    queryClient.setQueryData(organizationKey(NORTH.id, 'fleets'), [north])
    queryClient.setQueryData(organizationKey(ORCHARD.id, 'fleets'), [])
    await user.click(await screen.findByRole('menuitemradio', { name: /Almendral/ }))

    expect(await switcher(ORCHARD.name)).toBeInTheDocument()
    expect(queryClient.getQueryData(organizationKey(NORTH.id, 'fleets'))).toBeUndefined()
    expect(queryClient.getQueryData(organizationKey(ORCHARD.id, 'fleets'))).toEqual([])
    expect(window.localStorage.getItem(`soc.organization.${PILOT.userId}`)).toBe(ORCHARD.id)
    // React runs the effects of a switch after the page shows it.
    await waitFor(() => {
      expect([backend.watching(NORTH.id), backend.watching(ORCHARD.id)]).toEqual([0, 1])
    })
  })
})
