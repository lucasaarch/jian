'use client';

import type { ArtifactFrameError } from '@jian/contracts';
import { CircleAlert, Copy, Wrench } from 'lucide-react';
import { useState } from 'react';
import { Action, HoverTip, Overlay, OverlayActions } from '../../../../kit';
import { useAppearance } from '../../../../lib/appearance';
import { copy } from '../source';
import { errorText } from './fix-request';

/** What failed, by type: the badge's word and the dialog's heading. */
const FAILED: Record<string, { short: string; long: string }> = {
  react: { short: 'Component error', long: 'The component failed' },
  mermaid: { short: 'Diagram error', long: 'The diagram failed' },
  diagram: { short: 'Diagram error', long: 'The diagram failed' },
  markdown: { short: 'Document error', long: 'The document failed' },
};
const UNKNOWN = { short: 'Error', long: 'The Artifact failed' };

/** A trace in the dialog: what scrolls sideways is the trace, never the pane. */
function Trace({ title, text }: { title: string; text: string }) {
  return (
    <section className="grid min-w-0 gap-2">
      <h3 className="text-xs font-medium text-muted">{title}</h3>
      <pre className="scroll-inset max-h-56 overflow-auto rounded-xl bg-glass-press p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre text-muted select-text">
        {text}
      </pre>
    </section>
  );
}

/**
 * What went wrong as an Artifact ran, as its frame said it (artifact-frame.tsx), the way a
 * development server flags one: a small badge in the Artifact's corner, which takes no room from
 * it, and on a click a dialog with the error whole: the message, which part of a component it
 * broke in, and where it was thrown. The frame says it nowhere else, so it is never told twice.
 *
 * It is the Artifact's own word, drawn as text. Copy error takes it all; Fix asks the agent to
 * fix it, once, and is held while the agent is changing the Artifact already. With nowhere to
 * ask, as in a conversation on a channel, there is no Fix.
 *
 * Mount it after the Artifact, in the column that holds it: it stands over its bottom corner.
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
  const { still } = useAppearance();
  const named = FAILED[type] ?? UNKNOWN;

  return (
    <>
      {/* No height of its own: the badge stands over the corner of what is above it. */}
      <div className="relative h-0 shrink-0">
        <p role="status" className="sr-only">
          {`${named.long}: ${error.message}`}
        </p>
        <div className="absolute bottom-3 left-3 z-10">
          <HoverTip tip={error.message} hoverOnly wide>
            <button
              type="button"
              aria-haspopup="dialog"
              onClick={() => setOpen(true)}
              className="glass flex h-8 items-center gap-2 rounded-full pr-3.5 pl-3 text-[13px] font-medium text-ink shadow-lg transition-colors hover:bg-glass-hover"
            >
              <span className="relative flex size-2" aria-hidden="true">
                {!still && !asked && (
                  <span className="absolute inset-0 animate-ping rounded-full bg-bad opacity-60" />
                )}
                <span className="relative size-2 rounded-full bg-bad" />
              </span>
              {asked ? 'Fix asked' : named.short}
            </button>
          </HoverTip>
        </div>
      </div>
      <Overlay open={open} onOpenChange={setOpen} title={named.long} size="page">
        <div className="grid w-full grid-cols-1 gap-5 p-7">
          <header className="grid gap-2 pr-10">
            <p className="flex items-center gap-1.5 text-xs font-medium text-bad">
              <CircleAlert size={14} aria-hidden="true" />
              {named.long}
            </p>
            <h2 className="font-mono text-[15px] leading-snug font-medium break-words text-ink select-text">
              {error.message}
            </h2>
          </header>
          {error.componentStack && <Trace title="Where it broke" text={error.componentStack} />}
          {error.stack && <Trace title="Stack" text={error.stack} />}
          {busy && <p className="text-xs text-muted">The agent is changing it now.</p>}
          <OverlayActions>
            <Action tone="outline" onClick={() => void copy(errorText(error), 'Error')}>
              <Copy size={14} aria-hidden="true" />
              Copy error
            </Action>
            {onFix && (
              <Action
                tone="primary"
                disabled={busy || asked}
                onClick={() => {
                  setAsked(true);
                  setOpen(false);
                  onFix();
                }}
              >
                <Wrench size={14} aria-hidden="true" />
                {asked ? 'Asked to fix' : 'Fix'}
              </Action>
            )}
          </OverlayActions>
        </div>
      </Overlay>
    </>
  );
}
