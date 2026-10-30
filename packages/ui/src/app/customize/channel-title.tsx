'use client';

import { useQuery } from '@tanstack/react-query';
import { Terminal } from 'lucide-react';
import type { ReactNode } from 'react';
import { kindName } from '../../components/channels/connect';
import { TelegramLogo, WhatsAppLogo } from '../../components/ui';
import { StatusPill } from '../../kit';
import type { Channel, ChannelType, GatewayApi } from '../../lib/api';
import { keys } from '../../lib/query/keys';

/** A channel's mark: its app's logo, or a terminal for the owner's own systems. */
function ChannelMark({ type }: { type: ChannelType }) {
  if (type === 'telegram') return <TelegramLogo size={15} />;
  if (type === 'api') return <Terminal size={15} className="text-muted" aria-hidden="true" />;
  return <WhatsAppLogo size={15} />;
}

/** A channel's name with its mark before it. */
export function ChannelTitle({ type }: { type: ChannelType }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ChannelMark type={type} />
      <span className="truncate">{kindName(type)}</span>
    </span>
  );
}

/**
 * Whether a WhatsApp device is linked, read once as the page shows it. Pairing reads the same
 * entry every few seconds, so a line follows the pairing it opened without asking again.
 */
export function useDevice(api: GatewayApi, profileId: string, channel: Channel) {
  return useQuery({
    queryKey: keys.channelConnection(profileId, channel.id),
    queryFn: () => api.connection(profileId, channel.id),
    enabled: channel.type === 'whatsapp',
    retry: false,
  }).data;
}

type Device = ReturnType<typeof useDevice>;

/** How the device stands, in a pill; nothing while it is not known. */
function devicePill(device: Device): ReactNode {
  if (!device) return null;
  if (device.status === 'connected') return <StatusPill tone="good">Connected</StatusPill>;
  if (device.status === 'connecting') return <StatusPill>Connecting</StatusPill>;
  if (device.status === 'error') return <StatusPill tone="bad">Connection failed</StatusPill>;
  return <StatusPill tone="warn">Needs pairing</StatusPill>;
}

/**
 * How a channel stands, in pills: linked or set up, paused, and how many wait on the owner. Meta's
 * is set up in two steps, and only the second makes it work.
 */
export function ChannelPills({
  channel,
  device,
  waiting,
}: {
  channel: Channel;
  device: Device;
  waiting: number;
}) {
  return (
    <>
      {channel.type === 'whatsapp' ? (
        devicePill(device)
      ) : channel.type === 'whatsapp-business' ? (
        channel.whatsappBusinessStatus === 'pending' ? (
          <StatusPill tone="warn">Setup pending</StatusPill>
        ) : (
          <StatusPill tone="good">Configured</StatusPill>
        )
      ) : (
        <StatusPill tone="good">Connected</StatusPill>
      )}
      {channel.enabled === false && <StatusPill>Paused</StatusPill>}
      {waiting > 0 && <StatusPill tone="warn">{waiting} waiting</StatusPill>}
    </>
  );
}
