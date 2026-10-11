import { screen, waitFor } from '@testing-library/react'

import { FakeBackend, NEIGHBOUR, NORTH, PILOT } from '../test/FakeBackend'
import { renderApp, signIn } from '../test/render'

const switcher = (name: string) => screen.findByRole('button', { name: `Organization: ${name}` })

describe('signing in (FR-AUT-01)', () => {
  it('asks a visitor to sign in, and offers no way to create an account', async () => {
    renderApp()
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByText(/sign up|register|create an account/i)).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('says the password is wrong and keeps the email typed', async () => {
    const { user } = renderApp()
    await signIn(user, PILOT.email, 'wrong')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The email or the password is wrong.',
    )
    expect(screen.getByLabelText('Email')).toHaveValue(PILOT.email)
  })

  it('names the address that does not answer', async () => {
    const backend = new FakeBackend()
    backend.signInFailure = { reason: 'unreachable', detail: backend.address }
    const { user } = renderApp(backend)
    await signIn(user, PILOT.email)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Supabase at http://192.168.1.40:8000 does not answer.',
    )
  })

  it('restores a session without asking again', async () => {
    renderApp(new FakeBackend(NEIGHBOUR))
    expect(await switcher(NORTH.name)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull()
  })
})

describe('leaving (FR-AUT-04)', () => {
  it('signs out from the account menu and forgets everything fetched', async () => {
    const { user, queryClient } = renderApp(new FakeBackend(NEIGHBOUR))
    await user.click(await screen.findByRole('button', { name: 'Account' }))
    expect(await screen.findByText(NEIGHBOUR.email)).toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    await waitFor(() => {
      expect(queryClient.getQueryCache().getAll()).toEqual([])
    })
  })

  it('returns to sign-in when the server ends the session', async () => {
    const backend = new FakeBackend(NEIGHBOUR)
    renderApp(backend)
    await switcher(NORTH.name)
    backend.endSession()
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
  })
})
