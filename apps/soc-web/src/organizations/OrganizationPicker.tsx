import { ChevronRight } from 'lucide-react'

import { useAccount } from '../account/account'
import { SignOut } from '../account/SignOut'
import type { Organization } from '../backend/backend'
import { Card } from '../app/Centered'
import { formatPosition, roleName } from './format'

interface Props {
  readonly organizations: readonly Organization[]
  readonly onChoose: (organizationId: string) => void
}

export function OrganizationPicker({ organizations, onChoose }: Props) {
  const account = useAccount()
  return (
    <Card title="Choose an organization">
      <p className="mt-2 text-sm">
        Signed in as {account.email}. This device remembers your choice.
      </p>
      <ul className="mt-6 flex flex-col gap-2">
        {organizations.map((organization) => (
          <li key={organization.id}>
            <button
              type="button"
              onClick={() => {
                onChoose(organization.id)
              }}
              className="border-border hover:border-primary hover:bg-primary-subtle group flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors duration-200"
            >
              <span className="flex flex-1 flex-col">
                <span className="font-heading text-heading font-semibold">{organization.name}</span>
                <span className="text-muted text-xs tabular-nums">
                  {formatPosition(organization.position)}
                </span>
              </span>
              <span className="rounded-pill bg-info-subtle text-info-emphasis px-2.5 py-0.5 text-xs">
                {roleName(organization.role)}
              </span>
              <ChevronRight size={16} aria-hidden className="text-muted" />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-6">
        <SignOut />
      </div>
    </Card>
  )
}
