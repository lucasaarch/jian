import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { ChannelRegistry } from '../src/channels/registry.js';
import { Channels } from '../src/channels/service.js';
import { MetaInbox } from '../src/channels/whatsapp-business-inbox.js';
import { channels, deliveries } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

it('keeps the shared outbox ticking while Meta intake waits on remote media', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Dispatcher',
    instructions: 'Help',
  });
  const channelId = randomUUID();
  await services.store.db.insert(channels).values({
    id: channelId,
    profileId: profile.id,
    type: 'telegram',
    webhookTokenHash: channelId,
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Models the unresolved media lookup/download inside durable intake. In particular,
  // the second delivery does not exist when intake starts or the first outbox tick runs.
  const drain = vi.spyOn(MetaInbox.prototype, 'drain').mockImplementation(() => held);
  const send = vi.fn(async () => ({ status: 'sent' as const, remoteMessageIds: ['synthetic'] }));
  const service = new Channels(
    services,
    vi.fn(),
    new ChannelRegistry([{ type: 'telegram', receive: () => null, send }]),
  );
  const queue = (notice: string) =>
    services.store.db.insert(deliveries).values({
      id: randomUUID(),
      profileId: profile.id,
      channelId,
      chatId: '42',
      status: 'pending',
      notice,
    });
  try {
    await queue('Before intake');
    service.start();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(drain).toHaveBeenCalledTimes(1);
    await queue('During intake');
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(drain).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
  } finally {
    release();
    await service.stop();
    drain.mockRestore();
    await services.store.close();
  }
});
