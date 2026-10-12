import { fireEvent, render } from '@testing-library/react'

import { geodeticAt, type Geodetic } from '../geometry/projection'
import { useEditorKeys } from './editorKeys'
import { closed, placed, useGeofenceEditor } from './geofenceEditor'

const FARM: Geodetic = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
const at = (east: number, north: number) => geodeticAt(FARM, { eastM: east, northM: north })

function Keys() {
  useEditorKeys()
  return (
    <div>
      <input aria-label="Name" />
      <button type="button">Save</button>
    </div>
  )
}

const editing = () => useGeofenceEditor.getState().editing
const vertices = () => editing()?.drawing.vertices.length

/** A new geofence with three vertices placed, still placing. */
function threePlaced() {
  const { start, change } = useGeofenceEditor.getState()
  start(null)
  for (const [east, north] of [
    [0, 0],
    [100, 0],
    [100, 100],
  ] as const) {
    change((current) => placed(current, at(east, north)))
  }
}

afterEach(() => {
  useGeofenceEditor.getState().stop()
})

describe("the geofence editor's keys (FR-GEO-01)", () => {
  it('closes the ring with Enter, undoes with Ctrl Z or ⌘ Z, removes with Delete', () => {
    render(<Keys />)
    threePlaced()
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(editing()?.phase).toBe('shaping')
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    expect(editing()?.phase).toBe('placing')
    fireEvent.keyDown(document.body, { key: 'Z', metaKey: true })
    expect(vertices()).toBe(2)
    fireEvent.keyDown(document.body, { key: 'Backspace' })
    expect(vertices()).toBe(1)
    fireEvent.keyDown(document.body, { key: 'Delete' })
    expect(vertices()).toBe(0)
  })

  it('leaves the keys to a field being typed in, and Enter to a focused button', () => {
    const { getByRole } = render(<Keys />)
    threePlaced()
    fireEvent.keyDown(getByRole('textbox', { name: 'Name' }), { key: 'Backspace' })
    fireEvent.keyDown(getByRole('textbox', { name: 'Name' }), { key: 'z', ctrlKey: true })
    expect(vertices()).toBe(3)
    fireEvent.keyDown(getByRole('button', { name: 'Save' }), { key: 'Enter' })
    expect(editing()?.phase).toBe('placing')
    useGeofenceEditor.getState().change(closed)
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true, shiftKey: true })
    expect(editing()?.phase).toBe('shaping')
  })

  it('does nothing once unmounted, or with no geofence open', () => {
    const { unmount } = render(<Keys />)
    fireEvent.keyDown(document.body, { key: 'Delete' })
    expect(editing()).toBeNull()
    threePlaced()
    unmount()
    fireEvent.keyDown(document.body, { key: 'Delete' })
    expect(vertices()).toBe(3)
  })
})
