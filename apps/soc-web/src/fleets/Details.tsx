import { useId, type ReactNode } from 'react'

import { useSelect } from '../app/router'
import { QUIET_BUTTON } from '../app/styles'

export function Details({
  title,
  rows,
}: {
  readonly title: string
  readonly rows: readonly (readonly [string, ReactNode])[]
}) {
  const heading = useId()
  return (
    <section aria-labelledby={heading} className="mt-5">
      <h4 id={heading} className="text-muted text-xs font-semibold tracking-wider uppercase">
        {title}
      </h4>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="text-heading min-w-0 text-right break-words">{value}</dd>
          </div>
        ))}
      </dl>
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
