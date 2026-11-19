'use client';

import type { ArtifactFrameError } from '@jian/contracts';
import { CircleAlert, Copy, Wrench } from 'lucide-react';
import { useId, useState } from 'react';
import { Action, Fold, FoldChevron } from '../../../../kit';
import { copy } from '../source';
import { errorText } from './fix-request';

/** What failed, by type, as the card names it. */
const FAILED: Record<string, string> = {
  react: 'The component failed',
  mermaid: 'The diagram failed',
  markdown: 'The document failed',
};

/**
 * What went wrong as an Artifact ran, over it, as its frame said it (artifact-frame.tsx): the
 * error, and under Details which part of a component it broke in and where it was thrown. It is
 * the Artifact's own word, drawn as text. Copy error takes it all; Fix asks the agent to fix it,
 * once, and is held while the agent is changing the Artifact already. With nowhere to ask, as in
 * a conversation on a channel, there is no Fix.
 */
export function ArtifactFailure({
  type,
  error,
  busy,
  onFix,
}: {
  type: string;
  error: ArtifactFrameError;
  /** The agent is writing this Artifact now: a fix would race it. */
  busy: boolean;
  onFix?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [asked, setAsked] = useState(false);
  const details = useId();
  const more = Boolean(error.stack || error.componentStack);

  return (
    <div
      role="alert"
      className="mx-(--inspector-inset) mt-2 mb-1 grid shrink-0 gap-2 rounded-xl border border-bad/25 bg-bad-soft p-3 text-[13px]"
    >
      <div className="flex min-w-0 items-start gap-2">
        <CircleAlert size={15} aria-hidden="true" className="mt-px shrink-0 text-bad" />
        <div className="grid min-w-0 flex-1 gap-1">
          <p className="font-medium text-ink">{FAILED[type] ?? 'The Artifact failed'}</p>
          <p className="line-clamp-3 font-mono text-xs break-words text-muted select-text">
            {error.message}
          </p>
        </div>
      </div>
      {more && (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={details}
            onClick={() => setOpen(!open)}
            className="flex w-fit items-center gap-1 text-xs text-muted transition-colors hover:text-ink"
          >
            <FoldChevron open={open} />
            Details
          </button>
          <Fold open={open} id={details}>
            <pre className="max-h-48 overflow-auto rounded-lg bg-glass-press p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-muted select-text">
              {[
                error.componentStack && `In\n${error.componentStack}`,
                error.stack && `Stack\n${error.stack}`,
              ]
                .filter(Boolean)
                .join('\n\n')}
            </pre>
          </Fold>
        </>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Action tone="outline" size="small" onClick={() => void copy(errorText(error), 'Error')}>
          <Copy size={13} aria-hidden="true" />
          Copy error
        </Action>
        {onFix && (
          <Action
            tone="primary"
            size="small"
            disabled={busy || asked}
            onClick={() => {
              setAsked(true);
              onFix();
            }}
          >
            <Wrench size={13} aria-hidden="true" />
            {asked ? 'Asked to fix' : 'Fix'}
          </Action>
        )}
      </div>
    </div>
  );
}
