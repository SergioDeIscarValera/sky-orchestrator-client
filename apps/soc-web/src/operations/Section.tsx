import { useId, type ReactNode } from 'react'

/** One of the operation inspector's sections, titled as the definition's and the operators' are. */
export function Section({
  title,
  children,
}: {
  readonly title: string
  readonly children: ReactNode
}) {
  const heading = useId()
  return (
    <section aria-labelledby={heading} className="mt-5">
      <h4 id={heading} className="text-muted text-xs font-semibold tracking-wider uppercase">
        {title}
      </h4>
      {children}
    </section>
  )
}
