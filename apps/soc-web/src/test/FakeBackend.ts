import {
  BackendError,
  type Account,
  type Backend,
  type Organization,
  type SignInFailure,
} from '../backend/backend'
import { PASSWORD_FOR_TESTS } from './keys'

export const PILOT: Account = { userId: 'user-pilot', email: 'pilot@farm.test' }
export const NEIGHBOUR: Account = { userId: 'user-neighbour', email: 'neighbour@farm.test' }

export const NORTH: Organization = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Finca Norte',
  role: 'owner',
  position: { latitude: 41.6523, longitude: -4.7245 },
  timeZone: 'Europe/Madrid',
}

export const ORCHARD: Organization = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Almendral',
  role: 'viewer',
  position: null,
  timeZone: null,
}

/** The backend in memory: accounts, their organizations, and the failures a test asks for. */
export class FakeBackend implements Backend {
  readonly address = 'http://192.168.1.40:8000'
  readonly memberships = new Map<string, Organization[]>([
    [PILOT.userId, [NORTH, ORCHARD]],
    [NEIGHBOUR.userId, [NORTH]],
  ])
  signInFailure: SignInFailure | null = null
  organizationsFailure: BackendError | null = null
  organizationReads = 0
  private account: Account | null
  private readonly listeners = new Set<(account: Account | null) => void>()

  constructor(signedIn: Account | null = null) {
    this.account = signedIn
  }

  onAccountChange(listener: (account: Account | null) => void): () => void {
    this.listeners.add(listener)
    queueMicrotask(() => {
      listener(this.account)
    })
    return () => this.listeners.delete(listener)
  }

  signIn(email: string, password: string): Promise<SignInFailure | null> {
    if (this.signInFailure !== null) return Promise.resolve(this.signInFailure)
    const account = [PILOT, NEIGHBOUR].find((known) => known.email === email)
    if (account === undefined || password !== PASSWORD_FOR_TESTS) {
      return Promise.resolve({ reason: 'credentials', detail: 'Invalid login credentials' })
    }
    this.become(account)
    return Promise.resolve(null)
  }

  signOut(): Promise<void> {
    this.become(null)
    return Promise.resolve()
  }

  /** The session ends on the server's side: revoked, or its refresh token expired. */
  endSession(): void {
    this.become(null)
  }

  memberOrganizations(): Promise<Organization[]> {
    this.organizationReads += 1
    if (this.organizationsFailure !== null) return Promise.reject(this.organizationsFailure)
    if (this.account === null) return Promise.reject(new BackendError('JWT expired', 'PGRST301'))
    return Promise.resolve(this.memberships.get(this.account.userId) ?? [])
  }

  private become(account: Account | null): void {
    this.account = account
    for (const listener of this.listeners) listener(account)
  }
}
