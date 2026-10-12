import { fireEvent, render } from '@testing-library/react'

import { geodeticAt, type Geodetic } from '../geometry/projection'
import { useDesignerKeys } from './designerKeys'
import {
  clicked,
  handleChosen,
  startedDesign,
  toolChosen,
  useWaylineDesigner,
} from './waylineDesigner'

const FARM: Geodetic = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
const at = (east: number, north: number) => geodeticAt(FARM, { eastM: east, northM: north })

function Keys() {
  useDesignerKeys()
  return (
    <div>
      <input aria-label="Name" />
      <button type="button">Save</button>
    </div>
  )
}

const designing = () => useWaylineDesigner.getState().designing

/** A route of three clicks, still being drawn. */
function routing() {
  const { begin, change } = useWaylineDesigner.getState()
  begin(toolChosen(startedDesign(), 'route'))
  for (const [east, north] of [
    [0, 10],
    [0, 50],
    [40, 50],
  ] as const) {
    change((current) => clicked(current, at(east, north)))
  }
}

afterEach(() => {
  useWaylineDesigner.getState().stop()
})

describe("the designer's keys (FR-WAY-02)", () => {
  it('takes back a click with Delete, finishes with Enter, undoes with Ctrl Z', () => {
    render(<Keys />)
    routing()
    fireEvent.keyDown(document.body, { key: 'Backspace' })
    expect(designing()?.pending).toHaveLength(2)
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(designing()?.sketch.primitives).toHaveLength(1)
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true })
    expect(designing()?.sketch.primitives).toHaveLength(0)
  })

  it('deletes the chosen point of the primitive open, then the primitive itself', () => {
    render(<Keys />)
    routing()
    fireEvent.keyDown(document.body, { key: 'Enter' })
    // The route just finished is open, no point chosen: Delete would take it whole.
    const { change } = useWaylineDesigner.getState()
    change((current) => handleChosen(current, { kind: 'point', index: 1 }))
    fireEvent.keyDown(document.body, { key: 'Delete' })
    const [route] = designing()?.sketch.primitives ?? []
    expect(route?.kind === 'route' ? route.points : []).toEqual([at(0, 10), at(40, 50)])
    fireEvent.keyDown(document.body, { key: 'Delete' })
    expect(designing()?.sketch.primitives).toEqual([])
    expect(designing()?.selected).toBeNull()
  })

  it('leaves the keys to a field, and Enter to a focused button', () => {
    const { getByRole } = render(<Keys />)
    routing()
    fireEvent.keyDown(getByRole('textbox', { name: 'Name' }), { key: 'Backspace' })
    expect(designing()?.pending).toHaveLength(3)
    fireEvent.keyDown(getByRole('textbox', { name: 'Name' }), { key: 'Enter' })
    expect(designing()?.pending).toHaveLength(3)
    fireEvent.keyDown(getByRole('button', { name: 'Save' }), { key: 'Enter' })
    expect(designing()?.sketch.primitives).toHaveLength(0)
  })
})
