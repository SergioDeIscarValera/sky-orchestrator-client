import type { ReactNode } from 'react'

import { PILL, PILL_TONE, type PillTone } from '../app/styles'

/** A status as a pill: its words, in the tone the state gives it. */
export function OperationPill({
  tone,
  children,
}: {
  readonly tone: PillTone
  readonly children: ReactNode
}) {
  return <span className={`${PILL} ${PILL_TONE[tone]}`}>{children}</span>
}
