import { useId, type ReactNode } from 'react'

import { Brand } from './Brand'
import { CARD } from './styles'

export function Centered({ children }: { readonly children: ReactNode }) {
  return <div className="bg-page grid min-h-dvh place-items-center p-4">{children}</div>
}

export function Card({
  title,
  children,
}: {
  readonly title: string
  readonly children: ReactNode
}) {
  const heading = useId()
  return (
    <Centered>
      <main aria-labelledby={heading} className={`${CARD} w-full max-w-md p-8`}>
        <Brand />
        <h1 id={heading} className="mt-6 text-xl font-semibold">
          {title}
        </h1>
        {children}
      </main>
    </Centered>
  )
}

export function Waiting({ label }: { readonly label: string }) {
  return (
    <Centered>
      <p role="status" className="text-muted flex items-center gap-3 text-sm">
        <span aria-hidden className="rounded-pill bg-primary size-2.5 motion-safe:animate-pulse" />
        {label}
      </p>
    </Centered>
  )
}
