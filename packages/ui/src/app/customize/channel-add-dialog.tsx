'use client';

import { type FormEvent, useState } from 'react';
import { verifyTokenOf } from '../../components/channels/meta-credentials';
import { Action, Overlay, Segmented, TextField } from '../../kit';
import type { ChannelType, NewChannel } from '../../lib/api';
import { MetaLimits } from './channel-meta';
import { ChannelTitle } from './channel-title';

/** The kinds' names where four must fit across a form. */
const short: Record<ChannelType, string> = {
  whatsapp: 'WhatsApp',
  'whatsapp-business': 'WhatsApp Business',
  telegram: 'Telegram',
  api: 'API Server',
};

/** What connecting each kind does, in a line. */
const what: Record<ChannelType, string> = {
  whatsapp: 'A device paired to your WhatsApp: connecting opens the QR code to scan on your phone.',
  'whatsapp-business':
    'Meta’s Cloud API, for inbound customer support. This creates a pending channel and its callback URL; credentials come next.',
  telegram: 'A bot from BotFather, connected with the token it gave you.',
  api: 'An HTTP endpoint for your own systems. Its URL and token are shown once.',
};

/**
 * Connects one of the kinds this agent has none of yet. A token typed here goes to the gateway
 * and is never shown again; Meta's verify token lives only in its field, cleared as it is sent.
 * The form is drawn again on each opening, so nothing typed outlives a cancel.
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
  const [error, setError] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    let request: NewChannel = { type };
    if (type === 'telegram') {
      if (!botToken.trim()) return setError('Enter the Telegram bot token.');
      request = { type, botToken: botToken.trim() };
    } else if (type === 'whatsapp-business') {
      const read = verifyTokenOf(event.currentTarget);
      if ('error' in read) return setError(read.error);
      request = { type, whatsappBusiness: read };
    }
    if (await connect(request)) close();
  };

  return (
    <form className="grid w-full gap-5 p-7" onSubmit={(event) => void submit(event)}>
      <header className="grid gap-1.5 pr-6">
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
      {type === 'whatsapp-business' && (
        <>
          <TextField
            label="Verify token"
            name="verifyToken"
            hint="Choose an unpredictable secret, and enter the same value in Meta’s webhook setup. It cannot be read back here."
            type="password"
            autoComplete="off"
            spellCheck={false}
            required
          />
          <MetaLimits />
        </>
      )}
      {error && (
        <p role="alert" className="text-[13px] text-bad">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <span className="flex-1" />
        <Action tone="quiet" onClick={close}>
          Cancel
        </Action>
        <Action tone="primary" type="submit" busy={busy}>
          {type === 'whatsapp-business' ? 'Create callback URL' : 'Connect'}
        </Action>
      </div>
    </form>
  );
}
