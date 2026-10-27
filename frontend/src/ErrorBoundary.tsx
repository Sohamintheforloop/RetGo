import { Component, type ReactNode } from 'react'

/** If the app ever crashes while rendering, show what happened instead of leaving a blank page. */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div role="alert" className="mx-auto max-w-2xl p-6">
          <h1 className="text-xl font-bold">Something went wrong</h1>
          <p className="mt-2 text-sm">{this.state.error.message}</p>
          <p className="mt-2 text-sm text-muted">Press F12 and open the Console tab for details, then restart the app.</p>
        </div>
      )
    }
    return this.props.children
  }
}
