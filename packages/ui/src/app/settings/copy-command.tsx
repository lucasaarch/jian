'use client';

import { Check, Copy } from 'lucide-react';
import { Action } from '../../kit';
import { useCopy } from '../../lib/copy';

/**
 * Text to take elsewhere — a command to run, a public key to paste — in a mono block under its
 * row, with a small action that copies it. It wraps rather than scrolls, so all of it is seen
 * before it is run. A refused clipboard asks for it to be copied by hand; the text is selectable.
 */
export function CopyCommand({ value, label }: { value: string; label: string }) {
  const { copied, failed, copy } = useCopy();

  return (
    <div className="grid gap-1.5">
      <div className="flex items-start gap-2 rounded-lg bg-ink/5 py-1.5 pr-1.5 pl-3">
        <code className="min-w-0 flex-1 py-1 font-mono text-[12px] leading-relaxed break-all text-ink select-all">
          {value}
        </code>
        <Action tone="quiet" size="small" aria-label={label} onClick={() => void copy('', value)}>
          {copied === undefined ? <Copy size={13} /> : <Check size={13} />}
          {copied === undefined ? 'Copy' : 'Copied'}
        </Action>
      </div>
      {failed !== undefined && (
        <p role="alert" className="px-1 text-xs text-bad">
          Select the text and copy it by hand.
        </p>
      )}
    </div>
  );
}
