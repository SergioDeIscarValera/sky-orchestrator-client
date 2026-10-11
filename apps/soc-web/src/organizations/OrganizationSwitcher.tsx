import { Check, ChevronsUpDown } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'

import { MENU, MENU_ITEM } from '../app/styles'
import { useOrganization } from './context'
import { roleName } from './format'

export function OrganizationSwitcher() {
  const { organization, organizations, choose } = useOrganization()
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label={`Organization: ${organization.name}`}
        className="rounded-pill bg-primary-subtle text-primary-emphasis inline-flex h-8 items-center gap-2 px-3 text-sm font-medium"
      >
        {organization.name}
        <ChevronsUpDown size={14} aria-hidden />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={8} className={MENU}>
          <DropdownMenu.Label className="text-muted px-3 py-1.5 text-xs tracking-wider uppercase">
            Organizations
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={organization.id} onValueChange={choose}>
            {organizations.map(({ id, name, role }) => (
              <DropdownMenu.RadioItem key={id} value={id} className={MENU_ITEM}>
                <span className="flex-1">{name}</span>
                <span className="text-muted text-xs">{roleName(role)}</span>
                <span className="grid w-3.5 place-items-center">
                  <DropdownMenu.ItemIndicator>
                    <Check size={14} aria-hidden />
                  </DropdownMenu.ItemIndicator>
                </span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
