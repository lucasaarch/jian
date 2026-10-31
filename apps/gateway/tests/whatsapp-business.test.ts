import { createHmac } from 'node:crypto';
import { channelInputSchema, channelPatchSchema } from '@jian/contracts';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { Channels } from '../src/channels/service.js';
import {
  META_MEDIA_LIMIT,
  META_WINDOW_MS,
  metaMediaUrl,
  metaSignature,
  opusMono,
  WhatsAppBusinessChannel,
  windowOpen,
} from '../src/channels/whatsapp-business.js';
import { metaCanSend } from '../src/channels/whatsapp-business-inbox.js';
import { Errands } from '../src/errands/service.js';
import {
  mediaAssets,
  metaBindings,
  metaInbox,
  metaReceipts,
  metaWindows,
  schedules,
} from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

const credentials = {
  accessToken: 'synthetic-meta-token',
  appSecret: 'synthetic-meta-app-secret',
  verifyToken: 'synthetic-meta-verify',
  phoneNumberId: '12345',
  businessAccountId: '67890',
};
const sign = (body: string) =>
  `sha256=${createHmac('sha256', credentials.appSecret).update(body).digest('hex')}`;
const message = (id: string, text = 'Hello', timestamp = Date.now()) => ({
  id,
  from: '15550000001',
  timestamp: String(Math.floor(timestamp / 1000)),
  type: 'text',
  text: { body: text },
});
const batch = (
  messages: unknown[],
  phone = credentials.phoneNumberId,
  account = credentials.businessAccountId,
  statuses: unknown[] = [],
) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: account,
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: phone },
            contacts: [{ wa_id: '15550000001', profile: { name: 'Alex' } }],
            messages,
            statuses,
          },
        },
      ],
    },
  ],
});

async function setup(pending = false) {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Prototype',
    instructions: 'Help',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  let sends = 0;
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith('/12345?fields=id'))
      return Response.json({ id: credentials.phoneNumberId });
    if (String(url).includes('/phone_numbers?'))
      return Response.json({ data: [{ id: credentials.phoneNumberId }] });
    if (String(url).endsWith('/messages'))
      return Response.json({ messages: [{ id: `wamid.out.${++sends}` }] });
    throw new Error('Unexpected external request');
  });
  const channels = new Channels(services, fetcher);
  const channel = await channels.connect(profile.id, {
    type: 'whatsapp-business',
    whatsappBusiness: pending ? { verifyToken: credentials.verifyToken } : credentials,
  });
  const app = createApp({
    ...services,
    channels,
    token: 'synthetic-admin-token-at-least-32-characters',
    logger: false,
  });
  const post = (value: unknown, signature?: string) => {
    const payload = JSON.stringify(value);
    return app.inject({
      method: 'POST',
      url: `/v1/whatsapp-business/${channel.id}`,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature ?? sign(payload),
      },
      payload,
    });
  };
  return {
    services,
    profile,
    channel,
    channels,
    app,
    fetcher,
    post,
    close: async () => {
      await channels.stop();
      await app.close();
    },
  };
}

function ogg() {
  const bytes = Buffer.alloc(47);
  bytes.write('OggS');
  bytes[26] = 1;
  bytes[27] = 19;
  bytes.write('OpusHead', 28);
  bytes[36] = 1;
  bytes[37] = 1;
  return bytes;
}

const context = (fetcher: typeof fetch, canReply = async (_chat: string) => true) => ({
  channelId: 'channel',
  credential: JSON.stringify(credentials),
  fetch: fetcher,
  signal: new AbortController().signal,
  canReply,
});

const { verifyToken: _verifyToken, ...completion } = credentials;
const admin = { authorization: 'Bearer synthetic-admin-token-at-least-32-characters' };

describe('Meta automation controls', () => {
  const sends = (f: Awaited<ReturnType<typeof setup>>) =>
    f.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/messages'));

  it('allows new private contacts without changing existing pending or blocked decisions', async () => {
    const f = await setup();
    try {
      await f.post(batch([message('pending')]));
      await f.channels.dispatch();
      const [pending] = await f.channels.contacts(f.profile.id);
      if (!pending) throw new Error('Missing contact');
      await f.channels.update(f.profile.id, f.channel.id, { allowAllContacts: true });
      await f.post(batch([message('still-pending')]));
      await f.channels.dispatch();
      expect((await f.channels.contacts(f.profile.id))[0]?.status).toBe('pending');
      await f.channels.blockContact(f.profile.id, pending.id);
      await f.post(batch([message('blocked')]));
      await f.channels.dispatch();
      expect((await f.channels.contacts(f.profile.id))[0]?.status).toBe('blocked');
      await f.post(batch([{ ...message('new-private'), from: '15550000002' }]));
      await f.channels.dispatch();
      const approved = (await f.channels.contacts(f.profile.id)).find(
        (c) => c.chatId === '15550000002',
      );
      expect(approved).toMatchObject({ status: 'approved', aiEnabled: true });
      expect(approved?.sessionId).toBeDefined();
      expect(await f.services.runs.activities(f.profile.id)).toHaveLength(1);
      expect(sends(f)).toHaveLength(1); // Only the initial approval notice, never one for the new contact.
    } finally {
      await f.close();
    }
  });

  it('pauses a channel without losing credentials/callback and never replays its inbox on resume', async () => {
    const f = await setup();
    try {
      const secret = await f.services.vault.read(f.profile.id, `channel:${f.channel.id}`);
      await f.post(batch([message('queued-before-pause')]));
      const paused = await f.channels.update(f.profile.id, f.channel.id, { enabled: false });
      expect(paused).toMatchObject({ enabled: false, whatsappBusinessStatus: 'configured' });
      expect(paused).not.toHaveProperty('automationPausedAt');
      const url = `/v1/whatsapp-business/${f.channel.id}?hub.mode=subscribe&hub.verify_token=${credentials.verifyToken}&hub.challenge=1234`;
      expect((await f.app.inject({ url })).body).toBe('1234');
      expect((await f.post(batch([message('during-pause')]))).statusCode).toBe(200);
      await f.channels.dispatch();
      expect(await f.channels.contacts(f.profile.id)).toHaveLength(0);
      expect(sends(f)).toHaveLength(0);
      await f.channels.update(f.profile.id, f.channel.id, { enabled: true });
      const restarted = new Channels(f.services, f.fetcher);
      try {
        await restarted.dispatch();
        expect(await restarted.contacts(f.profile.id)).toHaveLength(0);
        expect(await f.services.vault.read(f.profile.id, `channel:${f.channel.id}`)).toBe(secret);
        expect(await f.services.store.db.select().from(metaBindings)).toHaveLength(1);
        await f.post(batch([message('after-resume')]));
        await restarted.dispatch();
        expect(await restarted.contacts(f.profile.id)).toHaveLength(1);
        expect(sends(f)).toHaveLength(1);
      } finally {
        await restarted.stop();
      }
    } finally {
      await f.close();
    }
  });

  it('pauses AI for only one chat, cancels its run, and suppresses old replies even after resume', async () => {
    const f = await setup();
    try {
      await f.channels.update(f.profile.id, f.channel.id, { allowAllContacts: true });
      await f.post(batch([message('chat-a'), { ...message('chat-b'), from: '15550000002' }]));
      await f.channels.dispatch();
      const contacts = await f.channels.contacts(f.profile.id);
      const a = contacts.find((c) => c.chatId === '15550000001');
      const b = contacts.find((c) => c.chatId === '15550000002');
      if (!a || !b) throw new Error('Missing conversations');
      const initial = await f.services.runs.activities(f.profile.id);
      const runA = initial.find((run) => run.sessionId === a.sessionId);
      const runB = initial.find((run) => run.sessionId === b.sessionId);
      if (!runA || !runB) throw new Error('Missing runs');
      const paused = await f.channels.updateContact(f.profile.id, a.id, { aiEnabled: false });
      expect(paused).toMatchObject({
        status: 'approved',
        aiEnabled: false,
        sessionId: a.sessionId,
      });
      expect(paused).not.toHaveProperty('aiPausedAt');
      expect((await f.services.runs.run(f.profile.id, runA.id)).status).toBe('cancelled');
      expect((await f.services.runs.run(f.profile.id, runB.id)).status).toBe('queued');
      await f.post(batch([message('chat-a-off')]));
      expect(await metaCanSend(f.services.store.db, f.channel.id, a.chatId)).toBe(false);
      await f.channels.updateContact(f.profile.id, a.id, { aiEnabled: true });
      await f.channels.dispatch();
      expect(sends(f)).toHaveLength(0);
      expect(
        (await f.channels.deliveries(f.profile.id)).find((d) => d.runId === runA.id),
      ).toMatchObject({ status: 'failed' });
      await f.post(batch([message('chat-a-resumed')]));
      await f.channels.dispatch();
      expect(
        (await f.services.runs.activities(f.profile.id)).filter(
          (run) => run.sessionId === a.sessionId,
        ),
      ).toHaveLength(1);
      const fresh = (await f.services.runs.activities(f.profile.id)).find(
        (run) => run.sessionId === a.sessionId,
      );
      expect(fresh?.id).not.toBe(runA.id);
      expect((await f.channels.contacts(f.profile.id)).find((c) => c.id === b.id)?.aiEnabled).toBe(
        true,
      );
      if (!fresh) throw new Error('Missing resumed run');
      for (const run of [runB, fresh]) {
        await f.services.lifecycle.claim(run.id, f.profile.id, 'synthetic-worker');
        await f.services.lifecycle.finish(
          f.profile.id,
          run.id,
          'synthetic-worker',
          'completed',
          'Ready',
        );
      }
      await f.channels.dispatch();
      expect(sends(f)).toHaveLength(2);
    } finally {
      await f.close();
    }
  });

  it.each(['channel', 'chat'] as const)(
    'revalidates a %s pause/resume after model catalog work, before run insertion',
    async (scope) => {
      const f = await setup();
      let release!: () => void;
      let entered!: () => void;
      const began = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const warm = vi
        .spyOn(f.services.providers, 'warmCatalog')
        .mockImplementationOnce(async () => {
          entered();
          await gate;
        });
      try {
        await f.channels.update(f.profile.id, f.channel.id, { allowAllContacts: true });
        await f.post(batch([message('racing-pause')]));
        const dispatch = f.channels.dispatch();
        await began;
        if (scope === 'channel') {
          await f.channels.update(f.profile.id, f.channel.id, { enabled: false });
          await f.channels.update(f.profile.id, f.channel.id, { enabled: true });
        } else {
          const [contact] = await f.channels.contacts(f.profile.id);
          if (!contact) throw new Error('Missing contact');
          await f.channels.updateContact(f.profile.id, contact.id, { aiEnabled: false });
          await f.channels.updateContact(f.profile.id, contact.id, { aiEnabled: true });
        }
        release();
        await dispatch;
        expect(await f.services.runs.activities(f.profile.id)).toHaveLength(0);
        expect(sends(f)).toHaveLength(0);
        expect((await f.services.store.db.select().from(metaInbox))[0]?.processedAt).not.toBeNull();
        await f.post(batch([message('fresh-after-race')]));
        await f.channels.dispatch();
        expect(await f.services.runs.activities(f.profile.id)).toHaveLength(1);
      } finally {
        release();
        warm.mockRestore();
        await f.close();
      }
    },
  );

  it('revalidates a relayed errand answer under the submission lock after a chat pause', async () => {
    const f = await setup();
    let release!: () => void;
    let entered!: () => void;
    const began = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await f.channels.update(f.profile.id, f.channel.id, { allowAllContacts: true });
      await f.post(batch([message('relay-start')]));
      await f.channels.dispatch();
      const [contact] = await f.channels.contacts(f.profile.id);
      const [initial] = await f.services.runs.activities(f.profile.id);
      if (!contact || !initial) throw new Error('Missing initial conversation');
      await f.services.lifecycle.claim(initial.id, f.profile.id, 'worker');
      await f.services.lifecycle.finish(f.profile.id, initial.id, 'worker', 'completed', 'Ready');
      const owner = await f.services.sessions.createSession(f.profile.id, { title: 'Owner' });
      await f.services.store.transaction(f.profile.id, (tx) =>
        new Errands(f.services.store).open(tx, f.profile.id, contact, owner.id, 'Ready?'),
      );
      const warm = vi
        .spyOn(f.services.providers, 'warmCatalog')
        .mockImplementationOnce(async () => {
          entered();
          await gate;
        });
      try {
        await f.post(batch([message('relay-answer', 'Yes')]));
        const dispatch = f.channels.dispatch();
        await began;
        await f.channels.updateContact(f.profile.id, contact.id, { aiEnabled: false });
        await f.channels.updateContact(f.profile.id, contact.id, { aiEnabled: true });
        release();
        await dispatch;
        expect(await f.services.runs.activities(f.profile.id)).toHaveLength(0);
        expect(await f.services.sessions.messages(f.profile.id, owner.id)).toHaveLength(0);
      } finally {
        release();
        warm.mockRestore();
      }
    } finally {
      release?.();
      await f.close();
    }
  });

  it.each(['channel', 'chat'] as const)(
    'discards a late worker handoff after a %s pause, even when its parent had completed',
    async (scope) => {
      const f = await setup();
      try {
        await f.channels.update(f.profile.id, f.channel.id, { allowAllContacts: true });
        await f.post(batch([message('worker-start')]));
        await f.channels.dispatch();
        const [contact] = await f.channels.contacts(f.profile.id);
        const [parent] = await f.services.runs.activities(f.profile.id);
        if (!contact || !parent) throw new Error('Missing parent conversation');
        const child = await f.services.work.spawnInConversation(
          parent,
          {
            role: 'review',
            name: 'Reviewer',
            identity: 'Review.',
            brief: 'Review this task.',
          },
          'review',
        );
        await f.services.lifecycle.claim(parent.id, f.profile.id, 'parent');
        await f.services.lifecycle.finish(
          f.profile.id,
          parent.id,
          'parent',
          'completed',
          'Delegated.',
        );
        if (scope === 'channel') {
          await f.channels.update(f.profile.id, f.channel.id, { enabled: false });
          await f.channels.update(f.profile.id, f.channel.id, { enabled: true });
        } else {
          await f.channels.updateContact(f.profile.id, contact.id, { aiEnabled: false });
          await f.channels.updateContact(f.profile.id, contact.id, { aiEnabled: true });
        }
        await f.services.lifecycle.claim(child.runId, f.profile.id, 'child');
        await f.services.lifecycle.finish(
          f.profile.id,
          child.runId,
          'child',
          'completed',
          'Late report.',
        );
        f.services.work.useDeliveries(f.channels);
        await f.services.work.reportWorker(f.profile.id, child.runId);
        await f.services.work.reportWorker(f.profile.id, child.runId);
        await f.channels.dispatch();
        expect(await f.services.runs.activities(f.profile.id)).toHaveLength(0);
        expect(sends(f)).toHaveLength(0);
        const transcript = await f.services.sessions.messages(f.profile.id, parent.sessionId);
        expect(transcript.some((item) => item.content.includes('Late report.'))).toBe(false);
      } finally {
        await f.close();
      }
    },
  );

  it('clears held pre-pause messages and keeps paused messages out of contact history', async () => {
    const f = await setup();
    try {
      await f.post(batch([message('held-before', 'Held before pause')]));
      await f.channels.dispatch();
      const [contact] = await f.channels.contacts(f.profile.id);
      if (!contact) throw new Error('Missing contact');
      expect(contact.message).toBe('Held before pause');
      await f.channels.updateContact(f.profile.id, contact.id, { aiEnabled: false });
      await f.post(batch([message('ignored-while-off', 'Must not be replayed')]));
      await f.channels.updateContact(f.profile.id, contact.id, { aiEnabled: true });
      await f.channels.approveContact(f.profile.id, contact.id);
      await f.channels.dispatch();
      expect(await f.services.runs.activities(f.profile.id)).toHaveLength(0);
      expect((await f.channels.contacts(f.profile.id))[0]?.message).toBeUndefined();
      await f.post(batch([message('new-after', 'Only the new message')]));
      await f.channels.dispatch();
      const [fresh] = await f.services.runs.activities(f.profile.id);
      expect(fresh?.input).toBe('Only the new message');
    } finally {
      await f.close();
    }
  });

  it('requires host auth and ownership for controls and rejects coercion or mixed updates', async () => {
    const f = await setup();
    try {
      await f.post(batch([message('request')]));
      await f.channels.dispatch();
      const [contact] = await f.channels.contacts(f.profile.id);
      if (!contact) throw new Error('Missing contact');
      const other = await f.services.profiles.createProfile({
        name: 'Other',
        instructions: 'Help',
      });
      for (const [url, payload] of [
        [`/v1/profiles/${f.profile.id}/contacts/${contact.id}`, { aiEnabled: false }],
        [`/v1/profiles/${f.profile.id}/channels/${f.channel.id}`, { enabled: false }],
      ] as const) {
        for (const headers of [{}, { authorization: `Bearer ${f.channel.webhookToken}` }]) {
          expect((await f.app.inject({ method: 'PATCH', url, headers, payload })).statusCode).toBe(
            401,
          );
        }
        expect(
          (
            await f.app.inject({
              method: 'PATCH',
              url: url.replace(f.profile.id, other.id),
              headers: admin,
              payload,
            })
          ).statusCode,
        ).toBe(404);
        const key = 'aiEnabled' in payload ? 'aiEnabled' : 'enabled';
        expect(
          (
            await f.app.inject({
              method: 'PATCH',
              url,
              headers: admin,
              payload: { [key]: 'false' },
            })
          ).statusCode,
        ).toBe(400);
        expect(
          (
            await f.app.inject({
              method: 'PATCH',
              url,
              headers: admin,
              payload: { ...payload, status: 'approved' },
            })
          ).statusCode,
        ).toBe(400);
        expect(
          (await f.app.inject({ method: 'PATCH', url, headers: admin, payload })).statusCode,
        ).toBe(200);
      }
      await f.channels.revoke(f.profile.id, f.channel.id);
      await expect(
        f.channels.update(f.profile.id, f.channel.id, { enabled: true }),
      ).rejects.toThrow('disconnected');
      await expect(
        f.channels.updateContact(f.profile.id, contact.id, { aiEnabled: true }),
      ).rejects.toThrow('disconnected');
    } finally {
      await f.close();
    }
  });
});

describe('Meta staged setup', () => {
  it('accepts only a verify token or all credentials; completion cannot replace the verify token', () => {
    for (const key of Object.keys(completion)) {
      expect(
        channelInputSchema.safeParse({
          type: 'whatsapp-business',
          whatsappBusiness: {
            verifyToken: credentials.verifyToken,
            [key]: completion[key as keyof typeof completion],
          },
        }).success,
      ).toBe(false);
      const partial = { ...completion } as Record<string, string>;
      delete partial[key];
      expect(channelPatchSchema.safeParse({ whatsappBusiness: partial }).success).toBe(false);
    }
    expect(channelPatchSchema.safeParse({ whatsappBusiness: credentials }).success).toBe(false);
    expect(
      channelPatchSchema.safeParse({ whatsappBusiness: completion, allowAllContacts: true })
        .success,
    ).toBe(false);
    expect(channelPatchSchema.safeParse({}).success).toBe(false);
  });

  it('validates staged create and partial completion at the HTTP boundary', async () => {
    const f = await setup(true);
    try {
      const other = await f.services.profiles.createProfile({
        name: 'Other',
        instructions: 'Help',
      });
      const url = `/v1/profiles/${other.id}/channels`;
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url,
            headers: admin,
            payload: {
              type: 'whatsapp-business',
              whatsappBusiness: {
                verifyToken: credentials.verifyToken,
                accessToken: credentials.accessToken,
              },
            },
          })
        ).statusCode,
      ).toBe(400);
      const created = await f.app.inject({
        method: 'POST',
        url,
        headers: admin,
        payload: {
          type: 'whatsapp-business',
          whatsappBusiness: { verifyToken: credentials.verifyToken },
        },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().whatsappBusinessStatus).toBe('pending');
      expect(
        (
          await f.app.inject({
            method: 'PATCH',
            url: `${url}/${created.json().id}`,
            headers: admin,
            payload: { whatsappBusiness: { accessToken: credentials.accessToken } },
          })
        ).statusCode,
      ).toBe(400);
      expect(f.fetcher).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it('creates a stable callback before Graph credentials and only enables intake after completion', async () => {
    const f = await setup(true);
    try {
      const url = `/v1/whatsapp-business/${f.channel.id}?hub.mode=subscribe&hub.verify_token=${credentials.verifyToken}&hub.challenge=1234`;
      expect(f.channel.whatsappBusinessStatus).toBe('pending');
      expect(f.fetcher).not.toHaveBeenCalled();
      expect((await f.channels.list(f.profile.id))[0]?.whatsappBusinessStatus).toBe('pending');
      expect((await f.app.inject({ url })).body).toBe('1234');
      expect(
        (await f.app.inject({ url: url.replace(credentials.verifyToken, 'wrong') })).statusCode,
      ).toBe(401);
      expect((await f.post(batch([message('before')]))).statusCode).toBe(401);
      expect(await f.services.store.db.select().from(metaInbox)).toHaveLength(0);
      expect(await f.services.store.db.select().from(metaWindows)).toHaveLength(0);
      expect(await f.channels.contacts(f.profile.id)).toHaveLength(0);
      expect(await metaCanSend(f.services.store.db, f.channel.id, '15550000001')).toBe(false);
      const refused = await new WhatsAppBusinessChannel().send(
        { chatId: '15550000001', text: 'Not configured' },
        {
          ...context(f.fetcher, (chatId) => metaCanSend(f.services.store.db, f.channel.id, chatId)),
          credential: JSON.stringify({ verifyToken: credentials.verifyToken }),
        },
      );
      expect(refused.status).toBe('failed');
      expect(f.fetcher).not.toHaveBeenCalled();
      const response = await f.app.inject({
        method: 'PATCH',
        url: `/v1/profiles/${f.profile.id}/channels/${f.channel.id}`,
        headers: admin,
        payload: { whatsappBusiness: completion },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: f.channel.id,
        whatsappBusinessStatus: 'configured',
      });
      for (const secret of Object.values(credentials)) expect(response.body).not.toContain(secret);
      expect(
        JSON.parse(
          (await f.services.vault.read(f.profile.id, `channel:${f.channel.id}`)) ?? 'null',
        ),
      ).toEqual(credentials);
      expect((await f.app.inject({ url })).body).toBe('1234');
      expect((await f.channels.list(f.profile.id))[0]?.whatsappBusinessStatus).toBe('configured');
      expect((await f.post(batch([message('after')]))).statusCode).toBe(200);
      await f.channels.dispatch();
      expect(await f.channels.contacts(f.profile.id)).toHaveLength(1);
      expect(
        f.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/messages')),
      ).toHaveLength(1);
      await expect(
        f.channels.update(f.profile.id, f.channel.id, { whatsappBusiness: completion }),
      ).rejects.toThrow('already configured');
    } finally {
      await f.close();
    }
  });

  it('keeps the pending vault and callback on Graph refusal, network failure and duplicate number', async () => {
    const f = await setup(true);
    try {
      const original = await f.services.vault.read(f.profile.id, `channel:${f.channel.id}`);
      f.fetcher.mockResolvedValueOnce(new Response('', { status: 401 }));
      await expect(
        f.channels.update(f.profile.id, f.channel.id, { whatsappBusiness: completion }),
      ).rejects.toThrow('Meta refused');
      f.fetcher.mockRejectedValueOnce(new Error('synthetic network failure'));
      await expect(
        f.channels.update(f.profile.id, f.channel.id, { whatsappBusiness: completion }),
      ).rejects.toThrow('synthetic network failure');
      const other = await f.services.profiles.createProfile({
        name: 'Other',
        instructions: 'Help',
      });
      const otherChannel = await f.channels.connect(other.id, {
        type: 'whatsapp-business',
        whatsappBusiness: credentials,
      });
      await expect(
        f.channels.update(f.profile.id, f.channel.id, { whatsappBusiness: completion }),
      ).rejects.toThrow('already connected');
      expect(await f.services.vault.read(f.profile.id, `channel:${f.channel.id}`)).toBe(original);
      expect((await f.channels.list(f.profile.id))[0]?.whatsappBusinessStatus).toBe('pending');
      expect(await f.services.store.db.select().from(metaBindings)).toHaveLength(1);
      const url = `/v1/whatsapp-business/${f.channel.id}?hub.mode=subscribe&hub.verify_token=${credentials.verifyToken}&hub.challenge=1234`;
      expect((await f.app.inject({ url })).body).toBe('1234');
      await f.channels.revoke(other.id, otherChannel.id);
      expect(
        (await f.channels.update(f.profile.id, f.channel.id, { whatsappBusiness: completion }))
          .whatsappBusinessStatus,
      ).toBe('configured');
    } finally {
      await f.close();
    }
  });

  it('requires host authorization and profile ownership, rejects revoked setup and other channel types', async () => {
    const f = await setup(true);
    try {
      const url = `/v1/profiles/${f.profile.id}/channels/${f.channel.id}`;
      for (const headers of [{}, { authorization: `Bearer ${f.channel.webhookToken}` }]) {
        expect(
          (
            await f.app.inject({
              method: 'PATCH',
              url,
              headers,
              payload: { whatsappBusiness: completion },
            })
          ).statusCode,
        ).toBe(401);
      }
      const other = await f.services.profiles.createProfile({
        name: 'Other',
        instructions: 'Help',
      });
      expect(
        (
          await f.app.inject({
            method: 'PATCH',
            url: url.replace(f.profile.id, other.id),
            headers: admin,
            payload: { whatsappBusiness: completion },
          })
        ).statusCode,
      ).toBe(404);
      const api = await f.channels.connect(other.id, { type: 'api' });
      await expect(
        f.channels.update(other.id, api.id, { whatsappBusiness: completion }),
      ).rejects.toThrow('Only WhatsApp Business');
      expect(
        await f.channels.update(f.profile.id, f.channel.id, { allowAllContacts: true }),
      ).toMatchObject({ allowAllContacts: true });
      expect(f.fetcher).not.toHaveBeenCalled();
      await f.channels.revoke(f.profile.id, f.channel.id);
      await expect(
        f.channels.update(f.profile.id, f.channel.id, { whatsappBusiness: completion }),
      ).rejects.toThrow('disconnected');
      expect(await f.services.vault.read(f.profile.id, `channel:${f.channel.id}`)).toBeUndefined();
      expect(
        (
          await f.app.inject({
            url: `/v1/whatsapp-business/${f.channel.id}?hub.mode=subscribe&hub.verify_token=${credentials.verifyToken}&hub.challenge=1234`,
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await f.close();
    }
  });

  it('rolls back the binding when saving completed credentials fails', async () => {
    const f = await setup(true);
    const original = await f.services.vault.read(f.profile.id, `channel:${f.channel.id}`);
    const put = vi.spyOn(f.services.vault, 'put').mockRejectedValueOnce(new Error('vault failure'));
    try {
      await expect(
        f.channels.update(f.profile.id, f.channel.id, { whatsappBusiness: completion }),
      ).rejects.toThrow('vault failure');
      expect(await f.services.store.db.select().from(metaBindings)).toHaveLength(0);
      expect(await f.services.vault.read(f.profile.id, `channel:${f.channel.id}`)).toBe(original);
      expect((await f.channels.list(f.profile.id))[0]?.whatsappBusinessStatus).toBe('pending');
      expect((await f.post(batch([message('rollback')]))).statusCode).toBe(401);
    } finally {
      put.mockRestore();
      await f.close();
    }
  });

  it('serializes revocation behind an in-flight completion and leaves no active credentials', async () => {
    const f = await setup(true);
    let release!: (response: Response) => void;
    const graph = new Promise<Response>((resolve) => {
      release = resolve;
    });
    f.fetcher.mockImplementationOnce(() => graph);
    try {
      const completing = f.channels.update(f.profile.id, f.channel.id, {
        whatsappBusiness: completion,
      });
      await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
      const revoking = f.channels.revoke(f.profile.id, f.channel.id);
      release(Response.json({ data: [{ id: credentials.phoneNumberId }] }));
      await Promise.all([completing, revoking]);
      expect(await f.services.store.db.select().from(metaBindings)).toHaveLength(0);
      expect(await f.services.vault.read(f.profile.id, `channel:${f.channel.id}`)).toBeUndefined();
      expect((await f.channels.list(f.profile.id))[0]?.revokedAt).toBeDefined();
      expect((await f.post(batch([message('revoked')]))).statusCode).toBe(401);
      await expect(
        f.channels.update(f.profile.id, f.channel.id, { whatsappBusiness: completion }),
      ).rejects.toThrow('disconnected');
    } finally {
      release(Response.json({ data: [{ id: credentials.phoneNumberId }] }));
      await f.close();
    }
  });

  it('serializes simultaneous completion without changing a configured binding', async () => {
    const f = await setup(true);
    try {
      const results = await Promise.allSettled([
        f.channels.update(f.profile.id, f.channel.id, { whatsappBusiness: completion }),
        f.channels.update(f.profile.id, f.channel.id, { whatsappBusiness: completion }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(await f.services.store.db.select().from(metaBindings)).toHaveLength(1);
      expect(f.fetcher).toHaveBeenCalledTimes(2);
    } finally {
      await f.close();
    }
  });
});

describe('Meta trust boundary and durable inbox', () => {
  it('requires separate credentials and never reads secrets back', async () => {
    expect(
      channelInputSchema.safeParse({ type: 'whatsapp-business', botToken: 'wrong' }).success,
    ).toBe(false);
    expect(
      channelInputSchema.safeParse({
        type: 'telegram',
        botToken: 'test',
        whatsappBusiness: credentials,
      }).success,
    ).toBe(false);
    const f = await setup();
    try {
      const metadata = JSON.stringify(await f.channels.list(f.profile.id));
      for (const secret of Object.values(credentials)) expect(metadata).not.toContain(secret);
      expect(metadata).toContain('whatsapp-business');
      expect(await f.services.vault.read(f.profile.id, `channel:${f.channel.id}`)).toBe(
        JSON.stringify(credentials),
      );
      const other = await f.services.profiles.createProfile({
        name: 'Other',
        instructions: 'Help',
      });
      await expect(
        f.channels.connect(other.id, { type: 'whatsapp-business', whatsappBusiness: credentials }),
      ).rejects.toThrow('already connected');
    } finally {
      await f.close();
    }
  });

  it('verifies the GET challenge, signed raw bytes, account, phone and revocation', async () => {
    const f = await setup();
    try {
      const url = `/v1/whatsapp-business/${f.channel.id}?hub.mode=subscribe&hub.verify_token=${credentials.verifyToken}&hub.challenge=1234`;
      expect((await f.app.inject({ url })).body).toBe('1234');
      expect(
        (await f.app.inject({ url: url.replace(credentials.verifyToken, 'wrong') })).statusCode,
      ).toBe(401);
      const payload = batch([message('wamid.in.1')]);
      expect((await f.post(payload, `sha256=${'0'.repeat(64)}`)).statusCode).toBe(401);
      expect((await f.post(payload, sign(`${JSON.stringify(payload)} `))).statusCode).toBe(401);
      expect((await f.post(batch([message('foreign')], '999'))).statusCode).toBe(403);
      expect(
        (await f.post(batch([message('foreign')], credentials.phoneNumberId, '999'))).statusCode,
      ).toBe(403);
      expect(await f.services.store.db.select().from(metaInbox)).toHaveLength(0);
      await f.channels.revoke(f.profile.id, f.channel.id);
      expect((await f.post(payload)).statusCode).toBe(401);
      expect((await f.app.inject({ url })).statusCode).toBe(401);
    } finally {
      await f.close();
    }
  });

  it('persists the whole batch before 200, survives service recreation, and deduplicates replays', async () => {
    const f = await setup();
    try {
      const payload = batch([message('wamid.in.1', 'First'), message('wamid.in.2', 'Second')]);
      expect((await f.post(payload)).statusCode).toBe(200);
      expect(await f.channels.contacts(f.profile.id)).toHaveLength(0);
      expect(await f.services.store.db.select().from(metaInbox)).toHaveLength(2);
      const restarted = new Channels(f.services, f.fetcher);
      await restarted.dispatch();
      const contacts = await restarted.contacts(f.profile.id);
      expect(contacts).toHaveLength(1);
      expect(contacts[0]?.status).toBe('pending');
      expect(contacts[0]?.message).toContain('First');
      expect(contacts[0]?.message).toContain('Second');
      const before = contacts[0]?.message;
      await f.post(payload);
      await restarted.dispatch();
      expect((await restarted.contacts(f.profile.id))[0]?.message).toBe(before);
      expect(
        f.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/messages')),
      ).toHaveLength(1);
      // A redelivery of an old message must not renew the reply window.
      await f.services.store.db
        .update(metaWindows)
        .set({ lastInbound: new Date(Date.now() - META_WINDOW_MS - 1) });
      await f.post(payload);
      expect(await metaCanSend(f.services.store.db, f.channel.id, '15550000001')).toBe(false);
      await restarted.stop();
    } finally {
      await f.close();
    }
  });

  it('keeps newer window state, ignores groups/statuses as turns, and blocks expired approval notices', async () => {
    const f = await setup();
    try {
      await f.post(
        batch([message('recent')], credentials.phoneNumberId, credentials.businessAccountId, [
          {
            id: 'wamid.unknown',
            status: 'delivered',
            timestamp: String(Math.floor(Date.now() / 1000)),
            recipient_id: '15550000001',
          },
        ]),
      );
      const [before] = await f.services.store.db.select().from(metaWindows);
      await f.post(
        batch([
          message('old', 'Old', Date.now() - 48 * 3600_000),
          { ...message('group'), group_id: '123' },
        ]),
      );
      const [after] = await f.services.store.db.select().from(metaWindows);
      expect(after?.lastInbound).toEqual(before?.lastInbound);
      await f.services.store.db
        .update(metaWindows)
        .set({ lastInbound: new Date(Date.now() - META_WINDOW_MS - 1) });
      await f.channels.dispatch();
      expect(
        f.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/messages')),
      ).toHaveLength(0);
      expect(await f.services.store.db.select().from(metaReceipts)).toHaveLength(1);
      expect(await f.channels.contacts(f.profile.id)).toHaveLength(1);
      expect((await f.channels.deliveries(f.profile.id))[0]?.status).toBe('failed');
    } finally {
      await f.close();
    }
  });

  it('handles delivery status without starting a run and ignores regressing receipts', async () => {
    const f = await setup();
    try {
      await f.post(batch([message('start')]));
      await f.channels.dispatch();
      const status = (state: string) => ({
        id: 'wamid.out.1',
        status: state,
        recipient_id: '15550000001',
        timestamp: String(Math.floor(Date.now() / 1000)),
      });
      await f.post(
        batch([], credentials.phoneNumberId, credentials.businessAccountId, [
          status('read'),
          status('sent'),
          status('failed'),
        ]),
      );
      await f.channels.dispatch();
      expect((await f.services.store.db.select().from(metaReceipts))[0]?.status).toBe('read');
      expect((await f.channels.deliveries(f.profile.id))[0]?.status).toBe('sent');
      expect(await f.channels.contacts(f.profile.id)).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
});

describe('Meta replay and send-boundary regression', () => {
  it('stages incoming audio in the shared media pipeline and binds it on approval', async () => {
    const f = await setup();
    try {
      const original = f.fetcher.getMockImplementation();
      const bytes = ogg();
      f.fetcher.mockImplementation(async (url, options) => {
        if (String(url).endsWith('/12345/media')) return Response.json({ id: '555' });
        if (String(url).endsWith('/333'))
          return Response.json({
            url: 'https://lookaside.fbsbx.com/media',
            file_size: bytes.length,
          });
        if (String(url).startsWith('https://lookaside.fbsbx.com/'))
          return new Response(new Uint8Array(bytes));
        if (!original) throw new Error('Fetcher missing');
        return original(url, options);
      });
      await f.post(
        batch([
          message('before-audio', 'First text'),
          { ...message('audio'), type: 'audio', audio: { id: '333' } },
        ]),
      );
      await f.channels.dispatch();
      const [pending] = await f.channels.contacts(f.profile.id);
      if (!pending) throw new Error('Contact missing');
      const [held] = await f.services.store.db.select().from(mediaAssets);
      expect(held?.mimeType).toBe('audio/ogg');
      expect(held?.contactId).toBe(pending.id);
      // Simulate a crash after accept committed contact/media intake but before processedAt.
      await f.services.store.db
        .update(metaInbox)
        .set({ processedAt: null, availableAt: new Date(0) });
      await f.channels.dispatch();
      expect(await f.services.store.db.select().from(mediaAssets)).toHaveLength(1);
      expect((await f.channels.contacts(f.profile.id))[0]?.message).toBe(pending.message);
      const approved = await f.channels.approveContact(f.profile.id, pending.id);
      const [bound] = await f.services.store.db.select().from(mediaAssets);
      expect(bound?.sessionId).toBe(approved.sessionId);
      const [run] = await f.services.runs.activities(f.profile.id);
      expect(run?.input).toContain(bound?.id);
      if (!run || !bound || !f.services.media) throw new Error('Media/run missing');
      // A same-session media tool is a causal reply, unlike cross-session tool output.
      await f.services.media.sendFile(run, { source: 'mediaId', mediaId: bound.id }, 'reply-audio');
      await f.channels.dispatch();
      const outbound = (await f.channels.deliveries(f.profile.id)).find((d) => d.mediaId);
      expect(outbound?.status).toBe('sent');
    } finally {
      await f.close();
    }
  });

  it('isolates profiles even when they share an app secret and message identifiers', async () => {
    const f = await setup();
    try {
      const original = f.fetcher.getMockImplementation();
      f.fetcher.mockImplementation(async (url, options) => {
        if (String(url).includes('/phone_numbers?'))
          return Response.json({ data: [{ id: credentials.phoneNumberId }, { id: '777' }] });
        if (String(url).endsWith('/777?fields=id')) return Response.json({ id: '777' });
        if (!original) throw new Error('Fetcher missing');
        return original(url, options);
      });
      const other = await f.services.profiles.createProfile({
        name: 'Other',
        instructions: 'Help',
      });
      const channel = await f.channels.connect(other.id, {
        type: 'whatsapp-business',
        whatsappBusiness: { ...credentials, phoneNumberId: '777' },
      });
      expect((await f.post(batch([message('same')], '777'))).statusCode).toBe(403);
      const payload = JSON.stringify(batch([message('same')], '777'));
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: `/v1/whatsapp-business/${channel.id}`,
            headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(payload) },
            payload,
          })
        ).statusCode,
      ).toBe(200);
      await f.post(batch([message('same')]));
      await f.channels.dispatch();
      expect(await f.channels.contacts(f.profile.id)).toHaveLength(1);
      expect(await f.channels.contacts(other.id)).toHaveLength(1);
      expect(await f.services.store.db.select().from(metaInbox)).toHaveLength(2);
      const [contact] = await f.channels.contacts(other.id);
      if (!contact) throw new Error('Contact missing');
      await f.channels.blockContact(other.id, contact.id);
      expect(await metaCanSend(f.services.store.db, channel.id, contact.chatId)).toBe(false);
      expect(await metaCanSend(f.services.store.db, f.channel.id, contact.chatId)).toBe(true);
    } finally {
      await f.close();
    }
  });
  it('replays a partially processed inbox without duplicating held messages or runs', async () => {
    const f = await setup();
    try {
      await f.post(batch([message('held', 'One'), message('appended', 'Two')]));
      await f.channels.dispatch();
      await f.services.store.db
        .update(metaInbox)
        .set({ processedAt: null, availableAt: new Date(0) })
        .where(eq(metaInbox.channelId, f.channel.id));
      await f.channels.dispatch();
      const [pending] = await f.channels.contacts(f.profile.id);
      if (!pending) throw new Error('Contact missing');
      expect(pending.message).toBe('One\n\nTwo');
      await f.channels.approveContact(f.profile.id, pending.id);
      const [run] = await f.services.runs.activities(f.profile.id);
      if (!run) throw new Error('Run missing');
      await f.services.store.db
        .update(metaInbox)
        .set({ processedAt: null, availableAt: new Date(0) })
        .where(eq(metaInbox.channelId, f.channel.id));
      await f.channels.dispatch();
      expect(await f.services.runs.activities(f.profile.id)).toHaveLength(1);
      expect((await f.services.runs.activities(f.profile.id))[0]?.id).toBe(run.id);
    } finally {
      await f.close();
    }
  });

  it('delivers schedules and cross-session/contact messages to approved contacts inside the window', async () => {
    const f = await setup();
    try {
      await f.post(batch([message('causal')]));
      await f.channels.dispatch();
      const [pending] = await f.channels.contacts(f.profile.id);
      if (!pending) throw new Error('Contact missing');
      const contact = await f.channels.approveContact(f.profile.id, pending.id);
      const [inboundRun] = await f.services.runs.activities(f.profile.id);
      if (!contact.sessionId || !inboundRun) throw new Error('Session missing');
      await f.services.lifecycle.claim(inboundRun.id, f.profile.id, 'worker');
      await f.services.lifecycle.finish(
        f.profile.id,
        inboundRun.id,
        'worker',
        'completed',
        'Causal reply',
      );
      await f.channels.dispatch();
      expect(await metaCanSend(f.services.store.db, f.channel.id, contact.chatId)).toBe(true);
      const [originalWindow] = await f.services.store.db.select().from(metaWindows);
      const before = f.fetcher.mock.calls.length;
      // Schedules, late subagent results, contact relays and conversation writes all use
      // deliverRun: none is the original inbound, even when activity is marked channel.
      f.services.schedules.useDeliveries(f.channels);
      const schedule = await f.services.schedules.create(
        f.profile.id,
        {
          name: 'Customer follow-up',
          instruction: 'Send a scheduled message',
          sessionId: contact.sessionId,
          cron: '0 8 * * *',
          timeZone: 'UTC',
        },
        'owner',
      );
      await f.services.store.db
        .update(schedules)
        .set({ nextRunAt: new Date(0) })
        .where(eq(schedules.id, schedule.id));
      await f.services.schedules.fireDue();
      const autonomous = (await f.services.runs.activities(f.profile.id)).find((run) =>
        run.input.startsWith('[Scheduled:'),
      );
      if (!autonomous) throw new Error('Scheduled run missing');
      await f.channels.deliverRun(f.profile.id, contact.sessionId, autonomous.id);
      await f.services.lifecycle.claim(autonomous.id, f.profile.id, 'worker');
      await f.services.lifecycle.say(f.profile.id, autonomous.id, 'worker', 'Autonomous progress');
      await f.channels.dispatch();
      await f.services.lifecycle.finish(
        f.profile.id,
        autonomous.id,
        'worker',
        'completed',
        'Autonomous final',
      );
      const other = await f.services.sessions.createSession(f.profile.id, { title: 'Panel' });
      await f.services.errands.write(
        f.profile.id,
        contact.sessionId,
        autonomous.id,
        'Cross-session write',
        'write',
      );
      await f.services.errands.ask(
        f.profile.id,
        contact.id,
        other.id,
        autonomous.id,
        'Contact send',
        false,
      );
      const otherRun = await f.services.runs.submit(f.profile.id, other.id, {
        text: 'Send a file',
        requestKey: 'media-tool',
      });
      if (!f.services.media) throw new Error('Media missing');
      await f.services.media.sendFile(
        otherRun,
        {
          source: 'content',
          content: 'Synthetic file',
          name: 'test.txt',
          sessionId: contact.sessionId,
        },
        'cross-session-file',
      );
      await f.channels.dispatch();
      const sent = f.fetcher.mock.calls
        .slice(before)
        .filter(([url]) => String(url).endsWith('/messages'))
        .map(
          ([, init]) => JSON.parse(String(init?.body)) as { to: string; text: { body: string } },
        );
      expect(sent.map((item) => item.text.body)).toEqual([
        'Autonomous progress',
        'Autonomous final',
        'Cross-session write',
        'Contact send',
      ]);
      expect(sent.every((item) => item.to === contact.chatId)).toBe(true);
      // Outgoing messages do not renew the customer's window.
      const [window] = await f.services.store.db.select().from(metaWindows);
      expect(window?.lastInbound).toEqual(originalWindow?.lastInbound);
      const failed = (await f.channels.deliveries(f.profile.id)).filter(
        (d) => d.status === 'failed',
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]?.mediaId).toBeDefined(); // Documents are still unsupported by the adapter.
    } finally {
      await f.close();
    }
  });

  it.each([
    'expired',
    'blocked',
    'chat-paused',
    'channel-paused',
    'resumed',
    'other-recipient',
  ] as const)('blocks a queued proactive message when %s at send time', async (reason) => {
    const f = await setup();
    try {
      await f.channels.update(f.profile.id, f.channel.id, { allowAllContacts: true });
      await f.post(batch([message('customer')]));
      await f.channels.dispatch();
      const [contact] = await f.channels.contacts(f.profile.id);
      const [inbound] = await f.services.runs.activities(f.profile.id);
      if (!contact?.sessionId || !inbound) throw new Error('Conversation missing');
      await f.services.lifecycle.claim(inbound.id, f.profile.id, 'worker');
      await f.services.lifecycle.finish(
        f.profile.id,
        inbound.id,
        'worker',
        'completed',
        'Initial reply',
      );
      await f.channels.dispatch();
      const owner = await f.services.sessions.createSession(f.profile.id, { title: 'Owner' });
      const run = await f.services.runs.submit(f.profile.id, owner.id, {
        text: 'Follow up',
        requestKey: 'follow-up',
      });
      await f.services.errands.write(
        f.profile.id,
        contact.sessionId,
        run.id,
        'Proactive message',
        'proactive',
      );
      if (reason === 'expired') {
        await f.services.store.db
          .update(metaWindows)
          .set({ lastInbound: new Date(Date.now() - META_WINDOW_MS) });
      } else if (reason === 'blocked') {
        await f.channels.blockContact(f.profile.id, contact.id);
      } else if (reason === 'channel-paused') {
        await f.channels.update(f.profile.id, f.channel.id, { enabled: false });
      } else if (reason === 'chat-paused' || reason === 'resumed') {
        await f.channels.updateContact(f.profile.id, contact.id, { aiEnabled: false });
        if (reason === 'resumed')
          await f.channels.updateContact(f.profile.id, contact.id, { aiEnabled: true });
      } else {
        // A different recipient's signed inbound cannot authorize this recipient's window.
        await f.services.store.db.update(metaWindows).set({ chatId: '15559999999' });
      }
      const before = f.fetcher.mock.calls.length;
      await f.channels.dispatch();
      expect(f.fetcher.mock.calls).toHaveLength(before);
      expect(
        (await f.channels.deliveries(f.profile.id)).find((d) => d.notice === 'Proactive message'),
      ).toMatchObject({ status: 'failed', remoteMessageIds: [] });
    } finally {
      await f.close();
    }
  });

  it('blocks progress, final answers and queued manual notices when the window expires during a run', async () => {
    const f = await setup();
    try {
      await f.post(batch([message('start')]));
      await f.channels.dispatch();
      const [pending] = await f.channels.contacts(f.profile.id);
      if (!pending) throw new Error('Contact missing');
      const approved = await f.channels.approveContact(f.profile.id, pending.id);
      const [run] = await f.services.runs.activities(f.profile.id);
      if (!run || !approved.sessionId) throw new Error('Run missing');
      await f.services.lifecycle.claim(run.id, f.profile.id, 'worker');
      await f.services.lifecycle.say(f.profile.id, run.id, 'worker', 'Working on it.');
      await f.services.store.db
        .update(metaWindows)
        .set({ lastInbound: new Date(Date.now() - META_WINDOW_MS - 1) });
      const before = f.fetcher.mock.calls.length;
      await f.channels.dispatch();
      await f.services.lifecycle.finish(f.profile.id, run.id, 'worker', 'completed', 'Finished.');
      await f.services.errands.write(
        f.profile.id,
        approved.sessionId,
        run.id,
        'A manual message.',
        'manual',
      );
      await f.channels.dispatch();
      expect(f.fetcher.mock.calls).toHaveLength(before);
      const failed = (await f.channels.deliveries(f.profile.id)).filter(
        (delivery) => delivery.status === 'failed',
      );
      expect(failed).toHaveLength(2);
      expect(failed.every((delivery) => delivery.error?.includes('24 hours'))).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('limits only the raw Meta route to 3 MB without loosening the rest of the API', async () => {
    const f = await setup();
    try {
      const value = { ...batch([]), ignored: 'x'.repeat(300 * 1024) };
      expect((await f.post(value)).statusCode).toBe(200);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: `/v1/telegram/${f.channel.id}`,
            headers: { 'content-type': 'application/json' },
            payload: JSON.stringify(value),
          })
        ).statusCode,
      ).toBe(413);
      expect(
        (await f.post({ ...batch([]), ignored: 'x'.repeat(3 * 1024 * 1024) })).statusCode,
      ).toBe(413);
    } finally {
      await f.close();
    }
  });
});

describe('Meta native transport safety', () => {
  it('compares raw HMAC and enforces the exact 24 hour boundary', () => {
    expect(metaSignature(Buffer.from('a'), sign('a'), credentials.appSecret)).toBe(true);
    expect(metaSignature(Buffer.from('b'), sign('a'), credentials.appSecret)).toBe(false);
    expect(metaSignature(Buffer.from('a'), 'sha256=x', credentials.appSecret)).toBe(false);
    expect(windowOpen(new Date(0), META_WINDOW_MS - 1)).toBe(true);
    expect(windowOpen(new Date(0), META_WINDOW_MS)).toBe(false);
    expect(windowOpen(new Date(2), 1)).toBe(false);
  });

  it('never retries uncertain message writes and checks the window again after upload', async () => {
    const adapter = new WhatsAppBusinessChannel();
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error('timeout after write');
    });
    expect(
      (await adapter.send({ chatId: '15550000001', text: 'Hello' }, context(fetcher))).status,
    ).toBe('unknown');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const upload = vi.fn<typeof fetch>(async () => Response.json({ id: '333' }));
    const canReply = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(
      (
        await adapter.send(
          {
            chatId: '15550000001',
            text: '',
            media: { mimeType: 'audio/ogg', data: ogg().toString('base64'), voice: true },
          },
          context(upload, canReply),
        )
      ).status,
    ).toBe('failed');
    expect(upload).toHaveBeenCalledTimes(1);
    expect(
      (await adapter.send({ chatId: 'group@g.us', text: 'No' }, context(fetcher))).status,
    ).toBe('failed');
  });

  it('uploads native Ogg/Opus audio and rejects forged MIME and stereo headers', async () => {
    const adapter = new WhatsAppBusinessChannel();
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith('/media')
        ? Response.json({ id: '333' })
        : Response.json({ messages: [{ id: 'wamid.audio' }] }),
    );
    const result = await adapter.send(
      {
        chatId: '15550000001',
        text: '',
        media: { mimeType: 'audio/ogg', data: ogg().toString('base64'), voice: true },
      },
      context(fetcher),
    );
    expect(result).toEqual({ status: 'sent', remoteMessageIds: ['wamid.audio'] });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
      type: 'audio',
      audio: { id: '333', voice: true },
      to: '15550000001',
    });
    const stereo = ogg();
    stereo[37] = 2;
    expect(opusMono(stereo)).toBe(false);
    expect(
      (
        await adapter.send(
          {
            chatId: '15550000001',
            text: '',
            media: { mimeType: 'audio/ogg', data: Buffer.from('not audio').toString('base64') },
          },
          context(fetcher),
        )
      ).status,
    ).toBe('failed');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('downloads audio with host, byte, codec and redirect boundaries', async () => {
    const adapter = new WhatsAppBusinessChannel();
    const inbound = { ...message('voice'), type: 'audio', audio: { id: '333' } };
    const bytes = ogg();
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).includes('graph.facebook.com')
        ? Response.json({ url: 'https://lookaside.fbsbx.com/media', file_size: bytes.length })
        : new Response(new Uint8Array(bytes)),
    );
    expect((await adapter.download(inbound, context(fetcher))).media?.[0]?.mimeType).toBe(
      'audio/ogg',
    );
    expect(fetcher.mock.calls[1]?.[1]?.redirect).toBe('error');
    for (const url of [
      'https://evil.example/audio',
      'http://lookaside.fbsbx.com/file',
      'https://lookaside.fbsbx.com.evil.example/file',
      'https://x@lookaside.fbsbx.com/file',
      'https://127.0.0.1/file',
    ])
      expect(() => metaMediaUrl(url)).toThrow();
    const bad = vi.fn<typeof fetch>(async () =>
      Response.json({ url: 'https://evil.example/audio', file_size: 10 }),
    );
    expect((await adapter.download(inbound, context(bad))).note).toContain('could not');
    expect(bad).toHaveBeenCalledTimes(1);
    const large = vi.fn<typeof fetch>(async () =>
      Response.json({ url: 'https://lookaside.fbsbx.com/media', file_size: META_MEDIA_LIMIT + 1 }),
    );
    expect((await adapter.download(inbound, context(large))).media).toBeUndefined();
    expect(large).toHaveBeenCalledTimes(1);
  });
});

it('sends and removes a native reaction without turning it into text', async () => {
  const sent: unknown[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ messages: [{ id: 'wamid.reaction' }] });
  };
  const adapter = new WhatsAppBusinessChannel();
  for (const emoji of ['❤️', null]) {
    const result = await adapter.send(
      {
        chatId: '15550000001',
        text: '',
        reaction: { messageId: 'wamid.original', fromMe: false, emoji },
      },
      context(fetcher),
    );
    expect(result.status).toBe('sent');
  }
  expect(sent).toEqual([
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15550000001',
      type: 'reaction',
      reaction: { message_id: 'wamid.original', emoji: '❤️' },
    },
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15550000001',
      type: 'reaction',
      reaction: { message_id: 'wamid.original', emoji: '' },
    },
  ]);
});
