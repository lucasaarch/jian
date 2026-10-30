'use client';

import { useId, useState } from 'react';
import { channelUrl, kindName } from '../../components/channels/connect';
import { waitingOn } from '../../components/channels/contacts';
import type { SectionActions } from '../../components/props';
import { Action, Overlay } from '../../kit';
import type { Channel } from '../../lib/api';
import { useAgent, useContacts } from '../../lib/query/agent';
import { ChannelContacts } from './channel-contacts';
import { CopyLine, listBox } from './channel-copy-line';
import { ChannelMessagesDialog } from './channel-messages-dialog';
import { MetaCredentialsForm, MetaLimits } from './channel-meta';
import { ChannelSwitches } from './channel-switches';
import { ChannelPills, ChannelTitle, useDevice } from './channel-title';

/** What reaching the channel's address takes, said under it. */
const addressNote: Partial<Record<Channel['type'], string>> = {
  telegram:
    'Jian registers it with Telegram as it connects, at JIAN_PUBLIC_URL when that is set. To change the bot token, disconnect and connect again.',
  api: 'Your systems post here with the token given when it was connected, in X-Jian-Channel-Token.',
  'whatsapp-business':
    'Register it in Meta with your verify token, subscribe the app to the account’s messages events, then send a test message. Meta signs each payload with your app secret.',
};

/**
 * Everything about one channel: how it stands, its address, its switches and wording, who it
 * reaches and their approval, pairing a WhatsApp device again, completing Meta's setup, and
 * disconnecting it, which the page asks to confirm by name.
 */
export function ChannelDialog({
  open,
  onOpenChange,
  channel,
  actions,
  onDisconnect,
  onPair,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Kept while the dialog fades out. */
  channel: Channel | undefined;
  actions: SectionActions;
  onDisconnect: (channel: Channel) => void;
  onPair: (channel: Channel) => void;
}) {
  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      title={channel ? kindName(channel.type) : 'Channel'}
      size="form"
    >
      {channel && (
        <ChannelSettings
          channel={channel}
          actions={actions}
          close={() => onOpenChange(false)}
          onDisconnect={onDisconnect}
          onPair={onPair}
        />
      )}
    </Overlay>
  );
}

function ChannelSettings({
  channel,
  actions,
  close,
  onDisconnect,
  onPair,
}: {
  channel: Channel;
  actions: SectionActions;
  close: () => void;
  onDisconnect: (channel: Channel) => void;
  onPair: (channel: Channel) => void;
}) {
  const { api, mutate, busy } = actions;
  const profile = useAgent();
  const contacts = useContacts();
  const device = useDevice(api, profile.id, channel);
  const credentials = useId();
  const [wording, setWording] = useState(false);
  const [round, setRound] = useState(0);
  const pending = channel.whatsappBusinessStatus === 'pending';
  const meta = channel.type === 'whatsapp-business';

  const summary =
    channel.type === 'whatsapp'
      ? device?.accountId
        ? `Linked to ${device.accountId}.`
        : 'A device paired to your WhatsApp.'
      : meta
        ? pending
          ? 'Messaging is unavailable until the credentials are complete.'
          : 'Meta’s Cloud API, for inbound customer support.'
        : channel.type === 'telegram'
          ? 'A bot from BotFather.'
          : 'An HTTP endpoint for your own systems.';

  return (
    <div className="grid w-full gap-5 p-7">
      <header className="grid gap-1.5 pr-6">
        <h2 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
          <ChannelTitle type={channel.type} />
          <ChannelPills channel={channel} device={device} waiting={waitingOn(contacts, channel)} />
        </h2>
        <p className="text-sm leading-relaxed text-muted">{summary}</p>
      </header>
      {channel.type !== 'whatsapp' && (
        <div className="grid gap-2">
          <div className={listBox}>
            <CopyLine label={meta ? 'Callback URL' : 'Webhook URL'} value={channelUrl(channel)} />
          </div>
          <p className="px-1 text-xs leading-relaxed text-muted">{addressNote[channel.type]}</p>
        </div>
      )}
      {meta && <MetaLimits />}
      {pending && (
        <MetaCredentialsForm
          id={credentials}
          save={(whatsappBusiness) =>
            void mutate(
              () => api.updateChannel(profile.id, channel.id, { whatsappBusiness }),
              'Meta credentials saved. Complete manual subscriptions in Meta before testing delivery.',
            )
          }
        />
      )}
      <ChannelSwitches
        channel={channel}
        actions={actions}
        {...(channel.type === 'api'
          ? {}
          : {
              onEditMessages: () => {
                setRound((count) => count + 1);
                setWording(true);
              },
            })}
      />
      {!pending && <ChannelContacts channel={channel} actions={actions} />}
      <div className="flex items-center gap-2">
        <Action
          tone="danger"
          className="bg-bad/10"
          disabled={busy}
          onClick={() => onDisconnect(channel)}
        >
          Disconnect
        </Action>
        {channel.type === 'whatsapp' && (
          <Action tone="outline" onClick={() => onPair(channel)}>
            Pair device
          </Action>
        )}
        <span className="flex-1" />
        <Action tone="quiet" onClick={close}>
          Close
        </Action>
        {pending && (
          <Action tone="primary" type="submit" form={credentials} busy={busy}>
            Complete setup
          </Action>
        )}
      </div>
      {channel.type !== 'api' && (
        <ChannelMessagesDialog
          open={wording}
          onOpenChange={setWording}
          round={round}
          channel={channel}
          actions={actions}
        />
      )}
    </div>
  );
}
