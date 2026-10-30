'use client';

import { type FormEvent, useState } from 'react';
import { Action, ConfirmDialog, Overlay, SettingsRow, StatusPill, TextField } from '../../kit';
import { date } from '../../lib/format';

type Status = { configured: boolean; updatedAt?: string };

/** Runs a change of the service and keeps what it answers; false when it failed. */
export type ServiceChange<S> = (action: () => Promise<S>, done: string) => Promise<boolean>;

/** What a service is and how it is reached, for its line and its dialog. */
export type Service<S extends Status> = {
  /** Whose key it is: "Tavily". */
  vendor: string;
  /** Where a key is had. */
  source: string;
  description: string;
  /** What disconnecting it changes. */
  removal: string;
  save: (key: string) => Promise<S>;
  remove: () => Promise<S>;
};

/**
 * A service the whole installation reaches through one key, as a line of the Services card:
 * whether it is connected, and everything else about it behind Configure — its key to save or
 * replace, never shown back, and disconnecting it, asked to confirm by the vendor's name.
 */
export function ServiceRow<S extends Status>({
  service,
  status,
  change,
  busy,
}: {
  service: Service<S>;
  status: S | undefined;
  change: ServiceChange<S>;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const { vendor } = service;

  return (
    <>
      <SettingsRow
        title={
          <span className="flex items-center gap-2">
            {vendor}
            {status?.configured && <StatusPill tone="good">Connected</StatusPill>}
          </span>
        }
      >
        <Action
          tone="outline"
          size="small"
          aria-label={`Configure ${vendor}`}
          onClick={() => setOpen(true)}
        >
          Configure
        </Action>
      </SettingsRow>
      <Overlay open={open} onOpenChange={setOpen} title={vendor} size="form">
        <ServiceForm
          service={service}
          status={status}
          change={change}
          busy={busy}
          close={() => setOpen(false)}
          disconnect={() => setAsking(true)}
        />
      </Overlay>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Disconnect ${vendor}?`}
        phrase={vendor}
        action={`Disconnect ${vendor}`}
        busy={busy}
        run={async () => {
          if (await change(service.remove, `${vendor} disconnected.`)) {
            setAsking(false);
            setOpen(false);
          }
        }}
      >
        {service.removal} The key is deleted from the gateway; save a new one whenever you like.
      </ConfirmDialog>
    </>
  );
}

function ServiceForm<S extends Status>({
  service,
  status,
  change,
  busy,
  close,
  disconnect,
}: {
  service: Service<S>;
  status: S | undefined;
  change: ServiceChange<S>;
  busy: boolean;
  close: () => void;
  disconnect: () => void;
}) {
  const [key, setKey] = useState('');
  const configured = status?.configured === true;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (await change(() => service.save(key.trim()), `${service.vendor} configured.`)) {
      setKey('');
      close();
    }
  };

  return (
    <form className="grid w-full gap-5 p-7" onSubmit={submit}>
      <header className="grid gap-1.5 pr-6">
        <h2 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
          {service.vendor}
          {configured && <StatusPill tone="good">Connected</StatusPill>}
        </h2>
        <p className="text-sm leading-relaxed text-muted">{service.description}</p>
      </header>
      {configured && status?.updatedAt && (
        <p className="rounded-lg bg-ink/5 px-3 py-2.5 text-xs text-muted">
          Key saved on {date(status.updatedAt)}
        </p>
      )}
      <TextField
        label={`${service.vendor} key`}
        hint={`A key from ${service.source}. What you save here is never shown again.`}
        type="password"
        autoComplete="off"
        spellCheck={false}
        required
        value={key}
        onChange={(event) => setKey(event.target.value)}
      />
      <div className="flex items-center gap-2">
        {configured && (
          <Action tone="danger" className="bg-bad/10" disabled={busy} onClick={disconnect}>
            Disconnect
          </Action>
        )}
        <span className="flex-1" />
        <Action tone="quiet" onClick={close} disabled={busy}>
          Cancel
        </Action>
        <Action tone="primary" type="submit" busy={busy} disabled={!key.trim()}>
          {configured ? 'Replace' : 'Connect'}
        </Action>
      </div>
    </form>
  );
}
