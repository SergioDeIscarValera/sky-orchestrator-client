import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'

import { HOLD_MS, HoldButton } from './HoldButton'

type Props = ComponentProps<typeof HoldButton>

/** Renders a hold button named Pause, with its confirmation counted. */
function renderHold(props: Partial<Props> = {}) {
  const onConfirm = vi.fn<() => void>()
  const view = render(
    <HoldButton onConfirm={onConfirm} {...props}>
      Pause
    </HoldButton>,
  )
  return { ...view, onConfirm, button: screen.getByRole('button', { name: 'Pause' }) }
}

/** Lets the clock run on, as the page would while the button is held. */
function elapse(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

/** The fill that grows across the button while it is held: the one hidden from assistive technology. */
function fillOf(button: HTMLElement) {
  const fill = button.querySelector('[aria-hidden]')
  if (fill === null) throw new Error('the hold button has no fill')
  return fill
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a command held to confirm (FR-CMD-07)', () => {
  it('is named by its words, and its tooltip says it is held to confirm', () => {
    const { button } = renderHold()
    expect(button).toHaveAttribute('title', 'Hold to confirm')
    expect(button).toHaveAccessibleDescription('Hold to confirm')
    expect(button).toHaveAttribute('aria-disabled', 'false')
    expect(button).toBeEnabled()
  })

  it('sends once when held for the whole hold, and not a moment before', () => {
    const { button, onConfirm } = renderHold()
    fireEvent.pointerDown(button, { button: 0 })
    elapse(HOLD_MS - 1)
    expect(onConfirm).not.toHaveBeenCalled()
    elapse(1)
    expect(onConfirm).toHaveBeenCalledOnce()
    fireEvent.pointerUp(button, { button: 0 })
    elapse(HOLD_MS * 4)
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('sends nothing when the press is let go before the hold completes', () => {
    const { button, onConfirm } = renderHold()
    fireEvent.pointerDown(button, { button: 0 })
    elapse(HOLD_MS - 300)
    fireEvent.pointerUp(button, { button: 0 })
    elapse(HOLD_MS * 2)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('sends nothing when the pointer leaves the button while it is held', () => {
    const { button, onConfirm } = renderHold()
    fireEvent.pointerDown(button, { button: 0 })
    elapse(HOLD_MS - 300)
    fireEvent.pointerLeave(button)
    elapse(HOLD_MS * 2)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('never sends on a click, however long the clock runs after it', () => {
    const { button, onConfirm } = renderHold()
    // The events a mouse click dispatches, in order: the press, the release, then the click.
    fireEvent.pointerDown(button, { button: 0 })
    fireEvent.mouseDown(button, { button: 0 })
    fireEvent.pointerUp(button, { button: 0 })
    fireEvent.mouseUp(button, { button: 0 })
    fireEvent.click(button, { button: 0 })
    elapse(HOLD_MS * 2)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('sends once per hold, however long the press is kept down, and again on the next hold', () => {
    const { button, onConfirm } = renderHold()
    fireEvent.pointerDown(button, { button: 0 })
    elapse(HOLD_MS)
    elapse(HOLD_MS * 5)
    expect(onConfirm).toHaveBeenCalledOnce()
    fireEvent.pointerUp(button, { button: 0 })
    fireEvent.pointerDown(button, { button: 0 })
    elapse(HOLD_MS)
    expect(onConfirm).toHaveBeenCalledTimes(2)
  })

  it('fills from the left while it is held, and empties when it is let go', () => {
    const { button } = renderHold()
    expect(button).not.toHaveAttribute('data-holding')
    expect(fillOf(button)).toHaveClass('w-0')
    fireEvent.pointerDown(button, { button: 0 })
    expect(button).toHaveAttribute('data-holding')
    expect(fillOf(button)).toHaveClass('w-full')
    expect(fillOf(button)).toHaveStyle({ transitionDuration: `${String(HOLD_MS)}ms` })
    fireEvent.pointerUp(button, { button: 0 })
    expect(button).not.toHaveAttribute('data-holding')
    expect(fillOf(button)).toHaveClass('w-0')
  })

  it('is held from the keyboard with Space, sends once, and cancels when Space is let up early', () => {
    const { button, onConfirm } = renderHold()
    button.focus()
    fireEvent.keyDown(button, { key: ' ' })
    elapse(HOLD_MS / 2)
    fireEvent.keyUp(button, { key: ' ' })
    elapse(HOLD_MS * 2)
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.keyDown(button, { key: ' ' })
    elapse(HOLD_MS)
    fireEvent.keyDown(button, { key: ' ', repeat: true })
    elapse(HOLD_MS * 3)
    fireEvent.keyUp(button, { key: ' ' })
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('is held from the keyboard with Enter the same way', () => {
    const { button, onConfirm } = renderHold()
    button.focus()
    fireEvent.keyDown(button, { key: 'Enter' })
    elapse(HOLD_MS - 1)
    fireEvent.keyUp(button, { key: 'Enter' })
    elapse(HOLD_MS)
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.keyDown(button, { key: 'Enter' })
    elapse(HOLD_MS)
    fireEvent.keyUp(button, { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('ignores every other key, and a press with a button other than the primary one', () => {
    const { button, onConfirm } = renderHold()
    fireEvent.keyDown(button, { key: 'a' })
    fireEvent.pointerDown(button, { button: 2 })
    elapse(HOLD_MS * 2)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('is withheld with its reason as the tooltip, and no hold sends', () => {
    const { button, onConfirm } = renderHold({ reason: 'Pilots only' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('title', 'Pilots only')
    expect(button).toHaveAccessibleDescription('Pilots only')
    expect(button).toBeEnabled()
    fireEvent.pointerDown(button, { button: 0 })
    elapse(HOLD_MS * 2)
    fireEvent.keyDown(button, { key: 'Enter' })
    elapse(HOLD_MS * 2)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(button).not.toHaveAttribute('data-holding')
  })

  it('is busy while its command is sent: disabled, and no hold sends', () => {
    const { button, onConfirm } = renderHold({ busy: true })
    expect(button).toBeDisabled()
    fireEvent.pointerDown(button, { button: 0 })
    elapse(HOLD_MS * 2)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('sends nothing when it is withheld while it is being held', () => {
    const { button, onConfirm, rerender } = renderHold()
    fireEvent.pointerDown(button, { button: 0 })
    elapse(HOLD_MS / 2)
    rerender(
      <HoldButton onConfirm={onConfirm} reason="Pilots only">
        Pause
      </HoldButton>,
    )
    elapse(HOLD_MS * 2)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(fillOf(button)).toHaveClass('w-0')
  })

  it('calls the latest confirmation, the one the page gives when the hold completes', () => {
    const first = vi.fn<() => void>()
    const latest = vi.fn<() => void>()
    const { button, rerender } = renderHold({ onConfirm: first })
    fireEvent.pointerDown(button, { button: 0 })
    rerender(<HoldButton onConfirm={latest}>Pause</HoldButton>)
    elapse(HOLD_MS)
    expect(first).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledOnce()
  })

  it('forgets a hold whose button leaves the page before it completes', () => {
    const { button, onConfirm, unmount } = renderHold()
    fireEvent.pointerDown(button, { button: 0 })
    unmount()
    elapse(HOLD_MS * 2)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
