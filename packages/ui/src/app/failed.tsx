'use client';

import { QueryErrorResetBoundary } from '@tanstack/react-query';
import { Component, type ReactNode } from 'react';
import { Action } from '../kit';

type Props = { retry: () => void; children: ReactNode };

/** Catches what a screen could not read; React offers this only as a class. */
class Boundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="grid h-full place-items-center px-6" role="alert">
        <section className="grid max-w-sm justify-items-center gap-3 text-center">
          <h1 className="font-sans text-base font-semibold tracking-tight">
            This could not be read
          </h1>
          <p className="text-sm">The gateway did not answer, or answered with an error.</p>
          <Action
            tone="outline"
            size="small"
            onClick={() => {
              this.props.retry();
              this.setState({ failed: false });
            }}
          >
            Try again
          </Action>
        </section>
      </main>
    );
  }
}

/**
 * What a screen shows when a slice it reads could not be read. Trying again clears the failed
 * queries first, so the screen asks the gateway again instead of rendering the same error.
 */
export function ReadFailed({ children }: { children: ReactNode }) {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => <Boundary retry={reset}>{children}</Boundary>}
    </QueryErrorResetBoundary>
  );
}
