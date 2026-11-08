'use client';

import { type FormEvent, useState } from 'react';
import { Action, Overlay, OverlayActions, Segmented, TextField } from '../../kit';
import type { ChannelType, NewChannel } from '../../lib/api';
import { ChannelTitle } from './channel-title';

/** The kinds' names where four must fit across a form. */
const short: Record<ChannelType, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  email: 'Email',
  api: 'API Server',
};

/** What connecting each kind does, in a line. */
const what: Record<ChannelType, string> = {
  whatsapp: 'A device paired to your WhatsApp: connecting opens the QR code to scan on your phone.',
  telegram: 'A bot from BotFather, connected with the token it gave you.',
  email:
    'An address on your own domain, through Resend or Cloudflare. Jian sets up how mail reaches it at JIAN_PUBLIC_URL, which the internet must reach.',
  api: 'An HTTP endpoint for your own systems. Its URL and token are shown once.',
};

type EmailProvider = 'resend' | 'cloudflare';

/** What each email provider needs in place before connecting, and what its key must allow. */
const providers: Record<EmailProvider, { label: string; before: string; key: string }> = {
  resend: {
    label: 'Resend',
    before:
      'The domain must be verified in Resend, with receiving on and its MX record in place. Jian registers its webhook as it connects.',
    key: 'Full access, so Jian can check the domain and register the webhook. Encrypted on the gateway and never shown again.',
  },
  cloudflare: {
    label: 'Cloudflare',
    before:
      'The domain must be a zone in this account with Email Routing enabled, and onboarded in Email Sending. Jian uploads a Worker that forwards the address’s mail and adds its routing rule as it connects.',
    key: 'A token with Account › Email Sending: Edit, Account › Workers Scripts: Edit, Zone › Email Routing Rules: Edit, Zone › Zone Settings: Read and Zone › Zone: Read. Encrypted on the gateway and never shown again.',
  },
};

/**
 * Connects one of the kinds this agent has none of yet. A token or API key typed here goes to the
 * gateway and is never shown again. The form is drawn again on each opening, so nothing typed outlives a cancel.
 */
export function ChannelAddDialog({
  open,
  onOpenChange,
  round,
  available,
  busy,
  connect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  round: number;
  /** The kinds not connected yet: one channel of each kind per agent. */
  available: ChannelType[];
  busy: boolean;
  /** Resolves true once the channel exists. */
  connect: (request: NewChannel) => Promise<boolean>;
}) {
  return (
    <Overlay open={open} onOpenChange={onOpenChange} title="Add a channel" size="form">
      {available[0] && (
        <AddForm
          key={round}
          available={available}
          first={available[0]}
          busy={busy}
          connect={connect}
          close={() => onOpenChange(false)}
        />
      )}
    </Overlay>
  );
}

function AddForm({
  available,
  first,
  busy,
  connect,
  close,
}: {
  available: ChannelType[];
  first: ChannelType;
  busy: boolean;
  connect: (request: NewChannel) => Promise<boolean>;
  close: () => void;
}) {
  const [type, setType] = useState<ChannelType>(first);
  const [botToken, setBotToken] = useState('');
  const [provider, setProvider] = useState<EmailProvider>('resend');
  const [apiKey, setApiKey] = useState('');
  const [accountId, setAccountId] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    let request: NewChannel = { type };
    if (type === 'telegram') {
      if (!botToken.trim()) return setError('Enter the Telegram bot token.');
      request = { type, botToken: botToken.trim() };
    } else if (type === 'email') {
      const key = apiKey.trim();
      const mail = address.trim();
      if (provider === 'resend') {
        if (!key || !mail) return setError('Enter the Resend API key and the address.');
        request = { type, email: { provider, apiKey: key, address: mail } };
      } else {
        const account = accountId.trim();
        if (!key || !account || !mail)
          return setError('Enter the Cloudflare API token, the account ID and the address.');
        if (!/^[0-9a-f]{32}$/i.test(account))
          return setError('The account ID is the 32 characters shown on the account’s overview.');
        request = { type, email: { provider, apiKey: key, accountId: account, address: mail } };
      }
    }
    if (await connect(request)) close();
  };

  return (
    <form className="grid w-full gap-5 p-7" onSubmit={(event) => void submit(event)}>
      <header className="grid gap-1.5 pr-10">
        <h2 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
          <ChannelTitle type={type} />
        </h2>
        <p className="text-sm leading-relaxed text-muted">{what[type]}</p>
      </header>
      {available.length > 1 && (
        <Segmented
          label="Channel"
          value={type}
          options={available.map((value) => ({ value, label: short[value] }))}
          onChange={(next) => {
            setType(next);
            setError('');
          }}
        />
      )}
      {type === 'telegram' && (
        <TextField
          label="Bot token"
          hint="Encrypted on the gateway and never shown again."
          type="password"
          autoComplete="off"
          spellCheck={false}
          required
          value={botToken}
          onChange={(event) => setBotToken(event.target.value)}
        />
      )}
      {type === 'email' && (
        <>
          <Segmented
            label="Provider"
            value={provider}
            options={(['resend', 'cloudflare'] as const).map((value) => ({
              value,
              label: providers[value].label,
            }))}
            onChange={(next) => {
              setProvider(next);
              setError('');
            }}
          />
          <p className="text-[13px] leading-relaxed text-muted">{providers[provider].before}</p>
          <TextField
            label={provider === 'resend' ? 'Resend API key' : 'Cloudflare API token'}
            hint={providers[provider].key}
            type="password"
            autoComplete="off"
            spellCheck={false}
            required
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
          {provider === 'cloudflare' && (
            <TextField
              label="Account ID"
              hint="On the account’s overview in the Cloudflare dashboard."
              autoComplete="off"
              spellCheck={false}
              required
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
            />
          )}
          <TextField
            label="Address"
            hint="The agent sends from it and reads what arrives at it. Mail its sender’s domain does not authenticate is ignored."
            type="email"
            autoComplete="off"
            spellCheck={false}
            required
            placeholder="mia@agents.example.com"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
        </>
      )}
      {error && (
        <p role="alert" className="text-[13px] text-bad">
          {error}
        </p>
      )}
      <OverlayActions>
        <span className="flex-1" />
        <Action tone="quiet" onClick={close}>
          Cancel
        </Action>
        <Action tone="primary" type="submit" busy={busy}>
          Connect
        </Action>
      </OverlayActions>
    </form>
  );
}
