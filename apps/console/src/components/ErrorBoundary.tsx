import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time errors in the subtree so a single broken page
 * doesn't take down the whole shell. Without this, a thrown error in
 * any route blanks the entire console — sidebar, header, everything —
 * because React unmounts the tree at the nearest boundary, and there
 * isn't one above the route Outlet.
 *
 * Reset clears the error state so children re-mount cleanly. Pair with
 * a `key` on the child (e.g. location.pathname) to auto-reset on nav.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface to console — production source maps make this useful in
    // browser devtools. No remote sink yet (no Sentry); when one lands
    // this is the hook point.
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }
      return <DefaultFallback error={this.state.error} reset={this.reset} />;
    }
    return this.props.children;
  }
}

function DefaultFallback({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-6 text-center">
      <div className="text-fg-subtle text-xs font-mono mb-3 tracking-wider">
        [ ERR ]
      </div>
      <h2 className="font-display text-lg font-semibold mb-1">
        Something broke on this page
      </h2>
      <p className="text-sm text-fg-muted mb-6 max-w-md">
        {error.message || "An unexpected error occurred."}
      </p>
      <div className="flex gap-2">
        <button
          onClick={reset}
          className="px-4 py-2 text-sm rounded-md bg-brand text-brand-fg hover:bg-brand-hover transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
        >
          Try again
        </button>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 text-sm rounded-md border border-border text-fg hover:bg-bg-surface transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
        >
          Reload
        </button>
      </div>
    </div>
  );
}
