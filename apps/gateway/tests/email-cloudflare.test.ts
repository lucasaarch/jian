import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Cloudflare } from '../src/channels/email/cloudflare.js';
import { workerSigned } from '../src/channels/email/cloudflare-mail.js';
import { Channels } from '../src/channels/service.js';
import { testServices } from './helpers/services.js';

const token = 'synthetic-cloudflare-admin-token-32ch';
const apiKey = 'cf_synthetic_test_token';
const accountId = '0123456789abcdef0123456789abcdef';
const passing =
  'mx.cloudflare.net; spf=pass smtp.mailfrom=mail.test; dkim=pass header.d=mail.test header.s=s1; dmarc=pass header.from=mail.test';

type Call = { method: string; url: string; body?: unknown; form?: FormData; headers: Headers };

/** The metadata part of a Worker upload: its module, runtime date and bindings. */
async function metadataOf(upload: Call | undefined) {
  const part = upload?.form?.get('metadata');
  if (!(part instanceof Blob)) throw new Error('Worker upload missing');
  return JSON.parse(await part.text()) as {
    main_module: string;
    bindings: Array<{ type: string; name: string; text: string }>;
  };
}

/** A Cloudflare account in memory: the zone agents.test with Email Routing on, and what is sent. */
function cloudflareAccount(routing = { enabled: true, status: 'ready' }) {
  const calls: Call[] = [];
  const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body;
    calls.push({
      method,
      url,
      headers: new Headers(init?.headers),
      ...(typeof body === 'string' ? { body: JSON.parse(body) } : {}),
      ...(body instanceof FormData ? { form: body } : {}),
    });
    const path = url.replace('https://api.cloudflare.com/client/v4', '');
    if (path.startsWith('/zones?'))
      return ok(new URL(url).searchParams.get('name') === 'agents.test' ? [{ id: 'zone-1' }] : []);
    if (path === '/zones/zone-1/email/routing') return ok(routing);
    if (path.includes('/workers/scripts/') && method === 'PUT') return ok({ id: 'script' });
    if (path === '/zones/zone-1/email/routing/rules' && method === 'POST')
      return ok({ id: 'rule-1' });
    if (method === 'DELETE') return ok(null);
    if (path.endsWith('/email/sending/send'))
      return ok({ delivered: ['ada@mail.test'], message_id: '<cf-sent-1@agents.test>' });
    return Response.json({ success: false, errors: [{ message: 'Not found' }] }, { status: 404 });
  }) as typeof fetch;

  /** The secret the uploaded Worker was given, as only Cloudflare and the gateway know it. */
  const secret = async () => {
    const metadata = await metadataOf(calls.find((call) => call.form));
    const secret = metadata.bindings.find((binding) => binding.name === 'JIAN_SECRET');
    if (!secret) throw new Error('Worker secret missing');
    return secret.text;
  };
  return { calls, fetcher, secret };
}

type Mail = {
  from?: string;
  auth?: string;
  messageId?: string;
  inReplyTo?: string;
  above?: string[];
  below?: string[];
  body?: string[];
};

/** A message as Email Routing hands it to the Worker, its own verdict on top. */
function mime(mail: Mail = {}) {
  return [
    ...(mail.above ?? []),
    `Authentication-Results: ${mail.auth ?? passing}`,
    ...(mail.below ?? []),
    `From: ${mail.from ?? 'Ada Lovelace <ada@mail.test>'}`,
    'To: mia@agents.test',
    'Subject: Hello',
    `Message-ID: ${mail.messageId ?? `<${randomUUID()}@mail.test>`}`,
    ...(mail.inReplyTo ? [`In-Reply-To: ${mail.inReplyTo}`] : []),
    'MIME-Version: 1.0',
    ...(mail.body ?? ['Content-Type: text/plain; charset=utf-8', '', 'Can you help?']),
  ].join('\r\n');
}

/** The headers the Worker sends: the same fields, signed the way it signs them. */
function signed(
  raw: string,
  secret: string,
  {
    at = Math.floor(Date.now() / 1000),
    recipient = 'mia@agents.test',
    authentication = passing,
  } = {},
) {
  const signature = createHmac('sha256', secret)
    .update(`${at}\n${recipient}\n${authentication}\n`)
    .update(raw)
    .digest('hex');
  return {
    'x-jian-timestamp': String(at),
    'x-jian-recipient': recipient,
    'x-jian-authentication': authentication,
    'x-jian-signature': `v1=${signature}`,
  };
}

async function setup() {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Mia',
    instructions: 'Help',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const cloudflare = cloudflareAccount();
  const channels = new Channels(services, cloudflare.fetcher);
  channels.usePublicUrl('https://gateway.example.test/');
  const channel = await channels.connect(profile.id, {
    type: 'email',
    email: { provider: 'cloudflare', apiKey, accountId, address: 'Mia@Agents.test' },
  });
  const app = createApp({ ...services, channels, token, logger: false });
  const secret = await cloudflare.secret();

  const post = (raw: string, headers: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: `/v1/email/${channel.id}`,
      headers: { 'content-type': 'message/rfc822', ...headers },
      payload: raw,
    });
  /** Mail arriving through the Worker, which forwards Cloudflare's verdict as it read it. */
  const arrive = (mail: Mail = {}, authentication = mail.auth ?? passing) => {
    const raw = mime(mail);
    return post(raw, signed(raw, secret, { authentication }));
  };
  return { services, profile, cloudflare, channels, channel, app, secret, post, arrive };
}

describe('Cloudflare Worker signatures', () => {
  const secret = 'synthetic-worker-secret';
  const raw = Buffer.from(mime({ messageId: '<a@mail.test>' }));

  it('accepts the signature of the exact bytes and fields', () => {
    expect(workerSigned(raw, signed(raw.toString(), secret), secret)).toBe(true);
  });

  it('refuses another secret, a changed body or recipient, and an old timestamp', () => {
    const headers = signed(raw.toString(), secret);
    expect(workerSigned(raw, headers, 'another-secret')).toBe(false);
    expect(workerSigned(Buffer.concat([raw, Buffer.from(' ')]), headers, secret)).toBe(false);
    expect(workerSigned(raw, { ...headers, 'x-jian-recipient': 'leo@agents.test' }, secret)).toBe(
      false,
    );
    expect(
      workerSigned(
        raw,
        { ...headers, 'x-jian-authentication': 'mx.cloudflare.net; dmarc=pass' },
        secret,
      ),
    ).toBe(false);
    const stale = Math.floor(Date.now() / 1000) - 6 * 60;
    expect(workerSigned(raw, signed(raw.toString(), secret, { at: stale }), secret)).toBe(false);
    expect(workerSigned(raw, { ...headers, 'x-jian-signature': 'v1=00' }, secret)).toBe(false);
  });
});

describe('the email channel on Cloudflare', () => {
  it('connects by uploading its Worker and routing the address to it, and takes both back', async () => {
    const f = await setup();
    try {
      expect(f.channel).toMatchObject({ type: 'email', emailAddress: 'mia@agents.test' });
      const upload = f.cloudflare.calls.find((call) => call.form);
      expect(upload?.method).toBe('PUT');
      expect(upload?.url).toMatch(
        new RegExp(`/accounts/${accountId}/workers/scripts/jian-email-[0-9a-f]{24}$`),
      );
      const metadata = await metadataOf(upload);
      expect(metadata).toMatchObject({ main_module: 'worker.js' });
      expect(metadata.bindings).toContainEqual({
        type: 'plain_text',
        name: 'JIAN_ENDPOINT',
        text: `https://gateway.example.test/v1/email/${f.channel.id}`,
      });
      expect(f.secret.length).toBeGreaterThanOrEqual(40);
      const script = upload?.url.split('/').at(-1);
      const rule = f.cloudflare.calls.find((call) => call.url.endsWith('/email/routing/rules'));
      expect(rule?.headers.get('authorization')).toBe(`Bearer ${apiKey}`);
      expect(rule?.body).toMatchObject({
        enabled: true,
        matchers: [{ type: 'literal', field: 'to', value: 'mia@agents.test' }],
        actions: [{ type: 'worker', value: [script] }],
      });

      await f.channels.revoke(f.profile.id, f.channel.id);
      const deleted = f.cloudflare.calls.filter((call) => call.method === 'DELETE');
      expect(deleted.map((call) => call.url)).toEqual([
        expect.stringMatching(/\/zones\/zone-1\/email\/routing\/rules\/rule-1$/),
        expect.stringMatching(new RegExp(`/workers/scripts/${script}\\?force=true$`)),
      ]);
    } finally {
      await f.app.close();
    }
  });

  it('refuses to connect a domain whose Email Routing is not ready, uploading nothing', async () => {
    const services = await testServices();
    const profile = await services.profiles.createProfile({
      name: 'Mia',
      instructions: 'Help',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    });
    const cloudflare = cloudflareAccount({ enabled: false, status: 'unconfigured' });
    const channels = new Channels(services, cloudflare.fetcher);
    channels.usePublicUrl('https://gateway.example.test/');
    const email = {
      provider: 'cloudflare' as const,
      apiKey,
      accountId,
      address: 'mia@agents.test',
    };
    await expect(channels.connect(profile.id, { type: 'email', email })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('Email Routing'),
    });
    await expect(
      channels.connect(profile.id, {
        type: 'email',
        email: { ...email, address: 'mia@else.test' },
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('not a zone') });
    expect(cloudflare.calls.some((call) => call.method !== 'GET')).toBe(false);
  });

  it('refuses a request its Worker did not sign', async () => {
    const f = await setup();
    try {
      const raw = mime();
      expect((await f.post(raw, signed(raw, 'not-the-secret'))).statusCode).toBe(401);
      expect((await f.post(raw, {})).statusCode).toBe(401);
      expect(await f.channels.contacts(f.profile.id)).toHaveLength(0);
    } finally {
      await f.app.close();
    }
  });

  it('does not attribute mail Cloudflare did not authenticate for its sender', async () => {
    const f = await setup();
    try {
      const refused = [
        // Cloudflare's own verdict, failing.
        await f.arrive({ auth: 'mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail' }),
        // A verdict from another service is the sender's own text.
        await f.arrive({ auth: 'mx.example.test; spf=pass; dkim=pass; dmarc=pass' }),
        // DMARC passed, but for another domain than the one in From.
        await f.arrive({ auth: 'mx.cloudflare.net; dmarc=pass header.from=else.test' }),
        // A DKIM signature of another domain says nothing of this sender.
        await f.arrive({ auth: 'mx.cloudflare.net; dkim=pass header.d=else.test; dmarc=none' }),
        // A sender's forged header below Cloudflare's failing verdict.
        await f.arrive(
          { auth: 'mx.cloudflare.net; dmarc=fail', below: [`Authentication-Results: ${passing}`] },
          `mx.cloudflare.net; dmarc=fail, ${passing}`,
        ),
        // The same forged header, were it the first of the raw message: the Worker's copy of
        // Cloudflare's verdict does not begin with it.
        await f.arrive({ auth: passing }, `mx.cloudflare.net; dmarc=fail, ${passing}`),
        // Two senders in From: neither is trusted.
        await f.arrive({ from: 'ada@mail.test, eve@mail.test' }),
      ];
      for (const response of refused) expect(response.json()).toEqual({ accepted: false });
      expect(await f.channels.contacts(f.profile.id)).toHaveLength(0);

      // A comment says nothing; DKIM of the From domain counts without DMARC.
      const signedOnly = await f.arrive({
        auth: 'mx.cloudflare.net; spf=none; dkim=pass header.d=mail.test (comment: dmarc=fail); dmarc=none',
      });
      expect(signedOnly.json()).toMatchObject({ accepted: false, contact: 'pending' });
    } finally {
      await f.app.close();
    }
  });

  it('holds a stranger, answers in the thread once approved, and starts one turn per message', async () => {
    const f = await setup();
    try {
      const first = await f.arrive({ messageId: '<hello-1@mail.test>' });
      expect(first.json()).toMatchObject({ accepted: false, contact: 'pending' });
      const [pending] = await f.channels.contacts(f.profile.id);
      if (!pending) throw new Error('Contact request missing');
      expect(pending).toMatchObject({ chatId: 'ada@mail.test', displayName: 'Ada Lovelace' });

      await f.channels.approveContact(f.profile.id, pending.id);
      const [run] = await f.services.runs.activities(f.profile.id);
      if (!run) throw new Error('Run missing');
      await f.services.lifecycle.claim(run.id, f.profile.id, 'worker');
      await f.services.lifecycle.finish(f.profile.id, run.id, 'worker', 'completed', 'A note.');
      await f.channels.dispatch();
      // The turn's own answer is not an email; the agent answers with `reply_email`.
      expect(f.cloudflare.calls.some((call) => call.url.endsWith('/email/sending/send'))).toBe(
        false,
      );
      await f.services.errands.reply(f.profile.id, run.sessionId, run.id, 'Sure.', 'reply');
      await f.channels.dispatch();

      const sent = f.cloudflare.calls.filter((call) => call.url.endsWith('/email/sending/send'));
      expect(sent).toHaveLength(1);
      expect(sent[0]?.url).toContain(`/accounts/${accountId}/`);
      expect(sent[0]?.body).toMatchObject({
        from: { address: 'mia@agents.test', name: 'Mia' },
        to: ['ada@mail.test'],
        subject: 'Re: Hello',
        text: 'Sure.',
        html: expect.stringContaining('Sure.'),
        headers: { 'In-Reply-To': '<hello-1@mail.test>' },
      });
      const [delivery] = await f.channels.deliveries(f.profile.id);
      expect(delivery).toMatchObject({
        status: 'sent',
        remoteMessageIds: ['<cf-sent-1@agents.test>'],
      });

      // Cloudflare may hand the same message over again, with other headers on top of it.
      const reply = { messageId: '<hello-2@mail.test>', inReplyTo: '<cf-sent-1@agents.test>' };
      const answer = (await f.arrive(reply)).json();
      expect(answer).toMatchObject({ accepted: true });
      const again = await f.arrive({ ...reply, above: ['Received: from mx2.example.test'] });
      expect(again.json()).toMatchObject({ runId: answer.runId });
      const runs = await f.services.runs.activities(f.profile.id);
      expect(runs.filter((item) => item.id !== run.id)).toHaveLength(1);
    } finally {
      await f.app.close();
    }
  });
});

describe('Cloudflare mail', () => {
  const credential = {
    provider: 'cloudflare' as const,
    apiKey,
    accountId,
    address: 'mia@agents.test',
    fromName: 'Mia',
    webhookId: 'jian-email-x',
    signingSecret: 's',
    zoneId: 'zone-1',
    ruleId: 'rule-1',
  };

  it('reads the files a message carries, decoded, under their own names', async () => {
    const raw = mime({
      body: [
        'Content-Type: multipart/mixed; boundary="b1"',
        '',
        '--b1',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>See <b>attached</b></p>',
        '--b1',
        'Content-Type: application/pdf; name="invoice.pdf"',
        'Content-Disposition: attachment; filename="invoice.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('%PDF-1.4 synthetic').toString('base64'),
        '--b1--',
      ],
    });
    const event = await new Cloudflare().event(Buffer.from(raw), {
      'x-jian-recipient': 'mia@agents.test',
      'x-jian-authentication': passing,
    });
    expect(event.recipients).toEqual(['mia@agents.test']);
    expect(event.email).toMatchObject({
      from: 'ada@mail.test',
      html: expect.stringContaining('<b>attached</b>'),
      authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
      attachments: 1,
      files: {
        media: [
          {
            mimeType: 'application/pdf',
            name: 'invoice.pdf',
            data: Buffer.from('%PDF-1.4 synthetic').toString('base64'),
          },
        ],
      },
    });
  });

  it('sends text and HTML, copies, threading headers and files in one request', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json({ success: true, result: { message_id: 'cf-1@agents.test' } });
    }) as typeof fetch;
    const outcome = await new Cloudflare().send(
      credential,
      {
        from: '"Mia" <mia@agents.test>',
        to: 'ada@mail.test',
        cc: ['leo@mail.test'],
        subject: 'Re: Invoice',
        text: 'Paid.',
        html: '<p>Paid.</p>',
        inReplyTo: '<b@mail.test>',
        references: '<a@mail.test> <b@mail.test>',
        attachments: [{ mimeType: 'application/pdf', data: 'JVBERi0=', name: 'receipt.pdf' }],
      },
      'delivery-1',
      { fetch: fetcher, signal: new AbortController().signal },
    );
    expect(outcome).toEqual({ status: 'sent', remoteMessageIds: ['<cf-1@agents.test>'] });
    expect(calls[0]?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending/send`,
    );
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe(`Bearer ${apiKey}`);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      from: { address: 'mia@agents.test', name: 'Mia' },
      to: ['ada@mail.test'],
      cc: ['leo@mail.test'],
      subject: 'Re: Invoice',
      text: 'Paid.',
      html: '<p>Paid.</p>',
      headers: { 'In-Reply-To': '<b@mail.test>', References: '<a@mail.test> <b@mail.test>' },
      attachments: [
        {
          content: 'JVBERi0=',
          filename: 'receipt.pdf',
          type: 'application/pdf',
          disposition: 'attachment',
        },
      ],
    });
  });

  it('tells a refusal from a send that may have landed, and never sends one over the limit', async () => {
    const net = (status: number) => ({
      fetch: (async () => Response.json({ success: false }, { status })) as unknown as typeof fetch,
      signal: new AbortController().signal,
    });
    const mail = { from: 'mia@agents.test', to: 'ada@mail.test', subject: 'S', text: 'T' };
    const send = (status: number) => new Cloudflare().send(credential, mail, 'd', net(status));
    expect((await send(422)).status).toBe('failed');
    expect((await send(429)).status).toBe('pending');
    expect((await send(500)).status).toBe('unknown');
    const offline = {
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
      signal: new AbortController().signal,
    };
    expect((await new Cloudflare().send(credential, mail, 'd', offline)).status).toBe('unknown');

    let called = false;
    const huge = 'A'.repeat(26 * 1024 * 1024);
    const outcome = await new Cloudflare().send(
      credential,
      { ...mail, attachments: [{ mimeType: 'application/pdf', data: huge }] },
      'd',
      {
        fetch: (async () => {
          called = true;
          return Response.json({ success: true, result: {} });
        }) as unknown as typeof fetch,
        signal: new AbortController().signal,
      },
    );
    expect(outcome.status).toBe('failed');
    expect(called).toBe(false);
  });
});
