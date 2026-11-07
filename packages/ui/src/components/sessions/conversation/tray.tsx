'use client';

import { onlineManager } from '@tanstack/react-query';
import { useState } from 'react';
import type { Run } from '../../../lib/api';
import { TroubleCard } from '../trouble';

/** What a turn that went wrong is called, and what is said when the gateway kept no reason. */
const troubles = {
  failed: 'Agent encountered an error',
  interrupted: 'The agent was interrupted',
  cancelled: 'The run was cancelled',
} as const;
const fallbacks = {
  failed: 'This run hit an unexpected error.',
  interrupted: 'It stopped before it finished.',
  cancelled: 'It stopped before it finished.',
} as const;

const troubleOf = (run: Run | undefined) =>
  run && Object.hasOwn(troubles, run.status) ? (run.status as keyof typeof troubles) : undefined;

/**
 * What sits just above the composer: errors, a conversation that may be out of date, a turn that
 * went wrong. It floats with the composer over the end of the conversation. The dots already say
 * the agent is working; a card speaks only when something went wrong.
 */
export function Tray({
  loading,
  error,
  behind,
  toolsUnread,
  run,
  deciding,
  onReload,
  onRetry,
  retryRun,
}: {
  loading: boolean;
  error: string;
  behind: boolean;
  toolsUnread: boolean;
  run?: Run;
  deciding: boolean;
  /** Reads the conversation again; `cover` shows it loading meanwhile. */
  onReload: (cover: boolean) => void;
  /** Runs a turn that failed again. */
  onRetry: (run: Run) => void;
  retryRun?: (run: Run) => Promise<unknown>;
}) {
  // The failed turn whose card the owner closed; a later one shows its own.
  const [dismissed, setDismissed] = useState<string>();
  const trouble = troubleOf(run);
  const retries = Boolean(retryRun) && run?.status !== 'cancelled';

  return (
    <div className="history-tray">
      {error && (
        <TroubleCard
          title="The conversation could not be loaded"
          detail={error}
          action="Try again"
          onAction={() => onReload(true)}
        />
      )}
      {!loading && !error && (toolsUnread || (behind && onlineManager.isOnline())) && (
        <TroubleCard
          title={behind ? 'This conversation may be out of date' : 'Some tools could not be read'}
          detail={
            behind
              ? 'The latest read failed, so what is shown may be missing what happened since.'
              : 'The tools could not be read, so some of what the agent did may be missing here.'
          }
          action="Try again"
          onAction={() => onReload(false)}
        />
      )}
      {run && trouble && run.id !== dismissed && (
        <TroubleCard
          title={troubles[trouble]}
          detail={`${run.error ?? fallbacks[trouble]}${
            retries ? ' Retry or send a follow-up below.' : ''
          }`}
          {...(retries ? { action: 'Retry', busy: deciding, onAction: () => onRetry(run) } : {})}
          onClose={() => setDismissed(run.id)}
        />
      )}
    </div>
  );
}
