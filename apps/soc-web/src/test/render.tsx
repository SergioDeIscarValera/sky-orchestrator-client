import { QueryClient } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { App } from '../app/App'
import { FakeBackend } from './FakeBackend'
import { PASSWORD_FOR_TESTS } from './keys'

export function quietQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

export function renderApp(backend = new FakeBackend(), queryClient = quietQueryClient()) {
  const user = userEvent.setup({ delay: null })
  const view = render(<App backend={backend} queryClient={queryClient} />)
  return { ...view, user, backend, queryClient }
}

export async function signIn(
  user: ReturnType<typeof userEvent.setup>,
  email: string,
  password = PASSWORD_FOR_TESTS,
): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), email)
  await user.type(screen.getByLabelText('Password'), password)
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
}
