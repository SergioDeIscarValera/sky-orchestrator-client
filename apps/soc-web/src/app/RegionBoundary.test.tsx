import { render, screen } from '@testing-library/react'

import { RegionBoundary } from './RegionBoundary'

/** A part of a region that throws while it is broken, as a panel does when its data is wrong. */
function Part({ broken }: { readonly broken: boolean }) {
  if (broken) throw new Error('the panel broke')
  return <p>The panel works</p>
}

beforeEach(() => {
  // React reports every error a boundary catches to the console: the tests expect those.
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a region of the shell that fails (FR-CMD-07)', () => {
  it('says where it stopped and why, in its own place, and leaves its neighbours working', () => {
    render(
      <>
        <RegionBoundary name="inspector" className="place">
          <Part broken />
        </RegionBoundary>
        <p>The safety controls work</p>
      </>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The inspector stopped: the panel broke. Reload the page to show it again.',
    )
    expect(screen.getByRole('alert').parentElement).toHaveClass('place')
    expect(screen.getByText('The safety controls work')).toBeVisible()
  })

  it('shows what it holds while nothing fails', () => {
    render(
      <RegionBoundary name="inspector">
        <Part broken={false} />
      </RegionBoundary>,
    )
    expect(screen.getByText('The panel works')).toBeVisible()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('starts again when the parent keys it by a new thing to show', () => {
    const { rerender } = render(
      <RegionBoundary key="first" name="panel">
        <Part broken />
      </RegionBoundary>,
    )
    expect(screen.getByRole('alert')).toBeVisible()
    rerender(
      <RegionBoundary key="second" name="panel">
        <Part broken={false} />
      </RegionBoundary>,
    )
    expect(screen.getByText('The panel works')).toBeVisible()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
