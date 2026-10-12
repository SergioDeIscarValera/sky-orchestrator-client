import { useEffect } from 'react'

import { closed, deleted, undone, useGeofenceEditor } from './geofenceEditor'

/** Where a key is the user's text, not the editor's command. */
export function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

/** Where Enter presses what has the focus, a button or a link, rather than closing the ring. */
export function pressable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && ['BUTTON', 'A'].includes(target.tagName)
}

/**
 * The editor's keys while a geofence is open (FR-GEO-01): Ctrl or ⌘ Z undoes a step,
 * Delete or Backspace removes the chosen vertex (or, placing, the last one), and Enter
 * closes the ring. None of them while the user types in a field.
 */
export function useEditorKeys(): void {
  const change = useGeofenceEditor((state) => state.change)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || typing(event.target)) return
      const command = event.ctrlKey || event.metaKey
      if (command && !event.shiftKey && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        change(undone)
      } else if (!command && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault()
        change(deleted)
      } else if (!command && event.key === 'Enter' && !pressable(event.target)) {
        event.preventDefault()
        change(closed)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [change])
}
