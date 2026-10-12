import { fireEvent, render, screen } from '@testing-library/react'

import type { Geodetic } from '../geometry/projection'
import { CLICK_PX, HandleButton, type HandleButtonProps } from './HandleButton'

const PLACE: Geodetic = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }

/** The handle inside a container standing for the canvas's, where the camera's controls listen. */
function inContainer(overrides: Partial<HandleButtonProps> = {}) {
  const props = {
    label: 'Vertex 1',
    look: 'vertex',
    groundAt: vi.fn<HandleButtonProps['groundAt']>(() => PLACE),
    onGrab: vi.fn<() => void>(),
    onMove: vi.fn<(to: Geodetic) => void>(),
    onLetGo: vi.fn<(moved: boolean) => void>(),
    onKeyboardClick: vi.fn<() => void>(),
    ...overrides,
  } satisfies HandleButtonProps
  const container = vi.fn<(type: string) => void>()
  const { getByRole } = render(
    <div
      onPointerDown={() => {
        container('pointerdown')
      }}
      onPointerMove={() => {
        container('pointermove')
      }}
      onPointerUp={() => {
        container('pointerup')
      }}
      onClick={() => {
        container('click')
      }}
    >
      <HandleButton {...props} />
    </div>,
  )
  return { handle: getByRole('button', { name: 'Vertex 1' }), props, container }
}

describe("a handle's presses (FR-GEO-01)", () => {
  it('never reach the container: the camera does not orbit under a drag, nor a click place a vertex', () => {
    const { handle, container } = inContainer()
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 40, clientY: 10 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 40, clientY: 10 })
    fireEvent.click(handle, { detail: 1 })
    expect(container).not.toHaveBeenCalled()
  })

  it('drags once past a few pixels, following the ground under the pointer', () => {
    const { handle, props } = inContainer()
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
    expect(props.onGrab).toHaveBeenCalledOnce()
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 10 + CLICK_PX - 1, clientY: 10 })
    expect(props.onMove).not.toHaveBeenCalled()
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 30, clientY: 25 })
    expect(props.groundAt).toHaveBeenCalledWith(30, 25)
    expect(props.onMove).toHaveBeenCalledWith(PLACE)
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(props.onLetGo).toHaveBeenCalledWith(true)
  })

  it('tells a click from a drag, and lets go once', () => {
    const { handle, props } = inContainer()
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(handle, { pointerId: 1 })
    fireEvent.lostPointerCapture(handle, { pointerId: 1 })
    expect(props.onLetGo).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('holds still where the pointer leaves the ground, and ignores other buttons', () => {
    const { handle, props } = inContainer({ groundAt: vi.fn(() => null) })
    fireEvent.pointerDown(handle, { button: 2, pointerId: 1, clientX: 10, clientY: 10 })
    expect(props.onGrab).not.toHaveBeenCalled()
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300, clientY: 0 })
    expect(props.onMove).not.toHaveBeenCalled()
  })

  it("answers the keyboard's click, which presses no pointer", () => {
    const { handle, props } = inContainer()
    fireEvent.click(handle, { detail: 1 })
    expect(props.onKeyboardClick).not.toHaveBeenCalled()
    fireEvent.click(handle, { detail: 0 })
    expect(props.onKeyboardClick).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Vertex 1' })).toBeVisible()
  })
})
