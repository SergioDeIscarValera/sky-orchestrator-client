import { ChevronDown } from 'lucide-react'
import { useId, type ReactNode } from 'react'

import { useSelect } from '../app/router'
import { QUIET_BUTTON } from '../app/styles'

/**
 * A titled list of facts. `folded`, it is a disclosure the user opens: the facts that
 * matter less than what is happening, kept a click away.
 */
export function Details({
  title,
  aside,
  rows,
  folded = false,
  children,
}: {
  readonly title: string
  /** Said of the whole section, beside its title. */
  readonly aside?: ReactNode
  readonly rows: readonly (readonly [string, ReactNode])[]
  readonly folded?: boolean
  /** Said after the facts. */
  readonly children?: ReactNode
}) {
  const heading = useId()
  const facts = (
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className="text-heading min-w-0 text-right break-words">{value}</dd>
        </div>
      ))}
    </dl>
  )
  if (folded) {
    return (
      <details className="group border-border mt-4 border-t pt-3">
        <summary className="text-muted hover:text-heading flex cursor-pointer list-none items-center justify-between text-xs font-semibold tracking-wider uppercase transition-colors duration-200">
          {title}
          <ChevronDown
            size={16}
            aria-hidden
            className="transition-transform duration-200 group-open:rotate-180"
          />
        </summary>
        {facts}
        {children}
      </details>
    )
  }
  return (
    <section aria-labelledby={heading} className="mt-5">
      <div className="flex items-center justify-between gap-3">
        <h4 id={heading} className="text-muted text-xs font-semibold tracking-wider uppercase">
          {title}
        </h4>
        {aside}
      </div>
      {facts}
      {children}
    </section>
  )
}

/** What a stale link or a retired fleet leaves selected, with the way out. */
export function Gone({ children }: { readonly children: ReactNode }) {
  const select = useSelect()
  return (
    <div>
      <p className="text-sm">{children}</p>
      <button
        type="button"
        className={`${QUIET_BUTTON} mt-3 -ml-3`}
        onClick={() => {
          select(null)
        }}
      >
        Clear the selection
      </button>
    </div>
  )
}

export function Waiting({ children }: { readonly children: ReactNode }) {
  return <p className="text-muted text-sm">{children}</p>
}

/** Why a viewer's buttons are off; the buttons point at it. */
export function ReadOnlyReason({
  id,
  organization,
}: {
  readonly id: string
  readonly organization: string
}) {
  return (
    <p id={id} className="text-muted mt-2 text-xs">
      Your role in {organization} only reads: editors and owners change fleets.
    </p>
  )
}
