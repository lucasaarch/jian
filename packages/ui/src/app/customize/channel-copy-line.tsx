'use client';

import { Check, Copy } from 'lucide-react';
import { Action } from '../../kit';
import { useCopy } from '../../lib/copy';

/** The box a dialog lists its entries in, one line each. */
export const listBox =
  'divide-y divide-glass-edge rounded-xl border border-glass-edge bg-glass-hover';

/**
 * A value to take elsewhere — an address, a token — as a line of a list box: its name and a
 * Copy. Nobody reads a token, so a `secret` is never drawn; an address is, faintly, to be
 * recognised. A refused clipboard shows the value, selectable, to be copied by hand.
 */
export function CopyLine({
  label,
  value,
  secret = false,
}: {
  label: string;
  value: string;
  secret?: boolean;
}) {
  const { copied, failed, copy } = useCopy();

  return (
    <div className="grid gap-1.5 px-3.5 py-2.5">
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-[13px] text-ink">{label}</span>
        <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-muted">
          {secret ? '' : value}
        </span>
        <Action
          tone="outline"
          size="small"
          aria-label={`Copy ${label}`}
          onClick={() => void copy(label, value)}
        >
          {copied === label ? <Check size={13} /> : <Copy size={13} />}
          {copied === label ? 'Copied' : 'Copy'}
        </Action>
      </div>
      {failed === label && (
        <p role="alert" className="grid gap-1 text-xs text-bad">
          The clipboard was refused; copy it by hand.
          <code className="font-mono text-[11px] break-all text-ink select-all">{value}</code>
        </p>
      )}
    </div>
  );
}
