'use client';

import { X } from 'lucide-react';
import { Action } from '../../kit';

/**
 * Something that went wrong, said once above the composer: what happened, what the gateway knows
 * about it, and the way on. Closing it only hides it here; nothing about the run changes.
 */
export function TroubleCard({
  title,
  detail,
  action,
  busy = false,
  onAction,
  onClose,
}: {
  title: string;
  detail: string;
  /** The button's word, when there is something to try. */
  action?: string;
  busy?: boolean;
  onAction?: () => void;
  onClose?: () => void;
}) {
  return (
    <section className="trouble-card" role="status" aria-label={title}>
      <div className="trouble-text">
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
      {onClose && (
        <button type="button" className="trouble-close" aria-label="Dismiss" onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </button>
      )}
      {action && onAction && (
        <Action tone="glass" className="trouble-action" busy={busy} onClick={onAction}>
          {action}
        </Action>
      )}
    </section>
  );
}
