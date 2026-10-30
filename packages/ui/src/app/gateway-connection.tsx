'use client';

import { type FormEvent, useState } from 'react';
import {
  Action,
  ConfirmDialog,
  Overlay,
  SettingsGroup,
  SettingsRow,
  StatusPill,
  TextField,
} from '../kit';

/** A gateway the host keeps, as its settings show it. */
export type GatewayInfo = {
  id: string;
  /** What it is called: this computer, or the host it answers at. */
  name: string;
  /** The one the app runs on this computer: it is never removed. */
  local: boolean;
  url: string;
  version?: string;
  /** How it stands, in a word or two: "Connected", "Not answering". */
  state: string;
};

/** What the host does with a gateway it keeps; a token never comes back to the window. */
export type GatewayActions = {
  replaceToken: (id: string, token: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  remove: (id: string) => Promise<void>;
};

/**
 * How the app reaches the gateway in use, a line each: where it answers, and its release with
 * how it stands. For one elsewhere, its token and its removal from the app are behind Configure.
 */
export function GatewayConnection({
  gateway,
  host,
}: {
  gateway: GatewayInfo;
  host: GatewayActions;
}) {
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [removing, setRemoving] = useState(false);

  return (
    <>
      <SettingsGroup>
        <SettingsRow title="Address">
          <span className="font-mono text-xs text-muted">{gateway.url || 'Starting…'}</span>
        </SettingsRow>
        <SettingsRow
          title={
            <span className="flex items-center gap-2">
              Version
              <StatusPill tone={gateway.state === 'Connected' ? 'good' : 'quiet'}>
                {gateway.state}
              </StatusPill>
            </span>
          }
        >
          <span className="text-xs text-muted">{gateway.version ?? 'Development build'}</span>
        </SettingsRow>
        {!gateway.local && (
          <SettingsRow title="Credentials">
            <Action
              tone="outline"
              size="small"
              aria-label={`Configure ${gateway.name}`}
              onClick={() => setOpen(true)}
            >
              Configure
            </Action>
          </SettingsRow>
        )}
      </SettingsGroup>
      <Overlay open={open} onOpenChange={setOpen} title={gateway.name} size="form">
        <Credentials
          gateway={gateway}
          host={host}
          close={() => setOpen(false)}
          remove={() => setAsking(true)}
        />
      </Overlay>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Remove ${gateway.name}?`}
        phrase={gateway.name}
        action="Remove gateway"
        busy={removing}
        run={async () => {
          setRemoving(true);
          await host.remove(gateway.id);
          setRemoving(false);
          setAsking(false);
          setOpen(false);
        }}
      >
        The app forgets it and its token on this computer. The gateway and everything on it stay on
        the server; connect it again whenever you like.
      </ConfirmDialog>
    </>
  );
}

/** The gateway's host token to replace, checked with it before it is kept, and its removal. */
function Credentials({
  gateway,
  host,
  close,
  remove,
}: {
  gateway: GatewayInfo;
  host: GatewayActions;
  close: () => void;
  remove: () => void;
}) {
  const [token, setToken] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState('');

  const replace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setReplacing(true);
    setError('');
    const result = await host.replaceToken(gateway.id, token);
    setReplacing(false);
    if (result.ok) close();
    else setError(result.error);
  };

  return (
    <form className="grid w-full gap-5 p-7" onSubmit={replace}>
      <header className="grid gap-1.5 pr-6">
        <h2 className="truncate text-lg font-semibold tracking-tight">{gateway.name}</h2>
        <p className="text-sm leading-relaxed text-muted">
          A new host token, after rotating it on the server: the app checks it with the gateway
          before it keeps it.
        </p>
      </header>
      <TextField
        label="Host token"
        type="password"
        required
        autoComplete="off"
        spellCheck={false}
        value={token}
        onChange={(event) => setToken(event.target.value)}
      />
      {error && (
        <p role="alert" className="text-[13px] text-bad">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Action tone="danger" className="bg-bad/10" disabled={replacing} onClick={remove}>
          Remove
        </Action>
        <span className="flex-1" />
        <Action tone="quiet" onClick={close} disabled={replacing}>
          Cancel
        </Action>
        <Action tone="primary" type="submit" busy={replacing} disabled={!token}>
          Replace
        </Action>
      </div>
    </form>
  );
}
