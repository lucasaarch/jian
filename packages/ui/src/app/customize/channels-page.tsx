'use client';

import { Plus } from 'lucide-react';
import { useState } from 'react';
import {
  connectChannel,
  connectedMessage,
  type IngressSecret,
  kindName,
} from '../../components/channels/connect';
import { waitingOn } from '../../components/channels/contacts';
import { kinds } from '../../components/channels/kinds';
import {
  Action,
  ConfirmDialog,
  SettingsGroup,
  SettingsRow,
  SettingsRowSkeleton,
  SkeletonRegion,
} from '../../kit';
import type { Channel, GatewayApi, NewChannel } from '../../lib/api';
import { useAgent, useChannels, useContacts } from '../../lib/query/agent';
import { useActions } from '../../lib/workspace';
import { ChannelAddDialog } from './channel-add-dialog';
import { ChannelDialog } from './channel-dialog';
import { ChannelPairing } from './channel-pairing';
import { ChannelSecretDialog } from './channel-secret-dialog';
import { ChannelPills, ChannelTitle, useDevice } from './channel-title';

/** The channels while they are read: one connected, with how it stands, and the row that adds. */
export function ChannelsWaiting() {
  return (
    <SkeletonRegion label="Loading channels…" className="grid grid-cols-1">
      <SettingsGroup>
        <SettingsRowSkeleton pill />
        <SettingsRowSkeleton index={1} />
      </SettingsGroup>
    </SkeletonRegion>
  );
}

/**
 * The agent's channels, a line each — its app, how it stands, who waits on the owner — with
 * Configure, and the way to connect a kind it has none of. One channel of each kind per agent.
 * Disconnecting asks for the channel's name first.
 */
export function ChannelsPage() {
  const actions = useActions();
  const { api, mutate, busy } = actions;
  const profile = useAgent();
  const channels = useChannels();
  // In the kinds' order; a revoked channel is history, not a connection.
  const live = kinds.flatMap(
    (kind) => channels.find((item) => item.type === kind.type && !item.revokedAt) ?? [],
  );
  const available = kinds
    .filter((kind) => !live.some((item) => item.type === kind.type))
    .map((kind) => kind.type);
  // Each dialog keeps what it shows while it fades out, apart from whether it is open.
  const [configuring, setConfiguring] = useState<string>();
  const [configureOpen, setConfigureOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [round, setRound] = useState(0);
  const [pairing, setPairing] = useState<Channel>();
  const [pairingOpen, setPairingOpen] = useState(false);
  const [secret, setSecret] = useState<IngressSecret>();
  const [secretOpen, setSecretOpen] = useState(false);
  const [removing, setRemoving] = useState<Channel>();
  const [asking, setAsking] = useState(false);
  const configured = live.find((item) => item.id === configuring);

  const configure = (channel: Channel) => {
    setConfiguring(channel.id);
    setConfigureOpen(true);
  };
  const pair = (channel: Channel) => {
    setPairing(channel);
    setPairingOpen(true);
  };

  const connect = (request: NewChannel) => {
    let created: Channel | undefined;
    return mutate(async () => {
      created = await connectChannel(api, profile.id, request, {
        pairing: pair,
        secret: (next) => {
          setSecret(next);
          setSecretOpen(true);
        },
      });
    }, connectedMessage(request.type)).then((ok) => {
      // Meta's channel is half set up: its callback and the credentials to complete come next.
      if (ok && created?.type === 'whatsapp-business') configure(created);
      return ok;
    });
  };

  return (
    <>
      <SettingsGroup>
        {live.map((channel) => (
          <ChannelLine
            key={channel.id}
            api={api}
            channel={channel}
            onConfigure={() => configure(channel)}
          />
        ))}
        {available.length > 0 && (
          <SettingsRow
            title={live.length ? 'Add a channel' : 'No channels yet'}
            {...(live.length
              ? {}
              : { description: 'Take the conversation to where you already are.' })}
          >
            <Action
              tone="outline"
              size="small"
              onClick={() => {
                setRound((count) => count + 1);
                setAdding(true);
              }}
            >
              <Plus size={13} />
              Add
            </Action>
          </SettingsRow>
        )}
      </SettingsGroup>
      <ChannelDialog
        open={configureOpen && Boolean(configured)}
        onOpenChange={setConfigureOpen}
        channel={configured}
        actions={actions}
        onDisconnect={(channel) => {
          setRemoving(channel);
          setAsking(true);
        }}
        onPair={pair}
      />
      <ChannelAddDialog
        open={adding}
        onOpenChange={setAdding}
        round={round}
        available={available}
        busy={busy}
        connect={connect}
      />
      <ChannelPairing
        open={pairingOpen}
        onOpenChange={setPairingOpen}
        channel={pairing}
        profileId={profile.id}
        api={api}
      />
      <ChannelSecretDialog open={secretOpen} onOpenChange={setSecretOpen} secret={secret} />
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Disconnect ${removing ? kindName(removing.type) : ''}?`}
        phrase={removing ? kindName(removing.type) : ''}
        action="Disconnect"
        busy={busy}
        run={async () => {
          if (!removing) return;
          if (
            await mutate(() => api.revokeChannel(profile.id, removing.id), 'Channel disconnected.')
          ) {
            setAsking(false);
            setConfigureOpen(false);
          }
        }}
      >
        The channel stops receiving messages. Approved contacts and their conversations are kept.
      </ConfirmDialog>
    </>
  );
}

/** One channel, a line: its app, how it stands, and the way into its settings. */
function ChannelLine({
  api,
  channel,
  onConfigure,
}: {
  api: GatewayApi;
  channel: Channel;
  onConfigure: () => void;
}) {
  const profile = useAgent();
  const contacts = useContacts();
  const device = useDevice(api, profile.id, channel);
  const name = kindName(channel.type);

  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          <ChannelTitle type={channel.type} />
          <ChannelPills channel={channel} device={device} waiting={waitingOn(contacts, channel)} />
        </span>
      }
    >
      <Action tone="outline" size="small" aria-label={`Configure ${name}`} onClick={onConfigure}>
        Configure
      </Action>
    </SettingsRow>
  );
}
