export interface Account {
  readonly userId: string
  readonly email: string
}

export type Role = 'owner' | 'editor' | 'viewer'

export interface Position {
  readonly latitude: number
  readonly longitude: number
}

export interface Organization {
  readonly id: string
  readonly name: string
  readonly role: Role
  readonly position: Position | null
  readonly timeZone: string | null
}

export type SignInRefusal = 'credentials' | 'unconfirmed' | 'rate_limited' | 'unreachable' | 'other'

export interface SignInFailure {
  readonly reason: SignInRefusal
  readonly detail: string
}

export class BackendError extends Error {
  readonly code: string | null

  constructor(message: string, code: string | null = null) {
    super(message)
    this.code = code
  }
}

/** Everything the web asks of Supabase, so the interface can be tested without it. */
export interface Backend {
  readonly address: string
  onAccountChange(listener: (account: Account | null) => void): () => void
  signIn(email: string, password: string): Promise<SignInFailure | null>
  signOut(): Promise<void>
  memberOrganizations(): Promise<Organization[]>
}
