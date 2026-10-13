import { screen, waitFor, within } from '@testing-library/react'

import { FieldRefusedError, type Operation } from '../backend/backend'
import { FakeBackend, NEIGHBOUR, NORTH } from '../test/FakeBackend'
import { renderApp } from '../test/render'

const EDITOR = 'user-ana'
const VIEWER = 'user-luis'

/** Finca Norte with an editor, a viewer and the owner as members, and one operation to name them in. */
async function farm(): Promise<{
  readonly backend: FakeBackend
  readonly operation: Operation
}> {
  const backend = new FakeBackend(NEIGHBOUR)
  backend.profiles.set(EDITOR, { displayName: 'Ana Ruiz', email: 'ana@farm.test' })
  backend.memberships.set(EDITOR, [{ ...NORTH, role: 'editor' }])
  backend.profiles.set(VIEWER, { displayName: 'Luis Peña', email: 'luis@farm.test' })
  backend.memberships.set(VIEWER, [{ ...NORTH, role: 'viewer' }])
  const operation = await backend.createOperation(NORTH.id, {
    name: 'North corridor',
    geofenceId: null,
    takeoffSecurityHeightM: null,
  })
  return { backend, operation }
}

async function openAt(backend: FakeBackend, operationId: string) {
  window.history.replaceState(null, '', `/?panel=operations&operation=${operationId}`)
  const rendered = renderApp(backend)
  await screen.findByRole('banner')
  return rendered
}

const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })
const roleOf = (name: string) =>
  within(inspector()).findByRole('combobox', { name: `Operator role of ${name}` })

afterEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('the operators of an operation (IR-OPR, FR-CMD-01)', () => {
  it('offers pilot only to the editors and owners of the organization', async () => {
    const { backend, operation } = await farm()
    await openAt(backend, operation.id)
    const ana = await roleOf('Ana Ruiz')
    expect(within(ana).getByRole('option', { name: 'Pilot' })).toBeEnabled()
    const luis = await roleOf('Luis Peña')
    expect(within(luis).queryByRole('option', { name: 'Pilot' })).toBeNull()
    expect(within(luis).getByRole('option', { name: 'Observer' })).toBeEnabled()
    const owner = await roleOf('neighbour@farm.test')
    expect(within(owner).getByRole('option', { name: 'Pilot' })).toBeEnabled()
  })

  it('names, changes and removes an operator, each as one write, and returns it to none', async () => {
    const { backend, operation } = await farm()
    const { user } = await openAt(backend, operation.id)
    const ana = await roleOf('Ana Ruiz')
    await user.selectOptions(ana, 'observer')
    await waitFor(() => {
      expect(backend.operatorRows.get(operation.id)).toEqual([
        { operationId: operation.id, profileId: EDITOR, role: 'observer' },
      ])
    })
    await waitFor(() => {
      expect(ana).toBeEnabled()
    })
    await user.selectOptions(ana, 'pilot')
    await waitFor(() => {
      expect(backend.operatorRows.get(operation.id)).toEqual([
        { operationId: operation.id, profileId: EDITOR, role: 'pilot' },
      ])
    })
    await waitFor(() => {
      expect(ana).toBeEnabled()
    })
    await user.selectOptions(ana, 'none')
    await waitFor(() => {
      expect(backend.operatorRows.get(operation.id)).toEqual([])
    })
    expect(ana).toHaveValue('none')
  })

  it('shows a refusal on the member row it concerns', async () => {
    const { backend, operation } = await farm()
    vi.spyOn(backend, 'nameOperator').mockRejectedValueOnce(
      new FieldRefusedError(
        'This member is already an operator of the operation.',
        'profileId',
        '23505',
      ),
    )
    const { user } = await openAt(backend, operation.id)
    await user.selectOptions(await roleOf('Ana Ruiz'), 'observer')
    const message = await screen.findByText('This member is already an operator of the operation.')
    expect(message.closest('li')).toContainElement(await roleOf('Ana Ruiz'))
  })

  it('keeps a pilot who is no longer an editor shown as a disabled pilot, not offered again', async () => {
    const { backend, operation } = await farm()
    await backend.nameOperator(operation.id, NORTH.id, VIEWER, 'pilot')
    await openAt(backend, operation.id)
    const luis = await roleOf('Luis Peña')
    expect(luis).toHaveValue('pilot')
    expect(within(luis).getByRole('option', { name: 'Pilot' })).toBeDisabled()
    expect(within(luis).getByRole('option', { name: 'Observer' })).toBeEnabled()
  })

  it('reads the operators, with nothing to change, for a viewer', async () => {
    const { backend, operation } = await farm()
    await backend.nameOperator(operation.id, NORTH.id, EDITOR, 'observer')
    backend.memberships.set(NEIGHBOUR.userId, [{ ...NORTH, role: 'viewer' }])
    await openAt(backend, operation.id)
    expect(await within(inspector()).findByText('Observer')).toBeVisible()
    expect(screen.queryByRole('combobox', { name: /Operator role of/ })).toBeNull()
  })
})
