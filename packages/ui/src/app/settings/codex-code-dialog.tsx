'use client';

import { Check, Copy, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { Spinner } from '../../components/ui';
import { Action, Overlay } from '../../kit';

/**
 * The code the owner types on the OpenAI page, while the gateway waits for them to. It closes
 * by itself once ChatGPT connects; closing it sooner leaves the sign-in waiting.
 */
export function CodexCodeDialog({
  verificationUrl,
  userCode,
  copied: copiedAtStart,
  close,
}: {
  verificationUrl: string;
  userCode: string;
  /** Whether the code reached the clipboard as the sign-in started. */
  copied: boolean;
  close: () => void;
}) {
  const [copied, setCopied] = useState(copiedAtStart);
  const [error, setError] = useState('');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(userCode);
      setCopied(true);
      setError('');
    } catch {
      setError('Select the code and copy it by hand.');
    }
  };

  return (
    <Overlay
      open
      onOpenChange={(open) => !open && close()}
      title="Sign in with ChatGPT"
      size="form"
    >
      <div className="grid w-full gap-5 p-7">
        <header className="grid gap-1.5 pr-6">
          <h2 className="text-lg font-semibold tracking-tight">Sign in with ChatGPT</h2>
          <p className="text-sm leading-relaxed text-muted">
            Enter this code on the OpenAI page. This closes once ChatGPT connects.
          </p>
        </header>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-glass-edge bg-glass-hover py-2 pr-2 pl-4">
          <output
            aria-label="Login code"
            className="font-mono text-xl font-semibold tracking-[0.2em] select-all"
          >
            {userCode}
          </output>
          <Action tone="quiet" size="small" aria-label="Copy the code" onClick={copy}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </Action>
        </div>
        <p role="status" className="flex items-center gap-2 text-[13px] text-muted">
          <Spinner size={14} />
          {copied
            ? 'Copied to the clipboard. Waiting for the sign-in…'
            : 'Waiting for the sign-in…'}
        </p>
        {error && (
          <p role="alert" className="text-[13px] text-bad">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Action tone="quiet" onClick={close}>
            Cancel
          </Action>
          <Action
            tone="primary"
            onClick={() => window.open(verificationUrl, '_blank', 'noopener,noreferrer')}
          >
            <ExternalLink size={15} />
            Open the OpenAI login
          </Action>
        </div>
      </div>
    </Overlay>
  );
}
