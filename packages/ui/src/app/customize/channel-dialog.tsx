'use client';

import { useState } from 'react';
import { channelUrl, kindName } from '../../components/channels/connect';
import { waitingOn } from '../../components/channels/contacts';
import type { SectionActions } from '../../components/props';
import { Action, Overlay, OverlayActions } from '../../kit';
import type { Channel } from '../../lib/api';
import { useAgent, useContacts } from '../../lib/query/agent';
import { ChannelContacts } from './channel-contacts';
import { CopyLine, listBox } from './channel-copy-line';
import { ChannelMessagesDialog } from './channel-messages-dialog';
import { ChannelSwitches } from './channel-switches';
import { ChannelPills, ChannelTitle, useDevice } from './channel-title';

/** What reaching the channel's address takes, said under it. */
const addressNote: Partial<Record<Channel['type'], string>> = {
  telegram:
    'Jian registers it with Telegram as it connects, at JIAN_PUBLIC_URL when that is set. To change the bot token, disconnect and connect again.',
  api: 'Your systems post here with the token given when it was connected, in X-Jian-Channel-Token.',
  email:
    'Jian set up its delivery with the provider as it connected: a webhook in Resend, or a Worker and routing rule in Cloudflare. Mail whose sender domain passes neither DMARC nor DKIM is ignored. To change the key or the address, disconnect and connect again.',
};

/**
 * Everything about one channel: how it stands, its address, its switches and wording, who it
 * reaches and their approval, pairing a WhatsApp device again, and disconnecting it, which the page asks to confirm by name.
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
  const { api, busy } = actions;
  const profile = useAgent();
  const contacts = useContacts();
  const device = useDevice(api, profile.id, channel);
  const [wording, setWording] = useState(false);
  const [round, setRound] = useState(0);

  const summary =
    channel.type === 'whatsapp'
      ? device?.accountId
        ? `Linked to ${device.accountId}.`
        : 'A device paired to your WhatsApp.'
      : channel.type === 'telegram'
        ? 'A bot from BotFather.'
        : channel.type === 'email'
          ? 'Mail through your provider. Senders and actions are approved here, never by email.'
          : 'An HTTP endpoint for your own systems.';
  // Neither asks anything in its own words: approvals and questions are answered in the panel.
  const worded = channel.type !== 'api' && channel.type !== 'email';

  return (
    // One column as wide as the dialog: left to its content, a long address widens it.
    <div className="grid w-full grid-cols-1 gap-5 p-7">
      <header className="grid gap-1.5 pr-10">
        <h2 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
          <ChannelTitle type={channel.type} />
          <ChannelPills channel={channel} device={device} waiting={waitingOn(contacts, channel)} />
        </h2>
        <p className="text-sm leading-relaxed text-muted">{summary}</p>
      </header>
      {channel.type !== 'whatsapp' && (
        <div className="grid gap-2">
          <div className={listBox}>
            {channel.emailAddress && <CopyLine label="Address" value={channel.emailAddress} />}
            <CopyLine label="Webhook URL" value={channelUrl(channel)} />
          </div>
          <p className="px-1 text-xs leading-relaxed text-muted">{addressNote[channel.type]}</p>
        </div>
      )}
      <ChannelSwitches
        channel={channel}
        actions={actions}
        {...(!worded
          ? {}
          : {
              onEditMessages: () => {
                setRound((count) => count + 1);
                setWording(true);
              },
            })}
      />
      <ChannelContacts channel={channel} actions={actions} />
      <OverlayActions>
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
      </OverlayActions>
      {worded && (
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
