import { RotateCw } from 'lucide-react'

import { ALERT, QUIET_BUTTON } from '../app/styles'

/** A read that failed: its message as an alert, and a way to read it again. */
export function Failure({
  message,
  onRetry,
}: {
  readonly message: string
  readonly onRetry: () => void
}) {
  return (
    <div className="mt-3">
      <p role="alert" className={ALERT}>
        {message}
      </p>
      <button type="button" className={`${QUIET_BUTTON} mt-3 -ml-3`} onClick={onRetry}>
        <RotateCw size={16} aria-hidden />
        Try again
      </button>
    </div>
  )
}
