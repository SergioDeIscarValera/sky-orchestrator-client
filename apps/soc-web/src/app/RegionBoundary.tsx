import { Component, type ReactNode } from 'react'

import { ALERT } from './styles'

interface State {
  readonly failure: string | null
}

/**
 * A region of the shell that fails says so in its own place, and the other regions keep working
 * (FR-CMD-07). A parent that keys it by what it shows starts it again when that changes.
 */
export class RegionBoundary extends Component<
  {
    /** The region's name, as the failure says it: "The inspector stopped". */
    readonly name: string
    /** The box the failure sits in, for a region that is a place of its own. */
    readonly className?: string
    readonly children: ReactNode
  },
  State
> {
  override state: State = { failure: null }

  static getDerivedStateFromError(error: unknown): State {
    return { failure: error instanceof Error ? error.message : String(error) }
  }

  override render() {
    if (this.state.failure === null) return this.props.children
    return (
      <div className={this.props.className}>
        <p role="alert" className={ALERT}>
          The {this.props.name} stopped: {this.state.failure}. Reload the page to show it again.
        </p>
      </div>
    )
  }
}
