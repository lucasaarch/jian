import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Resend } from '../src/channels/email/resend.js';
import { svixSigned } from '../src/channels/email/svix.js';
import { envelope, mailBody } from '../src/channels/email/text.js';
import { Channels } from '../src/channels/service.js';
import { isUniqueViolation } from '../src/providers/repository.js';
import { channels as channelRows, emailBindings } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

const token = 'synthetic-email-admin-token-32-chars!';
const secret = `whsec_${randomBytes(24).toString('base64')}`;
const apiKey = 're_synthetic_test_key';

function sign(body: string, key = secret, at = Math.floor(Date.now() / 1000), id = 'msg_test') {
  const signature = createHmac('sha256', Buffer.from(key.replace(/^whsec_/, ''), 'base64'))
    .update(`${id}.${at}.${body}`)
    .digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(at), 'svix-signature': `v1,${signature}` };
}

describe('Svix signatures', () => {
  const body = JSON.stringify({ type: 'email.received', data: { email_id: 'e1' } });

  it('accepts the signature of the exact bytes', () => {
    expect(svixSigned(Buffer.from(body), sign(body), secret)).toBe(true);
  });

  it('refuses a changed body, another secret and an old timestamp', () => {
    expect(svixSigned(Buffer.from(`${body} `), sign(body), secret)).toBe(false);
    const other = `whsec_${randomBytes(24).toString('base64')}`;
    expect(svixSigned(Buffer.from(body), sign(body, other), secret)).toBe(false);
    const stale = Math.floor(Date.now() / 1000) - 6 * 60;
    expect(svixSigned(Buffer.from(body), sign(body, secret, stale), secret)).toBe(false);
  });

  it('accepts any one of several signatures while a secret rotates', () => {
    const signed = sign(body);
    const headers = { ...signed, 'svix-signature': `v1,AAAA ${signed['svix-signature']}` };
    expect(svixSigned(Buffer.from(body), headers, secret)).toBe(true);
  });
});

describe('email text', () => {
  const thread = {
    subject: 'Invoice',
    messageId: '<b@mail.test>',
    references: '<a@mail.test> <b@mail.test>',
  };

  it('starts a new thread from a first line naming its subject', () => {
    expect(envelope('Subject: Weekly report\n\nAll good.', thread)).toEqual({
      subject: 'Weekly report',
      text: 'All good.',
    });
  });

  it('answers in the thread the person wrote in', () => {
    expect(envelope('Paid today.', thread)).toEqual({
      subject: 'Re: Invoice',
      text: 'Paid today.',
      inReplyTo: '<b@mail.test>',
      references: '<a@mail.test> <b@mail.test>',
    });
  });

  it('takes the first line as the subject when there is no thread', () => {
    expect(envelope(`${'x'.repeat(100)}\nmore`).subject).toHaveLength(78);
  });

  it('drops the history a mail client quoted under a reply', () => {
    expect(
      mailBody('Yes, go ahead.\n\nOn Mon, Ada <ada@mail.test>\nwrote:\n> Shall I?\n>', null),
    ).toBe('Yes, go ahead.');
    expect(mailBody(null, '<p>Hello <b>there</b></p>')).toBe('Hello there');
  });
});

describe('Resend sends', () => {
  it('sends once per delivery, in the thread, and keeps the id a reply will name', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return String(url).endsWith('/emails')
        ? Response.json({ id: 'sent-1' })
        : Response.json({ id: 'sent-1', message_id: '<sent-1@resend.test>' });
    }) as typeof fetch;

    const outcome = await new Resend().send(
      { apiKey },
      {
        from: '"Mia" <mia@agents.test>',
        to: 'ada@mail.test',
        subject: 'Re: Invoice',
        text: 'Paid.',
        inReplyTo: '<b@mail.test>',
        references: '<a@mail.test> <b@mail.test>',
      },
      'delivery-1',
      { fetch: fetcher, signal: new AbortController().signal },
    );

    expect(outcome).toEqual({
      status: 'sent',
      remoteMessageIds: ['sent-1', '<sent-1@resend.test>'],
    });
    const sent = calls[0];
    expect(new Headers(sent?.init?.headers).get('idempotency-key')).toBe('delivery-1');
    expect(JSON.parse(String(sent?.init?.body))).toMatchObject({
      from: '"Mia" <mia@agents.test>',
      to: ['ada@mail.test'],
      subject: 'Re: Invoice',
      headers: { 'In-Reply-To': '<b@mail.test>', References: '<a@mail.test> <b@mail.test>' },
    });
  });

  it('tells a refusal from a send that may have landed', async () => {
    const net = (status: number) => ({
      fetch: (async () => new Response('{}', { status })) as unknown as typeof fetch,
      signal: new AbortController().signal,
    });
    const mail = { from: 'mia@agents.test', to: 'ada@mail.test', subject: 'S', text: 'T' };
    expect((await new Resend().send({ apiKey }, mail, 'd', net(422))).status).toBe('failed');
    expect((await new Resend().send({ apiKey }, mail, 'd', net(429))).status).toBe('pending');
    expect((await new Resend().send({ apiKey }, mail, 'd', net(500))).status).toBe('unknown');
  });
});

type Received = { from?: string; dmarc?: string; dkim?: string; inReplyTo?: string };

/** A Resend account in memory: one verified domain, and the mail the test says arrived. */
function resendAccount() {
  const calls: Array<{ method: string; url: string; body?: unknown; headers: Headers }> = [];
  const mail = new Map<string, Received>();
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      url,
      headers: new Headers(init?.headers),
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (url.includes('/domains'))
      return Response.json({
        data: [{ name: 'agents.test', status: 'verified', capabilities: { receiving: 'enabled' } }],
      });
    if (url.endsWith('/webhooks') && method === 'POST')
      return Response.json({ id: `wh-${calls.length}`, signing_secret: secret });
    if (url.includes('/webhooks/') && method === 'DELETE') return Response.json({});
    const received = /\/emails\/receiving\/([^/?]+)/.exec(url)?.[1];
    if (received) {
      const item = mail.get(received);
      if (!item) return new Response('{}', { status: 404 });
      return Response.json({
        id: received,
        from: item.from ?? 'ada@mail.test',
        to: ['mia@agents.test'],
        subject: 'Hello',
        text: 'Can you help?',
        headers: {
          from: `Ada Lovelace <${item.from ?? 'ada@mail.test'}>`,
          ...(item.inReplyTo ? { 'in-reply-to': item.inReplyTo } : {}),
        },
        message_id: `<${received}@mail.test>`,
        authentication: { spf: 'pass', dkim: item.dkim ?? 'gray', dmarc: item.dmarc ?? 'pass' },
        attachments: [],
      });
    }
    if (url.endsWith('/emails') && method === 'POST') return Response.json({ id: 'sent-1' });
    if (url.endsWith('/emails/sent-1'))
      return Response.json({ message_id: '<sent-1@resend.test>' });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { calls, mail, fetcher };
}

async function setup() {
  const services = await testServices();
  const model = { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' } as const;
  const profile = await services.profiles.createProfile({
    name: 'Mia',
    instructions: 'Help',
    model,
  });
  const other = await services.profiles.createProfile({ name: 'Leo', instructions: 'Help', model });
  const resend = resendAccount();
  const channels = new Channels(services, resend.fetcher);
  channels.usePublicUrl('https://gateway.example.test/');
  const connect = (profileId: string, address = 'Mia@Agents.test') =>
    channels.connect(profileId, {
      type: 'email',
      email: { provider: 'resend', apiKey, address },
    });
  const channel = await connect(profile.id);
  const app = createApp({ ...services, channels, token, logger: false });

  const post = (event: unknown, headers?: Record<string, string>) => {
    const payload = JSON.stringify(event);
    return app.inject({
      method: 'POST',
      url: `/v1/email/${channel.id}`,
      headers: { 'content-type': 'application/json', ...(headers ?? sign(payload)) },
      payload,
    });
  };
  const arrive = (received: Received = {}, to = ['mia@agents.test']) => {
    const id = randomUUID();
    resend.mail.set(id, received);
    return post({ type: 'email.received', data: { email_id: id, to, cc: [], received_for: [] } });
  };

  return { services, profile, other, resend, channels, channel, app, connect, post, arrive };
}

describe('the email channel', () => {
  it('connects through Resend with the webhook on the public address, one agent per address', async () => {
    const f = await setup();
    try {
      expect(f.channel).toMatchObject({ type: 'email', emailAddress: 'mia@agents.test' });
      const webhook = f.resend.calls.find((call) => call.url.endsWith('/webhooks'));
      expect(webhook?.body).toEqual({
        endpoint: `https://gateway.example.test/v1/email/${f.channel.id}`,
        events: ['email.received'],
      });

      const before = f.resend.calls.length;
      await expect(f.connect(f.other.id, 'mia@agents.test')).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(f.resend.calls.length).toBe(before);
      // The database has the last word when two connects race past the check.
      const racing = randomUUID();
      await f.services.store.db
        .insert(channelRows)
        .values({ id: racing, profileId: f.other.id, type: 'email', webhookTokenHash: racing });
      const duplicate = await f.services.store.db
        .insert(emailBindings)
        .values({ channelId: racing, address: 'mia@agents.test' })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(isUniqueViolation(duplicate)).toBe(true);
      await f.services.store.db.delete(channelRows).where(eq(channelRows.id, racing));

      await f.channels.revoke(f.profile.id, f.channel.id);
      expect(f.resend.calls.at(-1)).toMatchObject({ method: 'DELETE' });
      await expect(f.connect(f.other.id, 'mia@agents.test')).resolves.toMatchObject({
        emailAddress: 'mia@agents.test',
      });
    } finally {
      await f.app.close();
    }
  });

  it('refuses an unsigned event, and ignores mail for another address of the domain', async () => {
    const f = await setup();
    try {
      const event = { type: 'email.received', data: { email_id: 'x', to: ['mia@agents.test'] } };
      const forged = await f.post(event, sign('{}'));
      expect(forged.statusCode).toBe(401);

      const elsewhere = await f.arrive({}, ['leo@agents.test']);
      expect(elsewhere.json()).toEqual({ accepted: false });
      expect(f.resend.calls.some((call) => call.url.includes('/emails/receiving/'))).toBe(false);
      expect(await f.channels.contacts(f.profile.id)).toHaveLength(0);
    } finally {
      await f.app.close();
    }
  });

  it('does not attribute mail its sender domain did not authenticate', async () => {
    const f = await setup();
    try {
      const forged = await f.arrive({ dmarc: 'fail', dkim: 'fail' });
      expect(forged.json()).toEqual({ accepted: false });
      expect(await f.channels.contacts(f.profile.id)).toHaveLength(0);

      // Signed by its own domain, under a policy that does not enforce: still the sender.
      const signed = await f.arrive({ dmarc: 'gray', dkim: 'pass' });
      expect(signed.json()).toMatchObject({ accepted: false, contact: 'pending' });
    } finally {
      await f.app.close();
    }
  });

  it('holds a stranger without writing back, then answers in the thread once approved', async () => {
    const f = await setup();
    try {
      const first = await f.arrive();
      expect(first.json()).toMatchObject({ accepted: false, contact: 'pending' });
      await f.channels.dispatch();
      // No approval notice by email: it would answer whatever address a spammer wrote.
      expect(await f.channels.deliveries(f.profile.id)).toHaveLength(0);
      expect(f.resend.calls.some((call) => call.url.endsWith('/emails'))).toBe(false);

      const [pending] = await f.channels.contacts(f.profile.id);
      if (!pending) throw new Error('Contact request missing');
      expect(pending).toMatchObject({ chatId: 'ada@mail.test', displayName: 'Ada Lovelace' });
      await expect(
        f.channels.updateContact(f.profile.id, pending.id, { canApprove: true }),
      ).rejects.toMatchObject({ statusCode: 400 });
      await f.channels.approveContact(f.profile.id, pending.id);
      const [run] = await f.services.runs.activities(f.profile.id);
      if (!run) throw new Error('Run missing');
      await f.services.lifecycle.claim(run.id, f.profile.id, 'worker');
      await f.services.lifecycle.finish(f.profile.id, run.id, 'worker', 'completed', 'Sure.');
      await f.channels.dispatch();

      const sent = f.resend.calls.filter((call) => call.url.endsWith('/emails'));
      expect(sent).toHaveLength(1);
      const [delivery] = await f.channels.deliveries(f.profile.id);
      expect(delivery).toMatchObject({ status: 'sent' });
      expect(sent[0]?.headers.get('idempotency-key')).toBe(delivery?.id);
      const messageId = /<([^@<>]+)@mail\.test>/.exec(JSON.stringify(sent[0]?.body))?.[0];
      expect(sent[0]?.body).toMatchObject({
        from: '"Mia" <mia@agents.test>',
        to: ['ada@mail.test'],
        subject: 'Re: Hello',
        text: 'Sure.',
        headers: { 'In-Reply-To': messageId },
      });
      expect(delivery?.remoteMessageIds).toEqual(['sent-1', '<sent-1@resend.test>']);

      // Resend delivers an event again until it hears back; the second one starts nothing.
      const again = randomUUID();
      f.resend.mail.set(again, { inReplyTo: '<sent-1@resend.test>' });
      const event = { type: 'email.received', data: { email_id: again, to: ['mia@agents.test'] } };
      const answer = (await f.post(event)).json();
      expect(answer).toMatchObject({ accepted: true });
      // The same run answers the redelivery: it is not a second turn.
      expect((await f.post(event)).json()).toMatchObject({ runId: answer.runId });
      const runs = await f.services.runs.activities(f.profile.id);
      expect(runs.filter((item) => item.id !== run.id)).toHaveLength(1);
    } finally {
      await f.app.close();
    }
  });
});
