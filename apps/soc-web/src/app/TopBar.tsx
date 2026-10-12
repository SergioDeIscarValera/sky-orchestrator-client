import { AccountMenu } from '../account/AccountMenu'
import { useOrganization } from '../organizations/context'
import { OrganizationSwitcher } from '../organizations/OrganizationSwitcher'
import { SearchBox } from '../search/SearchBox'
import { Brand } from './Brand'
import { LinkPill } from './LinkPill'
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
      <SearchBox />
      <div className="flex-1" />
      <LinkPill />
      <LiveClock timeZone={organization.timeZone} />
      <ThemeToggle />
      <AccountMenu />
    </header>
  )
}
