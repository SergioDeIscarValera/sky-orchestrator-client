import { LogOut } from 'lucide-react'

import { useBackend } from '../backend/context'
import { QUIET_BUTTON } from '../app/styles'

export function SignOut() {
  const backend = useBackend()
  return (
    <button type="button" className={QUIET_BUTTON} onClick={() => void backend.signOut()}>
      <LogOut size={16} aria-hidden />
      Sign out
    </button>
  )
}
