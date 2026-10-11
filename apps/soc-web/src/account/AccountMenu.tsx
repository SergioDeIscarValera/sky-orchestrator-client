import { CircleUserRound, LogOut } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'

import { useBackend } from '../backend/context'
import { MENU, MENU_ITEM } from '../app/styles'
import { useAccount } from './account'

export function AccountMenu() {
  const account = useAccount()
  const backend = useBackend()
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        aria-label="Account"
        className="rounded-pill text-muted hover:bg-primary-subtle hover:text-primary-emphasis grid size-9 place-items-center transition-colors duration-200"
      >
        <CircleUserRound size={20} aria-hidden />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={8} className={MENU}>
          <DropdownMenu.Label className="flex flex-col px-3 py-2">
            <span className="text-muted text-xs">Signed in as</span>
            <span className="text-heading text-sm">{account.email}</span>
          </DropdownMenu.Label>
          <DropdownMenu.Separator className="bg-border my-1 h-px" />
          <DropdownMenu.Item className={MENU_ITEM} onSelect={() => void backend.signOut()}>
            <LogOut size={14} aria-hidden />
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
