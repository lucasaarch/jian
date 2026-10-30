import { toast } from 'sonner';
import type { Channel, ChannelType, GatewayApi, NewChannel } from '../../lib/api';
import { gatewayOrigin } from '../../platform/gateway';
import { kinds } from './kinds';

/** An API server's callers are senders of the owner's systems, not people's contacts. */
export const admitsAll = (type: ChannelType) =>
  type === 'api' ? 'Allow all senders' : 'Allow all contacts';

/** The name the panel gives a channel's kind. */
export const kindName = (type: ChannelType) => kinds.find((kind) => kind.type === type)?.name ?? '';

/**
 * Where the outside world posts to a channel: Telegram and Meta at their own paths, an API
 * server at the ingress. The gateway's public origin, since that is what they must reach.
 */
export const channelUrl = (channel: Pick<Channel, 'id' | 'type'>) =>
  channel.type === 'telegram'
    ? `${gatewayOrigin()}/v1/telegram/${channel.id}`
    : channel.type === 'whatsapp-business'
      ? `${gatewayOrigin()}/v1/whatsapp-business/${channel.id}`
      : `${gatewayOrigin()}/v1/ingress/${channel.id}`;

/** What an API server's callers send to: its address and its token, shown only once. */
export type IngressSecret = { url: string; token: string };

/** Said once a channel is created: Meta's is a callback waiting for its credentials. */
export const connectedMessage = (type: ChannelType) =>
  type === 'whatsapp-business'
    ? 'Meta callback created. Setup pending: register the webhook in Meta, then complete credentials here.'
    : `${kindName(type)} connected.`;

/**
 * Creates a channel and does what connecting means for its kind: WhatsApp starts pairing at
 * once, a webhook Telegram refused is said with what fixes it, and an API server's token is
 * handed back to be shown the only time it can be. Resolves to the new channel; throws when the
 * gateway refuses, for the caller's `mutate` to say.
 */
export async function connectChannel(
  api: GatewayApi,
  profileId: string,
  request: NewChannel,
  then: {
    /** The channel exists: what was typed for it is no longer needed. */
    created?: () => void;
    pairing: (channel: Channel) => void;
    secret: (secret: IngressSecret) => void;
  },
) {
  const channel = await api.createChannel(profileId, request);

  then.created?.();

  if (channel.type === 'whatsapp') {
    // Connecting WhatsApp is reading the QR: the device starts pairing right away.
    await api.connect(profileId, channel.id);
    then.pairing(channel);
  } else if (channel.type === 'telegram') {
    // Jian points the bot at itself; only a refusal is worth the owner's attention, and what
    // fixes it is the public address, not a secret to paste somewhere by hand.
    if (channel.webhookRegistered === false)
      toast.error(
        `${channel.webhookError ?? 'Telegram refused the webhook.'} Set JIAN_PUBLIC_URL to the gateway's public HTTPS address, then disconnect and connect again.`,
        { duration: 20_000 },
      );
  } else if (channel.type === 'api' && !channel.webhookRegistered) {
    then.secret({ url: channelUrl(channel), token: channel.webhookToken });
  }

  return channel;
}
