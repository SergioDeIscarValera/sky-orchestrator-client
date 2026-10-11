import { Search } from 'lucide-react'

import { AccountMenu } from '../account/AccountMenu'
import { useOrganization } from '../organizations/context'
import { OrganizationSwitcher } from '../organizations/OrganizationSwitcher'
import { Brand } from './Brand'
import { LiveClock } from './LiveClock'
import { ThemeToggle } from './ThemeToggle'
import { CARD } from './styles'

export function TopBar() {
  const { organization } = useOrganization()
  return (
    <header className={`${CARD} pointer-events-auto flex h-14 items-center gap-4 px-4`}>
      <h1>
        <Brand />
      </h1>
      <OrganizationSwitcher />
      <div className="text-muted ml-4 flex flex-1 items-center gap-2 text-sm">
        <Search size={16} aria-hidden />
        <span>Search</span>
        <kbd className="border-border rounded-md border px-1.5 text-xs">/</kbd>
      </div>
      <LiveClock timeZone={organization.timeZone} />
      <ThemeToggle />
      <AccountMenu />
    </header>
  )
}
