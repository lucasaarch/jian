'use client';

import { type FormEvent, useState } from 'react';
import type { SectionActions } from '../../components/props';
import { anthropicCredentials } from '../../components/providers/catalog';
import {
  addressHint,
  credentialLine,
  type ProviderEntry,
  providerRequest,
  secretHint,
  secretLabel,
  staleLine,
} from '../../components/providers/connection';
import { Action, Overlay, Segmented, StatusPill, TextField } from '../../kit';
import type { Provider, ProviderModelList } from '../../lib/api';
import { ProviderTitle } from './provider-title';

export type Credential = (typeof anthropicCredentials)[number]['value'];

/**
 * One of Anthropic's two credentials, shown as a provider of its own: an API key, or a Claude
 * Code token from `claude setup-token`. The gateway keeps one Anthropic credential at a time.
 */
export type AnthropicAs = {
  credential: Credential;
  name: string;
  description: string;
  /** Said when the other credential is connected: saving this one replaces it. */
  replaces?: string;
};

const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** What a connected vendor holds and offers, a fact to a line. */
function factsOf(configured: Provider, list: ProviderModelList | undefined): string[] {
  const unknown = list?.models.filter((model) => !model.known).length ?? 0;
  return [
    configured.baseURL ? `At ${configured.baseURL}` : credentialLine(configured),
    list?.models.length ? count(list.models.length, 'model') : '',
    unknown ? `${unknown} with unknown capabilities` : '',
  ].filter(Boolean);
}

/**
 * One vendor, configured: how it is connected and what it offers, its credential to replace, and
 * the way to disconnect it. Its credential is written here and never shown back; Anthropic asks
 * which of its two credentials it is, and a server of the owner's where it answers. The form is
 * drawn again on each opening, so nothing typed outlives a cancel.
 */
export function ProviderDialog({
  entry,
  as,
  configured,
  list,
  open,
  onOpenChange,
  onDisconnect,
  actions,
}: {
  entry: ProviderEntry | undefined;
  /** For Anthropic, which of its credentials this dialog is about. */
  as?: AnthropicAs;
  /** What this vendor holds now, if anything: the dialog then replaces it. */
  configured: Provider | undefined;
  list: ProviderModelList | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Asks to confirm, then disconnects; absent for a credential the gateway reads from its environment. */
  onDisconnect: (provider: Provider) => void;
  actions: SectionActions;
}) {
  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      title={as?.name ?? entry?.name ?? 'Provider'}
      size="form"
    >
      {entry && (
        <ProviderForm
          key={`${entry.kind}-${as?.credential ?? ''}`}
          entry={entry}
          {...(as ? { as } : {})}
          configured={configured}
          list={list}
          close={() => onOpenChange(false)}
          onDisconnect={onDisconnect}
          actions={actions}
        />
      )}
    </Overlay>
  );
}

function ProviderForm({
  entry,
  as,
  configured,
  list,
  close,
  onDisconnect,
  actions: { api, mutate, busy },
}: {
  entry: ProviderEntry;
  as?: AnthropicAs;
  configured: Provider | undefined;
  list: ProviderModelList | undefined;
  close: () => void;
  onDisconnect: (provider: Provider) => void;
  actions: SectionActions;
}) {
  const stale = staleLine(list);
  const server = entry.kind === 'openai-compatible' || entry.kind === 'ollama';
  const [credential, setCredential] = useState<Credential>(
    as?.credential ?? (configured?.credential === 'subscription' ? 'subscription' : 'key'),
  );
  const name = as?.name ?? entry.name;
  const [baseURL, setBaseURL] = useState(
    configured?.baseURL ?? (entry.kind === 'ollama' ? 'http://localhost:11434' : ''),
  );
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const detail = anthropicCredentials.find((item) => item.value === credential)?.detail;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    const request = providerRequest(entry, { secret, baseURL, credential });
    if ('error' in request) {
      setError(request.error);
      return;
    }
    if (await mutate(() => api.createProvider(request.input), `${name} configured.`)) {
      close();
    }
  };

  return (
    <form className="grid w-full gap-5 p-7" onSubmit={submit}>
      <header className="grid gap-1.5 pr-6">
        <h2 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
          <ProviderTitle kind={entry.kind}>{name}</ProviderTitle>
          {configured && (
            <StatusPill tone={stale ? 'bad' : 'good'}>
              {stale ? 'Unreachable' : 'Connected'}
            </StatusPill>
          )}
        </h2>
        <p className="text-sm leading-relaxed text-muted">
          {as?.description ?? entry.description}
          {!configured && !as && entry.variables
            ? ` Or set ${entry.variables} where the gateway runs.`
            : ''}
        </p>
      </header>
      {configured && (
        <ul className="grid gap-1 rounded-lg bg-ink/5 px-3 py-2.5 text-xs leading-relaxed text-muted">
          {factsOf(configured, list).map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
          {stale && <li className="text-bad">{stale}</li>}
        </ul>
      )}
      {as?.replaces && !configured && (
        <p className="rounded-lg bg-warn/10 px-3 py-2.5 text-xs leading-relaxed text-warn">
          {as.replaces}
        </p>
      )}
      {entry.kind === 'anthropic' && !as && (
        <div className="grid gap-1.5">
          <span className="text-[13px] font-medium text-ink">Credential type</span>
          <Segmented
            label="Credential type"
            value={credential}
            options={anthropicCredentials.map(({ value, label }) => ({ value, label }))}
            onChange={setCredential}
          />
          <small className="text-xs leading-snug text-muted">
            {detail} Anthropic refuses either one sent as the other.
          </small>
        </div>
      )}
      {server && (
        <TextField
          label="Address"
          hint={addressHint(entry)}
          type="url"
          required
          placeholder={
            entry.kind === 'ollama' ? 'http://localhost:11434' : 'https://server.example/v1'
          }
          value={baseURL}
          onChange={(event) => setBaseURL(event.target.value)}
        />
      )}
      <TextField
        label={as ? (as.credential === 'subscription' ? 'Token' : 'API key') : secretLabel(entry)}
        hint={secretHint(entry, configured)}
        type="password"
        autoComplete="off"
        spellCheck={false}
        required={!server}
        value={secret}
        onChange={(event) => setSecret(event.target.value)}
      />
      {error && (
        <p role="alert" className="text-[13px] text-bad">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        {/* A credential read from the gateway's environment is changed there, not here. */}
        {configured && !configured.apiKeyEnv && (
          <Action
            tone="danger"
            className="bg-bad/10"
            disabled={busy}
            onClick={() => onDisconnect(configured)}
          >
            Disconnect
          </Action>
        )}
        <span className="flex-1" />
        <Action tone="quiet" onClick={close} disabled={busy}>
          Cancel
        </Action>
        <Action tone="primary" type="submit" busy={busy}>
          {configured ? 'Replace' : 'Connect'}
        </Action>
      </div>
    </form>
  );
}
