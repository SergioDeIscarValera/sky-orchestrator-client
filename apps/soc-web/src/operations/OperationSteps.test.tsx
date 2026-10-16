import { render, screen, within } from '@testing-library/react'

import { OperationSteps } from './OperationSteps'

/** Each step as a screen reader hears it: its name and how it stands. */
function heard(): (string | null)[] {
  return within(screen.getByRole('list', { name: 'Steps' }))
    .getAllByRole('listitem')
    .map((step) => step.textContent)
}

describe("an operation's steps (FR-OPS-02)", () => {
  it('shows a draft on its plan, the rest to come, the current step marked as such', () => {
    render(<OperationSteps state="draft" />)
    expect(heard()).toEqual([
      '1Plan, current step',
      '2Prepare, to come',
      '3Simulate, to come',
      '4Launch, to come',
      '5Done, to come',
    ])
    const current = screen
      .getAllByRole('listitem')
      .filter((step) => step.getAttribute('aria-current') === 'step')
    expect(current.map((step) => step.textContent)).toEqual(['1Plan, current step'])
  })

  it('shows a flight in the air on its launch, in progress, with the steps before it done', () => {
    render(<OperationSteps state="in_flight" />)
    expect(heard()).toEqual([
      'Plan, done',
      'Prepare, done',
      'Simulate, done',
      '4Launch, in progress',
      '5Done, to come',
    ])
  })

  it('says how a closed operation ended', () => {
    const { rerender } = render(<OperationSteps state="completed" />)
    expect(heard().at(-1)).toBe('Done, completed')
    rerender(<OperationSteps state="aborted" />)
    expect(heard().at(-1)).toBe('Done, ended without completing')
  })
})
