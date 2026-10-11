import { LogIn } from 'lucide-react'
import { useState, useTransition, type SubmitEvent } from 'react'

import type { SignInFailure } from '../backend/backend'
import { useBackend } from '../backend/context'
import { Card } from '../app/Centered'
import { ALERT, FIELD, PRIMARY_BUTTON } from '../app/styles'

export function SignIn() {
  const backend = useBackend()
  const [failure, setFailure] = useState<SignInFailure | null>(null)
  const [signingIn, startSigningIn] = useTransition()

  function signIn(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    startSigningIn(async () => {
      setFailure(await backend.signIn(field(form, 'email'), field(form, 'password')))
    })
  }

  return (
    <Card title="Sign in">
      <p className="mt-2 text-sm">With your Virtual Origen account.</p>
      <form onSubmit={signIn} className="mt-6 flex flex-col gap-4">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-heading font-medium">Email</span>
          <input name="email" type="email" required autoComplete="username" className={FIELD} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-heading font-medium">Password</span>
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className={FIELD}
          />
        </label>
        {failure !== null && (
          <p role="alert" className={ALERT}>
            {explain(failure, backend.address)}
          </p>
        )}
        <button type="submit" disabled={signingIn} className={`${PRIMARY_BUTTON} mt-2`}>
          <LogIn size={16} aria-hidden />
          {signingIn ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="text-muted mt-6 text-xs">
        Accounts, passwords and organizations are managed in Virtual Origen.
      </p>
    </Card>
  )
}

function explain(failure: SignInFailure, address: string): string {
  switch (failure.reason) {
    case 'credentials':
      return 'The email or the password is wrong.'
    case 'unconfirmed':
      return "This account's email is not confirmed yet. Confirm it from Virtual Origen's email first."
    case 'rate_limited':
      return 'Too many attempts. Wait a minute, then try again.'
    case 'unreachable':
      return `Supabase at ${address} does not answer. Check that the farm's server is on and that this computer is on its network.`
    case 'other':
      return failure.detail
  }
}

function field(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}
