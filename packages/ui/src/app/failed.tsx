'use client';

import { QueryErrorResetBoundary } from '@tanstack/react-query';
import { CloudOff } from 'lucide-react';
import { Component, type ReactNode } from 'react';
import { Action } from '../kit';
import { reloadApp } from './reload';

type Props = { retry: () => void; children: ReactNode };

/** Catches what a screen could not read; React offers this only as a class. */
class Boundary extends Component<Props, { failed: boolean; reason?: string }> {
  state: { failed: boolean; reason?: string } = { failed: false };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, reason: error instanceof Error ? error.message : undefined };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      // It stands in for the whole panel, inside a row: it has to claim the width itself.
      <main className="grid h-full w-full min-w-0 flex-1 place-items-center px-6" role="alert">
        <section className="grid w-full max-w-md justify-items-center gap-5 text-center">
          <span className="glass grid size-14 place-items-center rounded-2xl text-muted">
            <CloudOff size={22} strokeWidth={1.6} aria-hidden="true" />
          </span>
          <div className="grid gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-ink">
              This could not be read
            </h1>
            <p className="text-sm leading-relaxed text-muted text-balance">
              The gateway did not answer, or answered with an error. Nothing was lost: your
              conversations are where you left them.
            </p>
            {this.state.reason && (
              <p className="mx-auto mt-1 max-w-full truncate rounded-lg bg-glass-hover px-2.5 py-1 font-mono text-xs text-muted">
                {this.state.reason}
              </p>
            )}
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Action
              onClick={() => {
                this.props.retry();
                this.setState({ failed: false, reason: undefined });
              }}
            >
              Try again
            </Action>
            <Action tone="quiet" onClick={reloadApp}>
              Reload the app
            </Action>
          </div>
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
