import { useRef, type KeyboardEvent } from 'react'

import type { Geodetic } from '../geometry/projection'

/** A press that moves less than this is a click, not a drag. */
export const CLICK_PX = 4

/** Where on the Earth the pointer at (clientX, clientY) meets the ground, or null. */
export type GroundAt = (clientX: number, clientY: number) => Geodetic | null

/** The dot each handle shows; the button round it is larger, an easy target (WCAG 2.5.8). */
const LOOKS = {
  vertex: 'size-3.5 border-2 border-primary bg-surface',
  chosen: 'size-4 border-2 border-surface bg-primary',
  middle: 'size-2.5 border border-primary bg-surface opacity-80 group-hover:opacity-100',
} as const

export interface HandleButtonProps {
  readonly label: string
  readonly look: keyof typeof LOOKS
  readonly groundAt: GroundAt
  readonly onGrab: () => void
  readonly onMove: (to: Geodetic) => void
  /** The press is over: `moved` false for a click. */
  readonly onLetGo: (moved: boolean) => void
  readonly onFocus?: () => void
  readonly onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void
  /** Enter or Space on the handle, which presses no pointer. */
  readonly onKeyboardClick?: () => void
}

/**
 * A handle over the scene, a button on the page: it keeps the pointer while dragged and
 * takes the keyboard's focus. Its presses stop at it: the camera's controls and the
 * scene's own clicks listen on the canvas's container, which the handle sits in, and
 * would otherwise orbit under a drag, or place a vertex where a vertex was chosen.
 */
export function HandleButton({
  label,
  look,
  groundAt,
  onGrab,
  onMove,
  onLetGo,
  onFocus,
  onKeyDown,
  onKeyboardClick,
}: HandleButtonProps) {
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const letGo = () => {
    const pressed = press.current
    if (pressed === null) return
    press.current = null
    onLetGo(pressed.moved)
  }
  return (
    <button
      type="button"
      aria-label={label}
      className="group focus-visible:outline-primary grid size-6 cursor-grab touch-none place-items-center rounded-full focus-visible:outline-2 active:cursor-grabbing"
      onPointerDown={(event) => {
        event.stopPropagation()
        if (event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        press.current = { x: event.clientX, y: event.clientY, moved: false }
        onGrab()
      }}
      onPointerMove={(event) => {
        event.stopPropagation()
        const pressed = press.current
        if (pressed === null) return
        const distance = Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y)
        if (!pressed.moved && distance < CLICK_PX) return
        pressed.moved = true
        const to = groundAt(event.clientX, event.clientY)
        if (to !== null) onMove(to)
      }}
      onPointerUp={(event) => {
        event.stopPropagation()
        letGo()
      }}
      onLostPointerCapture={letGo}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        event.stopPropagation()
        // A pointer's click was the press; only the keyboard's comes with no detail.
        if (event.detail === 0) onKeyboardClick?.()
      }}
    >
      <span className={`${LOOKS[look]} shadow-card block rounded-full`} />
    </button>
  )
}
