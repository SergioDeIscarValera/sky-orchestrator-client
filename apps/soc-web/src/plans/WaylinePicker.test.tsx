import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type SyntheticEvent } from 'react'

import type { Wayline } from '../backend/backend'
import { WaylinePicker } from './WaylinePicker'

/** A saved wayline by its row: row 1 has one waypoint, row 2 two, and so on round to nine. */
function wayline(row: number, name = `Row ${String(row).padStart(2, '0')}`): Wayline {
  return {
    id: `wayline-${String(row).padStart(2, '0')}`,
    name,
    takeoff: { latitudeDeg: 42.5, longitudeDeg: -4.7 },
    defaultHeightM: 30,
    design: {},
    waypoints: [],
    metrics: { waypointCount: ((row - 1) % 9) + 1, distanceM: 250 },
    bakeVersion: '1',
    createdAt: '2026-10-11T08:10:00Z',
    updatedAt: '2026-10-11T08:10:00Z',
  }
}

const FIFTY: readonly Wayline[] = Array.from({ length: 50 }, (_, index) => wayline(index + 1))

interface HarnessProps {
  readonly waylines: readonly Wayline[]
  readonly onChange: (chosen: readonly string[]) => void
}

/** The picker as the editor holds it: the chosen ids in state, each change also reported. */
function Harness({ waylines, onChange }: HarnessProps) {
  const [chosen, setChosen] = useState<readonly string[]>([])
  return (
    <WaylinePicker
      waylines={waylines}
      chosen={chosen}
      onChange={(next) => {
        setChosen(next)
        onChange(next)
      }}
    />
  )
}

function setup(waylines: readonly Wayline[] = FIFTY) {
  const onChange = vi.fn<(chosen: readonly string[]) => void>()
  const user = userEvent.setup({ delay: null })
  render(<Harness waylines={waylines} onChange={onChange} />)
  return { user, onChange }
}

const field = () => screen.getByRole('combobox', { name: 'Waylines' })

/** The names the open list shows, in its order. */
function options(): string[] {
  return screen
    .queryAllByRole('option')
    .map((option) => option.firstElementChild?.textContent ?? '')
}

/** The names of the chosen waylines, in the order they were chosen. */
function chosenNames(): string[] {
  const pills = screen.queryByRole('list', { name: 'Chosen waylines' })
  return Array.from(
    pills?.querySelectorAll('li') ?? [],
    (pill) => pill.firstElementChild?.textContent ?? '',
  )
}

describe('the waylines picker (FR-GEO-03)', () => {
  it('lists the waylines by name, each with its waypoint count in the muted colour', async () => {
    const { user } = setup()
    await user.click(field())
    expect(options()).toHaveLength(50)
    expect(options()[0]).toBe('Row 01')
    const first = screen.getByRole('option', { name: /^Row 01/ })
    expect(within(first).getByText('1 waypoint')).toHaveClass('text-muted')
    expect(
      within(screen.getByRole('option', { name: /^Row 07/ })).getByText('7 waypoints'),
    ).toHaveClass('text-muted')
  })

  it('narrows the list to the names typed, case aside', async () => {
    const { user } = setup()
    await user.type(field(), 'ROW 07')
    expect(options()).toEqual(['Row 07'])
    expect(screen.getByRole('status')).toHaveTextContent('1 found')
    await user.clear(field())
    await user.type(field(), 'nothing like it')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByRole('status')).toHaveTextContent('No waylines match')
  })

  it('finds a name whose accents the query leaves out', async () => {
    const { user } = setup([wayline(1, 'Peñas Altas'), wayline(2, 'Norte 1')])
    await user.type(field(), 'penas')
    expect(options()).toEqual(['Peñas Altas'])
  })

  it('adds a wayline on a click as a pill, and keeps the list open without it', async () => {
    const { user, onChange } = setup()
    await user.click(field())
    await user.click(screen.getByRole('option', { name: /^Row 02/ }))
    expect(onChange).toHaveBeenLastCalledWith(['wayline-02'])
    expect(chosenNames()).toEqual(['Row 02'])
    expect(screen.getByRole('button', { name: 'Remove Row 02' })).toBeInTheDocument()
    expect(options()).toHaveLength(49)
    expect(options()).not.toContain('Row 02')
  })

  it('calls back with the ids in the order they were chosen, by Enter and by a click', async () => {
    const { user, onChange } = setup()
    await user.click(field())
    await user.click(screen.getByRole('option', { name: /^Row 03/ }))
    await user.type(field(), 'row 01')
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenNthCalledWith(1, ['wayline-03'])
    expect(onChange).toHaveBeenNthCalledWith(2, ['wayline-03', 'wayline-01'])
    expect(chosenNames()).toEqual(['Row 03', 'Row 01'])
    expect(options()).not.toContain('Row 03')
    expect(options()).not.toContain('Row 01')
  })

  it('removes a chosen wayline with its pill, and gives the focus back to the field', async () => {
    const { user, onChange } = setup()
    await user.click(field())
    await user.click(screen.getByRole('option', { name: /^Row 01/ }))
    await user.click(screen.getByRole('option', { name: /^Row 02/ }))
    await user.click(screen.getByRole('option', { name: /^Row 03/ }))
    await user.click(screen.getByRole('button', { name: 'Remove Row 02' }))
    expect(onChange).toHaveBeenLastCalledWith(['wayline-01', 'wayline-03'])
    expect(chosenNames()).toEqual(['Row 01', 'Row 03'])
    expect(screen.queryByRole('button', { name: 'Remove Row 02' })).toBeNull()
    expect(field()).toHaveFocus()
    // The press on the button took the focus, and with it the open list; the field reopens it.
    await user.click(field())
    expect(options()).toContain('Row 02')
  })

  it('removes the last chosen wayline with Backspace from an empty field, and no other', async () => {
    const { user, onChange } = setup()
    await user.click(field())
    await user.click(screen.getByRole('option', { name: /^Row 01/ }))
    await user.click(screen.getByRole('option', { name: /^Row 02/ }))
    await user.type(field(), 'x')
    // The caret at the start of typed text: Backspace there deletes nothing, and takes no pill.
    await user.keyboard('{ArrowLeft}{Backspace}')
    expect(field()).toHaveValue('x')
    expect(chosenNames()).toEqual(['Row 01', 'Row 02'])
    expect(onChange).toHaveBeenCalledTimes(2)
    await user.keyboard('{ArrowRight}{Backspace}')
    expect(field()).toHaveValue('')
    expect(chosenNames()).toEqual(['Row 01', 'Row 02'])
    await user.keyboard('{Backspace}')
    expect(onChange).toHaveBeenLastCalledWith(['wayline-01'])
    expect(chosenNames()).toEqual(['Row 01'])
  })

  it('works from the keyboard alone: arrows open and move, Enter chooses, ArrowLeft reaches the pills', async () => {
    const { user, onChange } = setup()
    await user.tab()
    expect(field()).toHaveFocus()
    await user.keyboard('{ArrowDown}{Enter}')
    await user.keyboard('{Enter}')
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    expect(onChange).toHaveBeenLastCalledWith(['wayline-01', 'wayline-02', 'wayline-05'])
    expect(chosenNames()).toEqual(['Row 01', 'Row 02', 'Row 05'])
    await user.keyboard('{ArrowLeft}')
    const pills = within(screen.getByRole('list', { name: 'Chosen waylines' })).getAllByRole(
      'listitem',
    )
    expect(pills[2]).toHaveFocus()
    await user.keyboard('{Backspace}')
    expect(onChange).toHaveBeenLastCalledWith(['wayline-01', 'wayline-02'])
    expect(chosenNames()).toEqual(['Row 01', 'Row 02'])
  })

  it('is labelled for assistive technology, and its list is named for the same field', async () => {
    const { user } = setup()
    expect(field()).toHaveAccessibleName('Waylines')
    await user.click(field())
    expect(screen.getByRole('listbox', { name: 'Waylines' })).toBeInTheDocument()
  })

  it('is disabled, with nothing to choose, when the organization has no wayline', () => {
    setup([])
    expect(field()).toBeDisabled()
  })

  it('never submits the form around it: Enter with the list shut does nothing', async () => {
    const onChange = vi.fn<(chosen: readonly string[]) => void>()
    const submit = vi.fn((event: SyntheticEvent) => {
      event.preventDefault()
    })
    const user = userEvent.setup({ delay: null })
    render(
      <form onSubmit={submit}>
        <Harness waylines={FIFTY} onChange={onChange} />
        <button type="submit">Save</button>
      </form>,
    )
    await user.click(field())
    await user.keyboard('{Escape}')
    await user.keyboard('{Enter}')
    expect(submit).not.toHaveBeenCalled()
    await user.keyboard('{ArrowDown}{Enter}')
    expect(onChange).toHaveBeenLastCalledWith(['wayline-01'])
    expect(submit).not.toHaveBeenCalled()
  })
})
