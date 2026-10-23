import { GatewayError } from '../core/errors.js';
import { ApiChannel } from './api.js';
import type { Channel, ChannelType } from './channel.js';
import { TelegramChannel } from './telegram.js';
import { WhatsAppBusinessChannel } from './whatsapp-business.js';

export class ChannelRegistry {
  private readonly adapters = new Map<ChannelType, Channel>();

  constructor(
    channels: readonly Channel[] = [
      new ApiChannel(),
      new TelegramChannel(),
      new WhatsAppBusinessChannel(),
    ],
  ) {
    for (const channel of channels) {
      if (this.adapters.has(channel.type)) {
        throw new Error(`Duplicate channel adapter: ${channel.type}`);
      }

      this.adapters.set(channel.type, channel);
    }
  }

  get(type: ChannelType): Channel {
    const channel = this.adapters.get(type);

    if (!channel) {
      throw new GatewayError(400, 'Channel type is not configured');
    }

    return channel;
  }
}
