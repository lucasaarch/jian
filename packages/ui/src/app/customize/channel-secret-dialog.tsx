'use client';

import type { IngressSecret } from '../../components/channels/connect';
import { Action, Overlay, StatusPill } from '../../kit';
import { CopyLine, listBox } from './channel-copy-line';
import { ChannelTitle } from './channel-title';

/**
 * A new API server's address and token, the one time the token can be had: copied, never read
 * on screen. Closing it forgets the token.
 */
export function ChannelSecretDialog({
  open,
  onOpenChange,
  secret,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Kept while the dialog fades out. */
  secret: IngressSecret | undefined;
}) {
  return (
    <Overlay open={open} onOpenChange={onOpenChange} title="API Server" size="form">
      {secret && (
        <div className="grid w-full gap-5 p-7">
          <header className="grid gap-1.5 pr-6">
            <h2 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
              <ChannelTitle type="api" />
              <StatusPill tone="good">Connected</StatusPill>
            </h2>
            <p className="text-sm leading-relaxed text-muted">
              Copy the token now: it is not shown again. Your systems send it in
              X-Jian-Channel-Token.
            </p>
          </header>
          <div className={listBox}>
            <CopyLine label="Webhook URL" value={secret.url} />
            <CopyLine label="Channel token" value={secret.token} secret />
          </div>
          <div className="flex items-center gap-2">
            <span className="flex-1" />
            <Action tone="primary" onClick={() => onOpenChange(false)}>
              Done
            </Action>
          </div>
        </div>
      )}
    </Overlay>
  );
}
