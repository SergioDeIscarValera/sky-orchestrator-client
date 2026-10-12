import { useEffect } from 'react'

import { pressable, typing } from './editorKeys'
import { finished, undone, useWaylineDesigner } from './waylineDesigner'

/**
 * The designer's keys while a wayline is open: Enter finishes what is being drawn,
 * Ctrl or ⌘ Z undoes a step, Delete or Backspace takes back the last click of what is
 * being drawn. None of them while the user types in a field.
 */
export function useDesignerKeys(): void {
  const change = useWaylineDesigner((state) => state.change)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || typing(event.target)) return
      const command = event.ctrlKey || event.metaKey
      if (command && !event.shiftKey && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        change(undone)
      } else if (!command && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault()
        change((designing) => (designing.pending.length > 0 ? undone(designing) : designing))
      } else if (!command && event.key === 'Enter' && !pressable(event.target)) {
        event.preventDefault()
        change(finished)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [change])
}
