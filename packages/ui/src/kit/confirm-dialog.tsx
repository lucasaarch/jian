'use client';

import { type ReactNode, useEffect, useId, useState } from 'react';
import { Action } from './action';
import { Overlay, OverlayActions } from './overlay';

/**
 * Asks before something that cannot be taken back. With a `phrase` the action stays off until it
 * is typed as it is written, so what matters most is never done by a stray press or by habit.
 * Without one it is a plain question, for what is lost often enough that typing would be a chore:
 * focus starts on Cancel, so Enter alone keeps everything.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  phrase,
  action,
  run,
  busy = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** What will happen, and what will not. */
  children: ReactNode;
  /** What must be typed: the agent's name. */
  phrase?: string;
  /** What the button does, said on it: "Delete agent". */
  action: string;
  run: () => void;
  busy?: boolean;
}) {
  const [typed, setTyped] = useState('');
  const field = useId();
  const matches = phrase === undefined || typed.trim() === phrase.trim();

  // Each opening starts empty.
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  return (
    <Overlay open={open} onOpenChange={onOpenChange} title={title} size="form">
      <form
        className="grid w-full gap-5 p-7"
        onSubmit={(event) => {
          event.preventDefault();
          if (matches && !busy) run();
        }}
      >
        <header className="grid gap-1.5 pr-10">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          <div className="text-sm leading-relaxed text-muted">{children}</div>
        </header>
        {phrase !== undefined && (
          <div className="grid gap-1.5">
            <label htmlFor={field} className="text-[13px] text-muted">
              Type <strong className="font-semibold text-ink">{phrase}</strong> to confirm
            </label>
            <input
              id={field}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="h-10 rounded-xl border border-glass-edge bg-glass-hover px-3.5 py-0 text-sm text-ink outline-none transition-[border-color,background-color] focus:border-bad/50 focus:bg-glass-press"
            />
          </div>
        )}
        <OverlayActions>
          <Action tone="quiet" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Action>
          <Action
            tone="danger"
            type="submit"
            busy={busy}
            disabled={!matches}
            className="border border-bad/50 bg-bad-soft"
          >
            {action}
          </Action>
        </OverlayActions>
      </form>
    </Overlay>
  );
}
