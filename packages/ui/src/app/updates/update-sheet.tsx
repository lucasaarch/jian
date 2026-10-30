'use client';

import { motion } from 'motion/react';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { Action, Overlay, Progress } from '../../kit';
import { useAppearance } from '../../lib/appearance';
import type { AppUpdate } from './app-update';
import { ReleaseDetails } from './release-details';
import { checked, headline, remaining, size } from './update-copy';
import { UpdateEmblem } from './update-emblem';

/**
 * The app's software update, as a sheet over the window: whether there is a release, its
 * download, "Restart to update" once it is ready, and what it brings. Closing it changes
 * nothing: a download goes on, and a ready release installs on quit.
 */
export function UpdateSheet({
  open,
  onOpenChange,
  update,
  onCheck,
  onInstall,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Unknown until the host first answers. */
  update: AppUpdate | undefined;
  onCheck: () => void;
  onInstall: () => void;
}) {
  const { still } = useAppearance();
  const { title, body } = headline(update);
  const release = update && 'release' in update ? update.release : undefined;
  const close = () => onOpenChange(false);
  return (
    <Overlay open={open} onOpenChange={onOpenChange} title="Software update" size="form">
      <Measured>
        <div className="grid gap-5 p-7">
          <header className="flex items-start gap-4 pr-6" aria-live="polite">
            <UpdateEmblem update={update} />
            <motion.div
              key={title}
              className="grid min-w-0 gap-1 pt-1"
              initial={still ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
            >
              <h2 className="text-lg font-semibold tracking-tight text-ink">{title}</h2>
              <p className="text-sm leading-relaxed text-muted">{body}</p>
              {update?.status === 'latest' && (
                <p className="text-xs text-muted/80">{checked(update.checkedAt)}</p>
              )}
            </motion.div>
          </header>
          {(update?.status === 'available' || update?.status === 'downloading') && (
            <Meter update={update} />
          )}
          {release && <ReleaseDetails release={release} />}
          {update?.status === 'failed' &&
            (update.failure === 'unknown' || update.failure === 'signature') &&
            update.detail && (
              <p className="rounded-xl bg-glass-hover px-3 py-2 font-mono text-[11px] leading-relaxed break-words text-muted">
                {update.detail}
              </p>
            )}
          <footer className="flex justify-end gap-2">
            <Actions update={update} close={close} onCheck={onCheck} onInstall={onInstall} />
          </footer>
        </div>
      </Measured>
    </Overlay>
  );
}

/** The download as it goes: the bar, how much of how much, and roughly how long is left. */
function Meter({
  update,
}: {
  update: Extract<AppUpdate, { status: 'available' | 'downloading' }>;
}) {
  const progress = update.status === 'downloading' ? update.progress : undefined;
  return (
    <div className="grid gap-2">
      <Progress
        {...(progress ? { value: progress.percent / 100 } : {})}
        label={`Downloading Jian ${update.release.version}`}
      />
      <div className="flex justify-between gap-3 text-xs text-muted tabular-nums">
        <span>
          {progress ? `${size(progress.transferred)} of ${size(progress.total)}` : 'Starting…'}
        </span>
        {progress && <span>{remaining(progress) ?? `${Math.floor(progress.percent)}%`}</span>}
      </div>
    </div>
  );
}

function Actions({
  update,
  close,
  onCheck,
  onInstall,
}: {
  update: AppUpdate | undefined;
  close: () => void;
  onCheck: () => void;
  onInstall: () => void;
}) {
  switch (update?.status) {
    case 'latest':
      return (
        <>
          <Action tone="quiet" onClick={onCheck}>
            Check again
          </Action>
          <Action tone="primary" onClick={close}>
            Done
          </Action>
        </>
      );
    case 'available':
    case 'downloading':
      return <Action onClick={close}>Hide</Action>;
    case 'ready':
      return (
        <>
          <Action tone="quiet" onClick={close}>
            Later
          </Action>
          <Action tone="primary" onClick={onInstall}>
            Restart to update
          </Action>
        </>
      );
    case 'manual': {
      const { url } = update.release;
      return (
        <>
          <Action tone="quiet" onClick={close}>
            Later
          </Action>
          <Action tone="primary" onClick={() => window.open(url, '_blank', 'noopener')}>
            Download
          </Action>
        </>
      );
    }
    case 'failed':
      return (
        <>
          <Action tone="quiet" onClick={close}>
            Close
          </Action>
          <Action tone="primary" onClick={onCheck}>
            Try again
          </Action>
        </>
      );
    case 'unavailable':
      return (
        <Action tone="primary" onClick={close}>
          Done
        </Action>
      );
    default:
      return (
        <Action tone="quiet" onClick={close}>
          Close
        </Action>
      );
  }
}

/**
 * Eases the sheet's height from one state to the next, so it grows and settles instead of
 * jumping; the overlay stays centred as it does.
 */
function Measured({ children }: { children: ReactNode }) {
  const { still } = useAppearance();
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | 'auto'>('auto');
  useLayoutEffect(() => {
    const node = inner.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setHeight(node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <motion.div
      className="w-full overflow-hidden"
      initial={false}
      animate={{ height }}
      transition={still ? { duration: 0 } : { type: 'spring', bounce: 0, duration: 0.35 }}
    >
      <div ref={inner}>{children}</div>
    </motion.div>
  );
}
