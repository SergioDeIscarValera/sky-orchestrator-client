import { useLink } from '../backend/context'

/**
 * Says the console's live topics are cut off while they are (NFR-REL-07), and nothing
 * otherwise. A live region throughout, so a screen reader hears the cut and the return.
 */
export function LinkPill() {
  const down = useLink() === 'down'
  return (
    <span
      role="status"
      className={
        down
          ? 'rounded-pill bg-danger-subtle text-danger-emphasis inline-flex h-6 items-center gap-1.5 px-2.5 text-xs font-medium'
          : 'sr-only'
      }
    >
      {down && (
        <>
          <span aria-hidden className="bg-danger size-1.5 rounded-full motion-safe:animate-pulse" />
          Reconnecting
        </>
      )}
    </span>
  )
}
