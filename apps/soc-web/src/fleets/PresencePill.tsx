import type { Device } from '../backend/backend'
import { useLink } from '../backend/context'
import { presenceLabel, presenceOf, type Presence } from './format'

const TONE: Readonly<Record<Presence, string>> = {
  online: 'bg-success-subtle text-success-emphasis',
  offline: 'border-border text-muted border',
  unknown: 'bg-warning-subtle text-warning-emphasis',
}

export function PresencePill({ device }: { readonly device: Device }) {
  const link = useLink()
  return (
    <span
      className={`rounded-pill inline-flex h-6 shrink-0 items-center px-2.5 text-xs font-medium whitespace-nowrap ${TONE[presenceOf(device, link)]}`}
    >
      {presenceLabel(device, link)}
    </span>
  )
}
