'use client';

import { ChevronDown, Unplug } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { Channel, ChannelType, NewChannel } from '../../lib/api';
import { useAgent, useChannels, useContacts } from '../../lib/query/agent';
import { gatewayOrigin } from '../../platform/gateway';
import type { SectionActions } from '../props';
import { Badge, Button, Confirm, Field, Secret, SectionHeading, Switch } from '../ui';
import { Conversations } from './conversations';
import { kinds } from './kinds';
import { ChannelMessages } from './messages';
import { MetaCallback, MetaCredentials, MetaLimits } from './meta';
import { Pairing } from './pairing';

/** An API server's callers are senders of the owner's systems, not people's contacts. */
const admitsAll = (type: ChannelType) =>
  type === 'api' ? 'Allow all senders' : 'Allow all contacts';

export function Channels(props: SectionActions) {
  const { api, mutate, busy } = props;
  const profile = useAgent();
  const channels = useChannels();
  const contacts = useContacts();
  // A channel with someone waiting opens on its own: the decision is why the owner came here.
  const [editing, setEditing] = useState<ChannelType | undefined>(
    () =>
      channels.find((channel) =>
        contacts.some(
          (contact) => contact.channelId === channel.id && contact.status === 'pending',
        ),
      )?.type,
  );
  const [pairing, setPairing] = useState<Channel>();
  const [secret, setSecret] = useState<string>();
  const [token, setToken] = useState('');
  const [disconnecting, setDisconnecting] = useState<Channel>();
  const [error, setError] = useState('');

  const connected = (type: ChannelType) =>
    channels.find((channel) => channel.type === type && !channel.revokedAt);

  const webhook = (channel: Channel) =>
    channel.type === 'telegram'
      ? `${gatewayOrigin()}/v1/telegram/${channel.id}`
      : channel.type === 'whatsapp-business'
        ? `${gatewayOrigin()}/v1/whatsapp-business/${channel.id}`
        : `${gatewayOrigin()}/v1/ingress/${channel.id}`;

  const connect = async (type: ChannelType, whatsappBusiness?: NewChannel['whatsappBusiness']) => {
    setError('');

    return mutate(
      async () => {
        const channel = await api.createChannel(profile.id, {
          type,
          ...(type === 'telegram' ? { botToken: token.trim() } : {}),
          ...(type === 'whatsapp-business' ? { whatsappBusiness } : {}),
        });

        setToken('');

        if (type === 'whatsapp') {
          // Connecting WhatsApp is reading the QR: the device starts pairing right away.
          await api.connect(profile.id, channel.id);
          setPairing(channel);
        } else if (type === 'telegram') {
          // Jian points the bot at itself; only a refusal is worth the owner's attention, and
          // what fixes it is the public address, not a secret to paste somewhere by hand.
          if (channel.webhookRegistered === false)
            toast.error(
              `${channel.webhookError ?? 'Telegram refused the webhook.'} Set JIAN_PUBLIC_URL to the gateway's public HTTPS address, then disconnect and connect again.`,
              { duration: 20_000 },
            );
        } else if (type === 'api' && !channel.webhookRegistered) {
          setSecret(`Webhook: ${webhook(channel)}\nX-Jian-Channel-Token: ${channel.webhookToken}`);
        }
      },
      type === 'whatsapp-business'
        ? 'Meta callback created. Setup pending: register the webhook in Meta, then complete credentials here.'
        : `${kinds.find((kind) => kind.type === type)?.name} connected.`,
    );
  };

  const waiting = (channel: Channel) =>
    contacts.filter((contact) => contact.channelId === channel.id && contact.status === 'pending')
      .length;

  return (
    <>
      <SectionHeading
        title="Channels"
        description="Take the conversation to where you already are."
      />
      <div className="resource-list">
        {kinds.map((kind) => {
          const channel = connected(kind.type);
          const open = editing === kind.type;
          const metaPending = channel?.whatsappBusinessStatus === 'pending';

          return (
            <article
              className="resource-row items-start provider-row"
              data-connected={!!channel}
              key={kind.type}
            >
              <div className="resource-icon provider-symbol" aria-hidden="true">
                <kind.icon size={20} strokeWidth={1.6} />
              </div>
              <div className="grow">
                <h3>
                  {kind.name}
                  <Badge tone={channel && !metaPending ? 'good' : 'neutral'}>
                    {kind.type === 'whatsapp-business'
                      ? channel
                        ? metaPending
                          ? 'Setup pending'
                          : 'Configured'
                        : 'Not configured'
                      : channel
                        ? 'Connected'
                        : 'Not connected'}
                  </Badge>
                  {channel?.enabled === false && <Badge>Disabled</Badge>}
                  {channel && waiting(channel) > 0 && (
                    <Badge tone="accent">{waiting(channel)} pending</Badge>
                  )}
                </h3>
                <p>{kind.description}</p>
              </div>
              <div className="row-actions">
                <Button
                  variant="quiet"
                  disabled={busy}
                  aria-expanded={open}
                  aria-controls={`channel-${kind.type}`}
                  onClick={() => {
                    setEditing(open ? undefined : kind.type);
                    setError('');
                  }}
                >
                  {open
                    ? 'Close'
                    : channel
                      ? 'Manage'
                      : kind.type === 'whatsapp-business'
                        ? 'Set up'
                        : 'Connect'}
                  <ChevronDown size={16} className={open ? 'rotate-180' : undefined} />
                </Button>
              </div>
              <div
                className="connection-disclosure basis-full"
                id={`channel-${kind.type}`}
                hidden={!open}
              >
                {kind.type === 'whatsapp-business' && <MetaLimits />}
                {channel ? (
                  <>
                    {kind.type !== 'whatsapp' && kind.type !== 'whatsapp-business' && (
                      <p className="note">
                        Webhook: <code>{webhook(channel)}</code>
                      </p>
                    )}
                    {kind.type === 'telegram' && (
                      <p className="note">
                        Jian registers this URL with Telegram when it connects, at{' '}
                        <code>JIAN_PUBLIC_URL</code> when it is set. To change the bot token,
                        disconnect and connect again.
                      </p>
                    )}
                    {kind.type === 'whatsapp-business' && (
                      <>
                        <MetaCallback url={webhook(channel)} />
                        {metaPending && (
                          <p className="note">
                            Setup pending. Messaging is unavailable until credentials are completed.
                          </p>
                        )}
                        <p className="note">
                          Manually register this public HTTPS URL and your verify token in Meta,
                          subscribe the app to the business account and its messages events, and
                          test an inbound message. Use the gateway’s public origin if this panel is
                          served elsewhere. Meta signs POST payloads with your app secret; no
                          X-Jian-Channel-Token is used. To rotate credentials, disconnect and
                          configure again. This saved configuration is not a delivery health check.
                        </p>
                        {metaPending && open && (
                          <MetaCredentials
                            busy={busy}
                            save={(whatsappBusiness) => {
                              void mutate(
                                () =>
                                  api.updateChannel(profile.id, channel.id, { whatsappBusiness }),
                                'Meta credentials saved. Complete manual subscriptions in Meta before testing delivery.',
                              );
                            }}
                          />
                        )}
                      </>
                    )}
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="font-medium">Channel enabled</p>
                        <p className="note">
                          Off, the agent ignores what arrives here and sends nothing. The connection
                          stays, and messages received meanwhile are not answered later.
                        </p>
                        {kind.type === 'whatsapp-business' && (
                          <p className="note">
                            Manual service in the WhatsApp Business app is untouched if your account
                            already supports it. Jian does not enable app/API coexistence.
                          </p>
                        )}
                      </div>
                      <Switch
                        label="Channel enabled"
                        checked={channel.enabled ?? true}
                        disabled={busy}
                        onChange={(enabled) =>
                          void mutate(
                            () => api.updateChannel(profile.id, channel.id, { enabled }),
                            enabled
                              ? 'Channel enabled. Messages received while it was off are not answered.'
                              : 'Channel disabled.',
                          )
                        }
                      />
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="font-medium">{admitsAll(kind.type)}</p>
                        <p className="note">
                          {kind.type === 'api'
                            ? 'New senders reach the agent without your approval. Rooms still ask, and blocked senders stay blocked.'
                            : kind.type === 'whatsapp-business'
                              ? 'New people can chat without your approval. Blocked contacts stay blocked.'
                              : 'New people can chat privately without your approval. Groups still ask, and blocked contacts stay blocked.'}
                        </p>
                      </div>
                      <Switch
                        label={admitsAll(kind.type)}
                        checked={channel.allowAllContacts ?? false}
                        disabled={busy}
                        onChange={(allowAllContacts) =>
                          void mutate(
                            () => api.updateChannel(profile.id, channel.id, { allowAllContacts }),
                            kind.type === 'api'
                              ? 'Sender permissions updated.'
                              : 'Contact permissions updated.',
                          )
                        }
                      />
                    </div>
                    {kind.type !== 'api' && (
                      <ChannelMessages
                        channel={channel}
                        busy={busy}
                        save={(messages) =>
                          mutate(
                            () => api.updateChannel(profile.id, channel.id, { messages }),
                            'Messages saved.',
                          )
                        }
                      />
                    )}
                    <div className="flex flex-wrap items-center gap-3">
                      <Button
                        variant="danger"
                        disabled={busy}
                        onClick={() => setDisconnecting(channel)}
                      >
                        <Unplug size={16} />
                        Disconnect
                      </Button>
                    </div>
                    {!metaPending && <Conversations {...props} channel={channel} />}
                  </>
                ) : (
                  <form
                    method="post"
                    action="/"
                    onSubmit={(event) => {
                      event.preventDefault();

                      if (kind.type === 'telegram' && !token.trim()) {
                        setError('Enter the Telegram bot token.');

                        return;
                      }

                      if (kind.type === 'whatsapp-business') {
                        const form = event.currentTarget;
                        const fields = new FormData(form);
                        const whatsappBusiness = {
                          verifyToken: String(fields.get('verifyToken') ?? '').trim(),
                        };
                        // Clear before validation/request; even failed saves must not retain secrets.
                        form.reset();
                        if (!whatsappBusiness.verifyToken) {
                          setError('Enter a verify token.');
                          return;
                        }
                        void connect(kind.type, whatsappBusiness);
                        return;
                      }

                      void connect(kind.type);
                    }}
                  >
                    {kind.type === 'whatsapp-business' && open && (
                      <Field
                        label="Verify token"
                        hint="Choose an unpredictable secret. Keep it to enter the same value in Meta’s webhook setup; it cannot be read back here."
                      >
                        <input
                          name="verifyToken"
                          type="password"
                          autoComplete="off"
                          spellCheck={false}
                          required
                        />
                      </Field>
                    )}
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
                        {kind.type === 'whatsapp-business'
                          ? 'Create callback URL'
                          : `Connect ${kind.name}`}
                      </Button>
                      <span className="text-xs text-muted">
                        {kind.type === 'whatsapp'
                          ? 'Opens the QR code to scan on your phone.'
                          : kind.type === 'api'
                            ? 'Creates the webhook URL and token, shown once.'
                            : kind.type === 'whatsapp-business'
                              ? 'Creates a pending channel, not a working connection. Credentials come next.'
                              : 'Use the token BotFather gave you.'}
                      </span>
                    </div>
                  </form>
                )}
                {error && open && (
                  <p className="form-error" role="alert">
                    {error}
                  </p>
                )}
              </div>
            </article>
          );
        })}
      </div>
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
