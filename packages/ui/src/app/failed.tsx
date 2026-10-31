'use client';

import { onlineManager, QueryErrorResetBoundary } from '@tanstack/react-query';
import { CloudOff } from 'lucide-react';
import { Component, type ReactNode } from 'react';
import { Action } from '../kit';
import { GatewayAnswer } from '../lib/api/result';
import { reloadApp } from './reload';

type Props = { retry: () => void; children: ReactNode };

/** A request that never came back, as a browser words it. A bug is a TypeError too. */
const UNANSWERED = /fetch|network|load failed/i;

/**
 * Whether the gateway had anything to do with it. Blaming it for a bug on this side sends the
 * owner off restarting something that works, and it changes nothing.
 */
const fromGateway = (error: unknown) =>
  error instanceof GatewayAnswer || (error instanceof TypeError && UNANSWERED.test(error.message));

/** Said by a host when new code has just been loaded in place, as in development. */
export const CODE_RELOADED = 'jian:code-reloaded';

/** Catches what a screen could not read; React offers this only as a class. */
class Boundary extends Component<Props, { failed: boolean; reason?: string; gateway?: boolean }> {
  state: { failed: boolean; reason?: string; gateway?: boolean } = { failed: false };
  private stop?: () => void;

  static getDerivedStateFromError(error: unknown) {
    return {
      failed: true,
      gateway: fromGateway(error),
      reason: error instanceof Error ? error.message : undefined,
    };
  }

  /** Trying again by hand, without the owner having to ask. A failure that stands comes back. */
  private recover = () => {
    if (!this.state.failed) return;
    this.props.retry();
    this.setState({ failed: false, reason: undefined, gateway: undefined });
  };

  componentDidMount() {
    // The gateway answers again, as after it restarted, or the code that failed was replaced.
    const stopOnline = onlineManager.subscribe((online) => {
      if (online) this.recover();
    });
    window.addEventListener(CODE_RELOADED, this.recover);
    this.stop = () => {
      stopOnline();
      window.removeEventListener(CODE_RELOADED, this.recover);
    };
  }

  componentWillUnmount() {
    this.stop?.();
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
              {this.state.gateway ? 'This could not be read' : 'Something went wrong here'}
            </h1>
            <p className="text-sm leading-relaxed text-muted text-balance">
              {this.state.gateway
                ? 'The gateway did not answer, or answered with an error.'
                : 'This is a problem in the app, not in your gateway.'}{' '}
              Nothing was lost: your conversations are where you left them.
            </p>
            {this.state.reason && (
              <p className="mx-auto mt-1 max-w-full truncate rounded-lg bg-glass-hover px-2.5 py-1 font-mono text-xs text-muted">
                {this.state.reason}
              </p>
            )}
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Action onClick={this.recover}>Try again</Action>
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
