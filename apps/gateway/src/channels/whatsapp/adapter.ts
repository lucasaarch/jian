import { ingressSchema } from '@jian/contracts';
import type { Channel, DeliveryContext, OutgoingMessage } from '../channel.js';
import type { WhatsAppConnections } from './connections.js';

export class WhatsAppChannel implements Channel {
  readonly type = 'whatsapp';

  constructor(private readonly connections: WhatsAppConnections) {}

  receive(payload: unknown) {
    return ingressSchema.parse(payload);
  }

  canSend(channelId: string) {
    return this.connections.canSend(channelId);
  }

  typing(chatId: string, context: DeliveryContext) {
    return this.connections.typing(context.channelId, chatId, context.connectionGeneration);
  }

  avatar(
    target: { chatId: string; actorId: string; scope: 'direct' | 'group' },
    context: DeliveryContext,
  ) {
    return this.connections.avatar(
      context.channelId,
      target.scope === 'group' ? target.chatId : target.actorId,
    );
  }

  send(message: OutgoingMessage, context: DeliveryContext) {
    return this.connections.send(
      context.channelId,
      message,
      context.signal,
      context.connectionGeneration,
    );
  }
}
