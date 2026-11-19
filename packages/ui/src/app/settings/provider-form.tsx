'use client';

import { type FormEvent, type ReactNode, useState } from 'react';
import type { SectionActions } from '../../components/props';
import type { Credential } from '../../components/providers/accounts';
import { anthropicCredentials } from '../../components/providers/catalog';
import {
  addressHint,
  type ProviderEntry,
  providerRequest,
  secretHint,
  secretLabel,
} from '../../components/providers/connection';
import { Action, OverlayActions, Segmented, TextField } from '../../kit';
import type { Provider } from '../../lib/api';
import type { AnthropicAs } from './provider-dialog';

/**
 * Connects an account: its credential, its address for a server of the owner's, and the name
 * the owner knows it by. Anthropic asks which of its two credentials it is, unless the line it
 * was opened from already says. The account added becomes the one runs use, as connecting always
 * did. The form is drawn again on each opening, so nothing typed outlives a cancel.
 */
export function ConnectForm({
  entry,
  as,
  header,
  another,
  environment,
  cancel,
  done,
  actions: { api, mutate, busy },
}: {
  entry: ProviderEntry;
  as?: AnthropicAs;
  header: ReactNode;
  /** The provider has accounts already: this one joins them. */
  another: boolean;
  environment: Provider | undefined;
  cancel: () => void;
  done: () => void;
  actions: SectionActions;
}) {
  const server = entry.kind === 'openai-compatible' || entry.kind === 'ollama';
  const [credential, setCredential] = useState<Credential>(as?.credential ?? 'key');
  const name = as?.name ?? entry.name;
  const [baseURL, setBaseURL] = useState(entry.kind === 'ollama' ? 'http://localhost:11434' : '');
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const detail = anthropicCredentials.find((item) => item.value === credential)?.detail;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    const request = providerRequest(entry, { secret, baseURL, credential, label });
    if ('error' in request) {
      setError(request.error);
      return;
    }
    const message = another ? `Account added to ${name}.` : `${name} connected.`;
    if (await mutate(() => api.createProvider(request.input), message)) done();
  };

  return (
    <form className="grid w-full gap-5 p-7" onSubmit={submit}>
      {header}
      {as?.replaces && (
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
        hint={secretHint(entry, environment)}
        type="password"
        autoComplete="off"
        spellCheck={false}
        required={!server}
        value={secret}
        onChange={(event) => setSecret(event.target.value)}
      />
      <TextField
        label="Account name (optional)"
        hint={
          another
            ? 'Such as Work or Personal. Runs move to this account once it is added; switch back any time.'
            : 'Such as Work or Personal. Left empty, it is numbered.'
        }
        maxLength={60}
        autoComplete="off"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
      />
      {error && (
        <p role="alert" className="text-[13px] text-bad">
          {error}
        </p>
      )}
      <OverlayActions>
        <span className="flex-1" />
        <Action tone="quiet" onClick={cancel} disabled={busy}>
          Cancel
        </Action>
        <Action tone="primary" type="submit" busy={busy}>
          {another ? 'Add account' : 'Connect'}
        </Action>
      </OverlayActions>
    </form>
  );
}
