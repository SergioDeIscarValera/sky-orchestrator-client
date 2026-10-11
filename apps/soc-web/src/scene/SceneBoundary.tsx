import { Component, type ReactNode } from 'react'

interface State {
  readonly failure: string | null
}

/** A scene that fails says so in its place; the panels keep working. */
export class SceneBoundary extends Component<{ readonly children: ReactNode }, State> {
  override state: State = { failure: null }

  static getDerivedStateFromError(error: unknown): State {
    return { failure: error instanceof Error ? error.message : String(error) }
  }

  override render() {
    if (this.state.failure === null) return this.props.children
    return (
      <SceneMessage>
        The scene stopped: {this.state.failure}. Reload the page to draw it again.
      </SceneMessage>
    )
  }
}

export function SceneMessage({ children }: { readonly children: ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-8">
      <p role="status" className="text-muted max-w-md text-center text-sm">
        {children}
      </p>
    </div>
  )
}
