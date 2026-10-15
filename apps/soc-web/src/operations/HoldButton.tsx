import { useEffect, useRef, useState, type ReactNode } from 'react'

import { UNAVAILABLE } from '../app/styles'

/** How long a command is held before it is sent (FR-CMD-07): a press let go sooner sends nothing. */
export const HOLD_MS = 1500

/** The keys that hold a button down, as the browser names them (NFR-UX-04). */
const HOLD_KEYS: ReadonlySet<string> = new Set([' ', 'Enter'])

/** The tooltip of a button that may be held: what holding it does. */
const HOLD_TITLE = 'Hold to confirm'

const BASE = `${UNAVAILABLE} rounded-pill relative inline-flex h-9 items-center overflow-hidden px-4 text-sm font-semibold transition-colors duration-200 disabled:cursor-wait disabled:opacity-70`

const TONE = {
  neutral: 'border-border bg-surface text-heading border',
  danger: 'bg-danger-subtle text-danger-emphasis',
} as const

/**
 * A command's button: it sends once, and only after it has been held for HOLD_MS (FR-CMD-07). A press
 * let go sooner, a click, or a key let up sends nothing; the fill grows from the left while it is held.
 * Pointer or Space or Enter holds it. A reason withholds it: it stays focusable, its tooltip says why.
 */
export function HoldButton({
  children,
  onConfirm,
  reason = null,
  busy = false,
  tone = 'neutral',
}: {
  readonly children: ReactNode
  /** Called once for each hold that completes. */
  readonly onConfirm: () => void
  /** Why the button may not be held, as its tooltip; null when it may. */
  readonly reason?: string | null
  /** A command already being sent: the button waits for it, as the operation's moves do. */
  readonly busy?: boolean
  readonly tone?: keyof typeof TONE
}) {
  const [holding, setHolding] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Set once a hold has sent, and cleared when the hold is let go: one hold, one send.
  const sent = useRef(false)
  // The latest callback, and whether the button may be held, as the hold completes reads them.
  const current = useRef({ onConfirm, held: reason === null && !busy })

  useEffect(() => {
    current.current = { onConfirm, held: reason === null && !busy }
  })

  useEffect(() => {
    const pending = timer
    return () => {
      if (pending.current !== null) clearTimeout(pending.current)
    }
  }, [])

  const start = () => {
    if (timer.current !== null || sent.current || !current.current.held) return
    setHolding(true)
    timer.current = setTimeout(() => {
      timer.current = null
      if (!current.current.held) {
        setHolding(false)
        return
      }
      sent.current = true
      current.current.onConfirm()
    }, HOLD_MS)
  }

  const release = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    sent.current = false
    setHolding(false)
  }

  return (
    <button
      type="button"
      title={reason ?? HOLD_TITLE}
      aria-disabled={reason !== null}
      disabled={busy}
      data-holding={holding ? '' : undefined}
      className={`${BASE} ${TONE[tone]}`}
      onPointerDown={(event) => {
        if (event.button === 0) start()
      }}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
      onKeyDown={(event) => {
        if (HOLD_KEYS.has(event.key)) start()
      }}
      onKeyUp={(event) => {
        if (HOLD_KEYS.has(event.key)) release()
      }}
      onBlur={release}
    >
      <span
        aria-hidden
        className={`bg-danger/30 absolute inset-y-0 left-0 ${holding ? 'w-full transition-[width] ease-linear' : 'w-0 transition-none'}`}
        style={{ transitionDuration: `${String(HOLD_MS)}ms` }}
      />
      <span className="relative">{children}</span>
    </button>
  )
}
