'use client';

import { ArrowUpRight, ChevronDown, QrCode, Unplug } from 'lucide-react';
import { useState } from 'react';
import type { Channel, ChannelType } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Badge, Button, Confirm, Field, Secret, SectionHeading } from '../ui';
import { kinds } from './kinds';
import { Known } from './known';
import { Pairing } from './pairing';
import { Requests } from './requests';
import { Rooms } from './rooms';

export function Channels(props: SectionProps) {
  const { profile, data, api, mutate, busy } = props;
  const [editing, setEditing] = useState<ChannelType>();
  const [pairing, setPairing] = useState<Channel>();
  const [secret, setSecret] = useState<string>();
  const [token, setToken] = useState('');
  const [disconnecting, setDisconnecting] = useState<Channel>();
  const [error, setError] = useState('');

  const connected = (type: ChannelType) =>
    data.channels.find((channel) => channel.type === type && !channel.revokedAt);

  const webhook = (channel: Channel) =>
    channel.type === 'telegram'
      ? `${window.location.origin}/v1/telegram/${channel.id}`
      : `${window.location.origin}/v1/ingress/${channel.id}`;

  const connect = async (type: ChannelType) => {
    setError('');

    return mutate(
      async () => {
        const channel = await api.createChannel(profile.id, {
          type,
          ...(type === 'telegram' ? { botToken: token.trim() } : {}),
        });

        setToken('');

        if (type === 'whatsapp') {
          // Connecting WhatsApp is reading the QR: the device starts pairing right away.
          await api.connect(profile.id, channel.id);
          setPairing(channel);
        } else if (!channel.webhookRegistered) {
          setSecret(
            `Webhook: ${webhook(channel)}\n${
              type === 'telegram' ? 'X-Telegram-Bot-Api-Secret-Token' : 'X-Jian-Channel-Token'
            }: ${channel.webhookToken}`,
          );
        }
      },
      `${kinds.find((kind) => kind.type === type)?.name} connected.`,
    );
  };

  return (
    <>
      <SectionHeading
        title="Channels"
        description="Take the conversation to where you already are."
      />
      <Requests {...props} />
      <div className="connections-grid channels-grid">
        {kinds.map((kind) => {
          const channel = connected(kind.type);

          return (
            <article className="connection-card" data-connected={!!channel} key={kind.type}>
              <header className="connection-card-header">
                <span className="channel-symbol">
                  <kind.icon size={24} strokeWidth={1.5} />
                </span>
                <Badge tone={channel ? 'good' : 'neutral'}>
                  {channel ? 'Connected' : 'Not connected'}
                </Badge>
              </header>
              <h2>{kind.name}</h2>
              <p className="connection-description">
                {
                  {
                    whatsapp: 'Talk through your own WhatsApp.',
                    telegram: 'Receive messages through your bot.',
                    api: 'Plug in your own systems.',
                  }[kind.type]
                }
              </p>
              <p className="connection-meta">
                {
                  {
                    whatsapp: 'Pairing by QR code',
                    telegram: 'A BotFather token',
                    api: 'A webhook URL and token',
                  }[kind.type]
                }
              </p>
              <button
                type="button"
                className="connection-action"
                disabled={busy}
                aria-expanded={editing === kind.type}
                aria-controls={`channel-${kind.type}`}
                onClick={() => setEditing(editing === kind.type ? undefined : kind.type)}
              >
                {editing === kind.type ? 'Close' : channel ? 'Manage connection' : 'Set up'}
                {editing === kind.type ? <ChevronDown size={16} /> : <ArrowUpRight size={16} />}
              </button>
              <div
                className="connection-disclosure"
                id={`channel-${kind.type}`}
                hidden={editing !== kind.type}
              >
                {channel ? (
                  <>
                    {kind.type !== 'whatsapp' && (
                      <p className="note">
                        Webhook: <code>{webhook(channel)}</code>
                      </p>
                    )}
                    {kind.type === 'telegram' && (
                      <p className="note">
                        Jian registers this URL with Telegram when it connects. If that fails, the
                        secret is shown so you can call <code>setWebhook</code> yourself. To change
                        the bot token, disconnect and connect again.
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-3">
                      {kind.type === 'whatsapp' && (
                        <Button variant="secondary" onClick={() => setPairing(channel)}>
                          <QrCode size={16} />
                          Show connection
                        </Button>
                      )}
                      <Button
                        variant="quiet"
                        disabled={busy}
                        onClick={() => setDisconnecting(channel)}
                      >
                        <Unplug size={16} />
                        Disconnect
                      </Button>
                    </div>
                  </>
                ) : (
                  <form
                    method="post"
                    action="/ui/"
                    onSubmit={(event) => {
                      event.preventDefault();

                      if (kind.type === 'telegram' && !token.trim()) {
                        setError('Enter the Telegram bot token.');

                        return;
                      }

                      void connect(kind.type);
                    }}
                  >
                    {kind.type === 'telegram' && (
                      <Field
                        label="Bot token"
                        hint="The token is encrypted here and never shown again."
                      >
                        <input
                          name="botToken"
                          type="password"
                          autoComplete="off"
                          spellCheck={false}
                          value={token}
                          onChange={(event) => setToken(event.target.value)}
                          required
                        />
                      </Field>
                    )}
                    <div className="flex flex-wrap items-center gap-3">
                      <Button type="submit" busy={busy}>
                        <kind.icon size={16} />
                        Connect {kind.name}
                      </Button>
                      <span className="text-xs text-muted">
                        {kind.type === 'whatsapp'
                          ? 'Opens the QR code to scan on your phone.'
                          : kind.type === 'api'
                            ? 'Creates the webhook URL and token, shown once.'
                            : 'Use the token BotFather gave you.'}
                      </span>
                    </div>
                  </form>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <Rooms {...props} />
      <Known {...props} />
      {data.deliveries.length > 0 && (
        <section className="subsection">
          <h2>Entregas recentes</h2>
          <div className="resource-list">
            {data.deliveries.slice(0, 10).map((item) => (
              <div className="resource-row" key={item.id}>
                <div className="grow">
                  <strong>
                    {kinds.find(
                      (kind) =>
                        kind.type ===
                        data.channels.find((channel) => channel.id === item.channelId)?.type,
                    )?.name ?? 'Channel'}
                  </strong>
                  <p>
                    {item.chatId} · {date(item.updatedAt)}
                    {item.notice ? ' · approval notice' : ''}
                  </p>
                </div>
                <Badge
                  tone={
                    item.status === 'sent'
                      ? 'good'
                      : ['failed', 'unknown'].includes(item.status)
                        ? 'bad'
                        : 'warn'
                  }
                >
                  {
                    {
                      pending: 'Pending',
                      sending: 'Sending',
                      sent: 'Sent',
                      failed: 'Failed',
                      unknown: 'Outcome unknown',
                    }[item.status]
                  }
                </Badge>
              </div>
            ))}
          </div>
          <p className="note">
            A delivery whose outcome is unknown is never resent on its own, so nothing arrives
            twice.
          </p>
        </section>
      )}
      {pairing && (
        <Pairing
          profileId={profile.id}
          channel={pairing}
          api={api}
          close={() => setPairing(undefined)}
        />
      )}
      {secret && (
        <Secret title="Webhook configuration" value={secret} close={() => setSecret(undefined)} />
      )}
      {disconnecting && (
        <Confirm
          title="Disconnect this channel?"
          description="The channel stops receiving messages. Approved contacts and their conversations are kept."
          busy={busy}
          close={() => setDisconnecting(undefined)}
          confirm={async () => {
            if (
              await mutate(
                () => api.revokeChannel(profile.id, disconnecting.id),
                'Channel disconnected.',
              )
            ) {
              setDisconnecting(undefined);
            }
          }}
        />
      )}
    </>
  );
}
