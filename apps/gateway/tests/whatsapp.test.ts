import { randomBytes } from 'node:crypto';
import type { InlineMedia } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { IncomingMessage } from '../src/channels/channel.js';
import { ChannelRegistry } from '../src/channels/registry.js';
import { Channels } from '../src/channels/service.js';
import { WhatsAppChannel } from '../src/channels/whatsapp/adapter.js';
import { WhatsAppConnections } from '../src/channels/whatsapp/connections.js';
import type {
  DeviceCallbacks,
  DeviceFactory,
  DeviceSessionStore,
} from '../src/channels/whatsapp/types.js';
import { Media } from '../src/media/service.js';
import { SecretBox } from '../src/security/crypto.js';
import { authRow, connectionRow, pendingInbox } from './helpers/rows.js';
import { testServices } from './helpers/services.js';

const actorId = '5511999999999@c.us';
const token = 'synthetic-whatsapp-admin-token-32-characters';
const admin = { authorization: `Bearer ${token}` };
const message: IncomingMessage = {
  actorId,
  chatId: actorId,
  text: 'Hello',
  requestKey: 'wa-message-one',
  scope: 'direct',
  mentions: [],
};

async function setup(send?: (chatId: string, text: string) => Promise<string>) {
  let now = Date.now();
  const services = await testServices();
  const store = services.store;
  const box = new SecretBox({ activeKeyId: 'v1', keys: { v1: randomBytes(32) } });
  const devices: Array<{ callbacks: DeviceCallbacks; store: DeviceSessionStore }> = [];
  const sent: Array<{ chatId: string; text: string; media?: InlineMedia }> = [];

  const factory: DeviceFactory = async (_id, sessionStore, callbacks) => {
    devices.push({ callbacks, store: sessionStore });

    return {
      start: async () => {},
      send: async (chatId, text, _signal, media) => {
        sent.push({ chatId, text, ...(media ? { media } : {}) });
        return send ? send(chatId, text) : `wa-sent-${sent.length}`;
      },
      typing: async () => {},
      stop: async () => {},
    };
  };

  const connection = () => new WhatsAppConnections(store, box, factory, () => now);
  const whatsapp = connection();
  const registry = new ChannelRegistry([new WhatsAppChannel(whatsapp)]);
  const channels = new Channels(services, fetch, registry);
  const receive = (id: string, input: typeof message, generation: number) =>
    channels.receiveLinked(id, input, generation);
  const profile = await services.profiles.createProfile({
    name: 'WhatsApp',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const binding = await channels.connect(profile.id, { type: 'whatsapp' });
  const app = createApp({ ...services, channels, whatsapp, token, logger: false });
  const base = `/v1/profiles/${profile.id}/channels/${binding.id}`;

  return {
    services,
    store,
    devices,
    sent,
    whatsapp,
    channels,
    receive,
    profile,
    binding,
    app,
    base,
    connection,
    approve: async (sender = actorId) => {
      const contact = (await channels.contacts(profile.id)).find((item) => item.actorId === sender);

      if (!contact) throw new Error('Contact request missing');

      return channels.approveContact(profile.id, contact.id);
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('WhatsApp linked device', () => {
  it('restricts linking and short-lived QR codes to the host token without exposing secrets in status', async () => {
    const f = await setup();

    try {
      const restricted = { authorization: `Bearer ${token}-wrong` };
      expect(
        (await f.app.inject({ method: 'POST', url: `${f.base}/connect`, headers: restricted }))
          .statusCode,
      ).toBe(401);
      expect(
        (await f.app.inject({ method: 'POST', url: `${f.base}/connect`, headers: admin }))
          .statusCode,
      ).toBe(202);

      await f.whatsapp.tick(f.receive);
      await f.devices[0]?.callbacks.qr('synthetic-sensitive-qr');

      expect(JSON.stringify(await connectionRow(f.store, f.binding.id))).not.toContain(
        'synthetic-sensitive-qr',
      );
      const qr = await f.app.inject({ url: `${f.base}/qr`, headers: admin });
      expect(qr.statusCode).toBe(200);
      expect(qr.headers['cache-control']).toBe('no-store');
      expect(qr.json().qr).toBe('synthetic-sensitive-qr');
      expect((await f.app.inject({ url: `${f.base}/qr`, headers: restricted })).statusCode).toBe(
        401,
      );

      const status = await f.app.inject({ url: `${f.base}/connection`, headers: admin });
      expect(status.json().status).toBe('qr');
      expect(status.body).not.toContain('synthetic-sensitive-qr');
      expect(status.body).not.toContain('ciphertext');

      f.advance(46_000);
      expect((await f.app.inject({ url: `${f.base}/qr`, headers: admin })).statusCode).toBe(409);
      await expect(
        f.whatsapp.status(randomBytes(16).toString('hex'), f.binding.id),
      ).rejects.toThrow('Channel not found');
    } finally {
      await f.whatsapp.stop();
      await f.app.close();
    }
  });

  it('persists encrypted device sessions across workers and fences late saves after disconnect', async () => {
    const f = await setup();
    const replacement = f.connection();

    try {
      await f.whatsapp.connect(f.profile.id, f.binding.id);
      await f.whatsapp.tick(f.receive);
      const original = f.devices[0];
      if (!original) throw new Error('Device missing');
      const archive = Buffer.from('synthetic-device-secret:'.repeat(30_000));
      await original.store.save(archive);
      expect(JSON.stringify(await authRow(f.store, f.binding.id))).not.toContain(
        'synthetic-device-secret',
      );

      await f.whatsapp.stop();
      await replacement.tick(f.receive);
      const restored = f.devices[1];
      if (!restored) throw new Error('Restored device missing');
      expect(await restored.store.load()).toEqual(archive);
      await expect(original.store.save(Buffer.from('stale'))).rejects.toThrow(
        'Device ownership expired',
      );

      await replacement.disconnect(f.profile.id, f.binding.id);
      await expect(restored.store.save(archive)).rejects.toThrow('Device ownership expired');
      await expect(restored.callbacks.qr('late-qr')).rejects.toThrow('Device ownership expired');
      expect((await authRow(f.store, f.binding.id))?.chunks).toEqual([]);
      expect((await replacement.status(f.profile.id, f.binding.id)).status).toBe('disconnected');

      await replacement.connect(f.profile.id, f.binding.id);
      await replacement.tick(f.receive);
      const latest = f.devices.at(-1);
      if (!latest) throw new Error('Device missing');
      await latest.store.save(archive);
      await f.channels.revoke(f.profile.id, f.binding.id);
      await expect(latest.store.save(archive)).rejects.toThrow('Device ownership expired');
      expect((await authRow(f.store, f.binding.id))?.chunks).toEqual([]);
    } finally {
      await replacement.stop();
      await f.app.close();
    }
  });

  it('turns an approved contact into its own session and sends each result once', async () => {
    const f = await setup();
    const stranger = '5511000000000@c.us';

    try {
      await f.whatsapp.connect(f.profile.id, f.binding.id);
      await f.whatsapp.tick(f.receive);
      const callbacks = f.devices[0]?.callbacks;
      if (!callbacks) throw new Error('Device missing');
      await callbacks.ready('5511888888888@c.us');
      await callbacks.message({
        ...message,
        actorId: stranger,
        chatId: stranger,
        requestKey: 'wa-stranger',
      });
      await callbacks.message(message);
      await callbacks.message(message);
      await callbacks.message({ ...message, text: 'Next', requestKey: 'wa-message-two' });
      await f.whatsapp.tick(f.receive);

      // Nobody is known yet: two senders, two requests, and no session or run in the profile.
      expect(await f.channels.contacts(f.profile.id)).toHaveLength(2);
      expect(await f.services.sessions.sessions(f.profile.id)).toEqual([]);
      expect(await f.services.runs.activities(f.profile.id)).toEqual([]);

      const contact = await f.approve();
      const [first] = await f.services.runs.activities(f.profile.id);
      if (!first) throw new Error('Run missing');
      expect(first.sessionId).toBe(contact.sessionId);
      expect(first.input).toBe('Hello\n\nNext');
      expect((await f.services.sessions.sessions(f.profile.id))[0]?.title).toContain(actorId);

      await f.services.lifecycle.claim(first.id, f.profile.id, 'worker');
      await f.services.lifecycle.finish(
        f.profile.id,
        first.id,
        'worker',
        'completed',
        'First answer',
      );
      await Promise.all([f.channels.dispatch(), f.channels.dispatch()]);

      expect(f.sent.filter((item) => item.text === 'First answer')).toEqual([
        { chatId: actorId, text: 'First answer' },
      ]);
      expect(f.sent.filter((item) => item.chatId === stranger)).toHaveLength(1);
      expect(
        (await f.channels.deliveries(f.profile.id)).find((item) => item.runId === first.id)
          ?.remoteMessageIds,
      ).toHaveLength(1);

      await callbacks.message({ ...message, text: 'Later', requestKey: 'wa-message-three' });
      await f.whatsapp.tick(f.receive);
      expect(await pendingInbox(f.store)).toHaveLength(0);
      const [second] = await f.services.runs.activities(f.profile.id);
      if (!second) throw new Error('Second run missing');
      expect(second.input).toBe('Later');

      await f.whatsapp.disconnect(f.profile.id, f.binding.id);
      await f.whatsapp.connect(f.profile.id, f.binding.id);
      await f.whatsapp.tick(f.receive);
      await f.devices.at(-1)?.callbacks.ready('different-account');
      await f.services.lifecycle.claim(second.id, f.profile.id, 'worker');
      await f.services.lifecycle.finish(
        f.profile.id,
        second.id,
        'worker',
        'completed',
        'Old account reply',
      );
      await f.channels.dispatch();
      expect(f.sent.some((item) => item.text === 'Old account reply')).toBe(false);
      expect(
        (await f.channels.deliveries(f.profile.id)).find((item) => item.runId === second.id)
          ?.status,
      ).toBe('failed');

      await expect(
        f.channels.receive(f.binding.id, {
          type: 'whatsapp',
          headers: { 'x-jian-channel-token': f.binding.webhookToken },
          payload: message,
        }),
      ).rejects.toThrow('does not accept webhooks');
    } finally {
      await f.whatsapp.stop();
      await f.app.close();
    }
  });

  it('allows only the current worker to send after an expired connection lease is claimed', async () => {
    const f = await setup();
    const other = f.connection();

    try {
      await f.whatsapp.connect(f.profile.id, f.binding.id);
      await f.whatsapp.tick(f.receive);
      await f.devices[0]?.callbacks.ready('account');
      await other.tick(f.receive);
      expect(await other.canSend(f.binding.id)).toBe(false);
      expect(await f.whatsapp.canSend(f.binding.id)).toBe(true);

      f.advance(31_000);
      await other.tick(f.receive);
      expect(await f.whatsapp.canSend(f.binding.id)).toBe(false);
      expect(await other.canSend(f.binding.id)).toBe(false);
      await f.devices[1]?.callbacks.ready('account');
      expect(await other.canSend(f.binding.id)).toBe(true);
      await expect(f.devices[0]?.callbacks.message(message)).rejects.toThrow(
        'Device ownership expired',
      );
    } finally {
      await f.whatsapp.stop();
      await other.stop();
      await f.app.close();
    }
  });

  it('does not replay an uncertain outbound WhatsApp message', async () => {
    const f = await setup(async () => {
      throw new Error('Remote write succeeded but confirmation was lost');
    });

    try {
      await f.whatsapp.connect(f.profile.id, f.binding.id);
      await f.whatsapp.tick(f.receive);
      await f.devices[0]?.callbacks.ready('account');
      await f.devices[0]?.callbacks.message(message);
      await f.whatsapp.tick(f.receive);
      await f.approve();
      const [run] = await f.services.runs.activities(f.profile.id);
      if (!run) throw new Error('Run missing');
      await f.services.lifecycle.claim(run.id, f.profile.id, 'worker');
      await f.services.lifecycle.finish(f.profile.id, run.id, 'worker', 'completed', 'Answer');
      await f.channels.dispatch();
      await f.channels.dispatch();

      expect(f.sent.filter((item) => item.text === 'Answer')).toHaveLength(1);
      expect(
        (await f.channels.deliveries(f.profile.id)).find((item) => item.runId === run.id)?.status,
      ).toBe('unknown');
    } finally {
      await f.whatsapp.stop();
      await f.app.close();
    }
  });
});

describe('deleting a profile with a live WhatsApp connection', () => {
  it('closes the linked device even when the worker only learns of it through the database', async () => {
    // Two independent `WhatsAppConnections` stand in for the API and worker running as
    // separate processes: they share nothing but the store, exactly as they would over a real
    // network. The API side never touches `worker`'s in-memory device map directly — the only
    // channel between them is what each can read back from Postgres.
    const services = await testServices();
    const box = new SecretBox({ activeKeyId: 'v1', keys: { v1: randomBytes(32) } });
    const sockets: Array<{ channelId: string; open: boolean }> = [];

    const factory: DeviceFactory = async (id) => {
      // A real external effect a test can observe without reading `WhatsAppConnections`'s own
      // bookkeeping: whether this device's socket considers itself open.
      const socket = { channelId: id, open: true };
      sockets.push(socket);

      return {
        start: async () => {},
        send: async () => 'wa-sent',
        typing: async () => {},
        stop: async () => {
          socket.open = false;
        },
      };
    };

    const worker = new WhatsAppConnections(services.store, box, factory);
    const registry = new ChannelRegistry([new WhatsAppChannel(worker)]);
    const channels = new Channels(services, fetch, registry);
    services.profiles.useBeforeDelete((profileId, tx) => channels.revokeAll(profileId, tx));

    const profile = await services.profiles.createProfile({
      name: 'WhatsApp',
      instructions: 'Help.',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    });
    const binding = await channels.connect(profile.id, { type: 'whatsapp' });

    try {
      await worker.connect(profile.id, binding.id);
      await worker.tick(async () => undefined);

      const socket = sockets.find((item) => item.channelId === binding.id);
      if (!socket) throw new Error('Device missing');
      expect(socket.open).toBe(true);
      expect(await worker.canSend(binding.id)).toBe(false); // not "ready" yet, but the device exists

      // The delete runs on the API side, through the profile's own transaction — the worker
      // does not observe it until its next poll, exactly as two processes would behave.
      await services.profiles.deleteProfile(profile.id);
      expect(socket.open).toBe(true); // the cascade already ran; the worker has not polled yet

      await worker.tick(async () => undefined);

      // The channel row is gone with the profile, so the worker can no longer find this
      // connection through `listConnections()` — the external effect proves the device was
      // still told to stop despite that.
      expect(socket.open).toBe(false);
      expect(await worker.canSend(binding.id)).toBe(false);
    } finally {
      await worker.stop();
    }
  });
});

it.each(['image', 'speech'] as const)(
  'delivers generated %s to WhatsApp once without substituting a text link',
  async (kind) => {
    const f = await setup();
    try {
      await f.whatsapp.connect(f.profile.id, f.binding.id);
      await f.whatsapp.tick(f.receive);
      await f.devices[0]?.callbacks.ready('5511888888888@c.us');
      await f.devices[0]?.callbacks.message(message);
      await f.whatsapp.tick(f.receive);
      await f.approve();
      const provider = await f.services.providers.createProvider({
        name: 'OpenAI',
        kind: 'openai',
        secret: 'synthetic-openai-media-key-1234567890',
      });
      await f.services.providers.setModelDefaults(f.profile.id, {
        [kind]: {
          providerId: provider.id,
          modelId: kind === 'image' ? 'gpt-image-2' : 'gpt-4o-mini-tts',
        },
      });
      let requests = 0;
      f.services.media = new Media(
        f.store,
        f.services.providers,
        f.services.gatewayVault,
        async () => {
          requests++;
          return kind === 'image'
            ? Response.json({ data: [{ b64_json: Buffer.from('png fixture').toString('base64') }] })
            : new Response('OggS synthetic fixture');
        },
      );
      const [run] = await f.services.runs.recent(f.profile.id);
      if (!run) throw new Error('Missing run');
      const first = await f.services.media.generate(run, kind, 'Hello', undefined, 'media-call');
      expect(
        await f.services.media.generate(run, kind, 'Hello', undefined, 'media-call'),
      ).toMatchObject({ mediaId: first.mediaId });
      await f.channels.dispatch();
      await f.channels.dispatch();
      expect(requests).toBe(1);
      const mediaMessages = f.sent.filter((message) => message.media);
      expect(mediaMessages).toHaveLength(1);
      expect(mediaMessages[0]?.media?.mimeType).toBe(kind === 'image' ? 'image/png' : 'audio/ogg');
      expect(mediaMessages[0]?.chatId).toBe(actorId);
      expect(
        (await f.channels.deliveries(f.profile.id)).find(
          (delivery) => delivery.mediaId === first.mediaId,
        )?.status,
      ).toBe('sent');
    } finally {
      await f.whatsapp.stop();
      await f.app.close();
    }
  },
);
