import { screen, within } from '@testing-library/react'

import { useCameraCommands } from '../scene/commands'
import { FakeBackend, NORTH, ORCHARD, PILOT } from '../test/FakeBackend'
import { renderApp } from '../test/render'

async function openedOn(organizationId: string, search = '') {
  window.history.replaceState(null, '', `/${search}`)
  window.localStorage.setItem(`soc.organization.${PILOT.userId}`, organizationId)
  const rendered = renderApp(new FakeBackend(PILOT))
  await screen.findByRole('banner')
  return rendered
}

afterEach(() => {
  window.history.replaceState(null, '', '/')
  Reflect.deleteProperty(window, 'socScene')
})

describe('the scene region (FR-SCN-01)', () => {
  it('says plainly when the browser cannot draw the scene', async () => {
    await openedOn(NORTH.id)
    const scene = screen.getByRole('main', { name: 'Scene' })
    expect(within(scene).getByRole('status')).toHaveTextContent('SOC needs WebGL 2')
  })

  it('names the missing site model, or the missing position', async () => {
    await openedOn(NORTH.id)
    expect(screen.getByRole('note')).toHaveTextContent(
      'No site model for Finca Norte yet: the ground is flat.',
    )
  })

  it('stays the same region when the organization changes', async () => {
    const { user } = await openedOn(NORTH.id)
    const scene = screen.getByRole('main', { name: 'Scene' })
    await user.click(screen.getByRole('button', { name: `Organization: ${NORTH.name}` }))
    await user.click(await screen.findByRole('menuitemradio', { name: /Almendral/ }))
    await screen.findByRole('button', { name: `Organization: ${ORCHARD.name}` })
    expect(screen.getByRole('main', { name: 'Scene' })).toBe(scene)
    expect(screen.getByRole('note')).toHaveTextContent(
      'Almendral has no position in Virtual Origen: the scene is not on the map.',
    )
  })

  it('shows its statistics only when asked, and hands the sampler over', async () => {
    await openedOn(NORTH.id)
    expect(screen.queryByRole('definition')).toBeNull()
    expect(Reflect.has(window, 'socScene')).toBe(false)
  })

  it('shows frames, frame time, draw calls and memory with ?stats (NFR-OBS-05)', async () => {
    await openedOn(NORTH.id, '?stats')
    const stats = screen.getByLabelText('Scene statistics')
    for (const name of ['frames', 'p95', 'draw calls', 'geometries', 'textures']) {
      expect(within(stats).getByText(name)).toBeInTheDocument()
    }
    expect(Reflect.has(window, 'socScene')).toBe(true)
  })
})

describe('the map tools (FR-SCN-03)', () => {
  it('ask the camera to come closer, go farther and return to the overview', async () => {
    const { user } = await openedOn(NORTH.id)
    const tools = screen.getByRole('toolbar', { name: 'Map tools' })
    const sent = () => useCameraCommands.getState().last?.command
    await user.click(within(tools).getByRole('button', { name: 'Closer' }))
    expect(sent()).toBe('closer')
    await user.click(within(tools).getByRole('button', { name: 'Farther' }))
    expect(sent()).toBe('farther')
    await user.click(within(tools).getByRole('button', { name: 'Back to the site overview' }))
    expect(sent()).toBe('overview')
  })
})
