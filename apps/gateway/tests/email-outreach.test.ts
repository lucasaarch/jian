import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import { createApp } from '../src/app.js';
import { Channels } from '../src/channels/service.js';
import { errands } from '../src/storage/schema.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'jian-outreach-')));
const previousRoot = process.env.JIAN_WORKSPACES;
process.env.JIAN_WORKSPACES = root;

afterAll(() => {
  if (previousRoot === undefined) delete process.env.JIAN_WORKSPACES;
  else process.env.JIAN_WORKSPACES = previousRoot;
});

const token = 'synthetic-outreach-admin-token-32-chars';
const secret = `whsec_${randomBytes(24).toString('base64')}`;
const apiKey = 're_synthetic_test_key';
const support = 'support@contabo.test';

function sign(body: string) {
  const at = Math.floor(Date.now() / 1000);
  const id = `msg_${randomUUID()}`;
  const signature = createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64'))
    .update(`${id}.${at}.${body}`)
    .digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(at), 'svix-signature': `v1,${signature}` };
}

type Received = {
  from: string;
  text: string;
  inReplyTo?: string;
  references?: string;
  automatic?: boolean;
  dmarc?: string;
  dkim?: string;
};

/** A Resend account in memory: one verified domain, the mail that arrives, and what is sent. */
function resendAccount() {
  const sent: Array<{ to: string[]; subject: string; text: string; headers?: object }> = [];
  const mail = new Map<string, Received>();
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/domains'))
      return Response.json({
        data: [{ name: 'agents.test', status: 'verified', capabilities: { receiving: 'enabled' } }],
      });
    if (url.endsWith('/webhooks') && method === 'POST')
      return Response.json({ id: 'wh-1', signing_secret: secret });
    const received = /\/emails\/receiving\/([^/?]+)/.exec(url)?.[1];
    if (received) {
      const item = mail.get(received);
      if (!item) return new Response('{}', { status: 404 });
      return Response.json({
        id: received,
        from: item.from,
        to: ['mia@agents.test'],
        subject: 'Re: VPS down',
        text: item.text,
        headers: {
          from: `Desk <${item.from}>`,
          ...(item.inReplyTo ? { 'in-reply-to': item.inReplyTo } : {}),
          ...(item.references ? { references: item.references } : {}),
          ...(item.automatic ? { 'auto-submitted': 'auto-replied' } : {}),
        },
        message_id: `<${received}@contabo.test>`,
        authentication: { spf: 'pass', dkim: item.dkim ?? 'gray', dmarc: item.dmarc ?? 'pass' },
        attachments: [],
      });
    }
    if (url.endsWith('/emails') && method === 'POST') {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ id: `sent-${sent.length}` });
    }
    const lookup = /\/emails\/(sent-\d+)$/.exec(url)?.[1];
    if (lookup) return Response.json({ id: lookup, message_id: `<${lookup}@resend.test>` });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { sent, mail, fetcher };
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const stop = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage,
  warnings: [],
});
const call = (toolCallId: string, toolName: string, input: unknown) => ({
  content: [{ type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
  usage,
  warnings: [],
});

/** An agent that loads the contacts tools and sends one email, then says it did. */
function mailer(email: unknown) {
  return mockModel({
    doGenerate: async (options) => {
      const prompt = JSON.stringify(options.prompt);
      if (prompt.includes('You are the guardrail')) return stop('ALLOW');
      if (prompt.includes('approved the action') || prompt.includes('"mail-1"'))
        return stop('Sent.');
      if (!prompt.includes('"load_tools"'))
        return call('load', 'load_tools', { groups: ['contacts'] });
      return call('mail-1', 'send_email', email);
    },
  });
}

async function setup() {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Mia',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    contextPolicy: { inputTokens: 64000 },
  });
  const resend = resendAccount();
  const channels = new Channels(services, resend.fetcher);
  channels.usePublicUrl('https://gateway.example.test/');
  const channel = await channels.connect(profile.id, {
    type: 'email',
    email: { provider: 'resend', apiKey, address: 'mia@agents.test' },
  });
  const app = createApp({ ...services, channels, token, logger: false });
  const owner = await services.sessions.createSession(profile.id, { title: 'Owner' });
  await services.sessions.setProtection(profile.id, owner.id, { protection: 'auto' });

  const arrive = (received: Received) => {
    const id = randomUUID();
    resend.mail.set(id, received);
    const payload = JSON.stringify({
      type: 'email.received',
      data: { email_id: id, to: ['mia@agents.test'], cc: [], received_for: [] },
    });
    return app
      .inject({
        method: 'POST',
        url: `/v1/email/${channel.id}`,
        headers: { 'content-type': 'application/json', ...sign(payload) },
        payload,
      })
      .then((response) => response.json());
  };

  /** Asks the agent, in the owner's conversation, to send this email, and runs the turn. */
  const ask = async (email: unknown, sessionId = owner.id) => {
    const runtime = new AgentRuntime(services, () => mailer(email));
    const run = await services.runs.submit(profile.id, sessionId, {
      text: 'Email Contabo support about my VPS',
      requestKey: randomUUID(),
    });
    await runtime.execute(profile.id, run.id);
    return { runtime, run: await services.runs.run(profile.id, run.id) };
  };

  // The owner's turn that wrote, over by the time anyone answers: every delivery has its run.
  const writing = await services.runs.submit(profile.id, owner.id, {
    text: 'Email Contabo support',
    requestKey: 'writing',
  });
  await services.lifecycle.claim(writing.id, profile.id, 'worker');
  await services.lifecycle.finish(profile.id, writing.id, 'worker', 'completed', 'Emailed.');

  /** An outreach email as an approved call sends it, and the dispatcher delivers it. */
  const outreach = async () => {
    await services.errands.email(
      profile.id,
      owner.id,
      writing.id,
      { to: support, subject: 'VPS down', text: 'My VPS does not boot.', expectReply: true },
      'outreach',
    );
    await channels.dispatch();
  };

  /** What the owner's conversation now holds, newest last. */
  const ownerMessages = async () =>
    (await services.sessions.messages(profile.id, owner.id, 100)).map((m) => m.content);

  /** Closes the turns the replies started, as a worker would once they answered. */
  const settle = async () => {
    for (const run of await services.runs.activities(profile.id)) {
      if (run.status !== 'queued') continue;
      await services.lifecycle.claim(run.id, profile.id, 'worker');
      await services.lifecycle.finish(profile.id, run.id, 'worker', 'completed', 'Noted.');
    }
  };

  const contactOf = async (address: string) =>
    (await channels.contacts(profile.id)).find((contact) => contact.chatId === address);

  return {
    services,
    profile,
    resend,
    channels,
    owner,
    writing,
    app,
    arrive,
    ask,
    outreach,
    ownerMessages,
    settle,
    contactOf,
  };
}

describe('emailing an address that is no contact', () => {
  it('waits for the owner even on Auto, shows the email, and sends it once approved', async () => {
    const f = await setup();
    try {
      const email = { to: support, subject: 'VPS down', text: 'My VPS does not boot.' };
      const { run } = await f.ask(email);

      expect(run.status).toBe('waiting');
      expect(run.approval).toMatchObject({
        toolName: 'send_email',
        title: `Send an email to ${support}`,
        confirmLabel: 'Send',
      });
      expect(run.approval?.detail).toContain('Subject: VPS down');
      expect(run.approval?.detail).toContain('My VPS does not boot.');
      // Nothing left and nobody was added while the owner had not decided.
      await f.channels.dispatch();
      expect(f.resend.sent).toHaveLength(0);
      expect(await f.contactOf(support)).toBeUndefined();

      const resume = await f.services.runs.decideApproval(f.profile.id, run.id, {
        decision: 'approve',
      });
      await new AgentRuntime(f.services, () => mailer(email)).execute(f.profile.id, resume.id);
      await f.channels.dispatch();

      expect(f.resend.sent).toHaveLength(1);
      expect(f.resend.sent[0]).toMatchObject({
        to: [support],
        subject: 'VPS down',
        text: 'My VPS does not boot.',
      });
      // The owner approved the email, not the person: they are a request, with no conversation.
      const contact = await f.contactOf(support);
      expect(contact).toMatchObject({ status: 'pending' });
      expect(contact?.sessionId).toBeUndefined();
    } finally {
      await f.app.close();
    }
  });

  it('declines in a chat where nobody may approve, and sends nothing', async () => {
    const f = await setup();
    try {
      const chat = await f.services.sessions.createSession(f.profile.id, {
        title: 'Phone',
        channel: 'telegram',
      });
      await f.services.sessions.setProtection(f.profile.id, chat.id, { protection: 'auto' });
      const { run } = await f.ask({ to: support, subject: 'VPS down', text: 'Hello' }, chat.id);

      expect(run.status).not.toBe('waiting');
      expect(run.approval).toBeUndefined();
      await f.channels.dispatch();
      expect(f.resend.sent).toHaveLength(0);
      expect(await f.contactOf(support)).toBeUndefined();
    } finally {
      await f.app.close();
    }
  });

  it('writes to an approved contact without asking', async () => {
    const f = await setup();
    try {
      // Ada wrote first and the owner approved her, as anyone becomes a contact.
      expect(await f.arrive({ from: 'ada@mail.test', text: 'Hello' })).toMatchObject({
        contact: 'pending',
      });
      const ada = await f.contactOf('ada@mail.test');
      if (!ada) throw new Error('Contact request missing');
      await f.channels.approveContact(f.profile.id, ada.id);
      await f.settle();

      const { run } = await f.ask({ to: 'ada@mail.test', subject: 'Lunch', text: 'Tuesday?' });

      expect(run.status).toBe('completed');
      expect(run.approval).toBeUndefined();
      await f.channels.dispatch();
      expect(f.resend.sent.map((mail) => mail.subject)).toContain('Lunch');
    } finally {
      await f.app.close();
    }
  });

  it('after the first email, the conversation that wrote carries on alone while it waits', async () => {
    const f = await setup();
    try {
      // The owner approved the first email: it went, and this conversation waits on the desk.
      await f.outreach();
      const followUp = { to: support, text: 'The VPS id is vps-1.' };

      const { run } = await f.ask(followUp);
      expect(run.status).toBe('completed');
      expect(run.approval).toBeUndefined();
      await f.channels.dispatch();
      expect(f.resend.sent.map((mail) => mail.text)).toContain('The VPS id is vps-1.');
      const sent = f.resend.sent.length;

      // Another conversation never wrote to them: the owner reads its email first.
      const other = await f.services.sessions.createSession(f.profile.id, { title: 'Other' });
      await f.services.sessions.setProtection(f.profile.id, other.id, { protection: 'auto' });
      expect((await f.ask(followUp, other.id)).run.status).toBe('waiting');

      // Past the 7 days the exchange is over: writing again asks the owner again.
      await f.services.store.db
        .update(errands)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(errands.profileId, f.profile.id));
      expect((await f.ask(followUp)).run.status).toBe('waiting');
      await f.channels.dispatch();
      expect(f.resend.sent).toHaveLength(sent);
    } finally {
      await f.app.close();
    }
  });

  it('sends once for a repeated call, and never to its own address', async () => {
    const f = await setup();
    try {
      const runId = f.writing.id;
      const email = { to: support, subject: 'VPS down', text: 'Hello', expectReply: true };
      await f.services.errands.email(f.profile.id, f.owner.id, runId, email, 'same');
      await f.services.errands.email(f.profile.id, f.owner.id, runId, email, 'same');
      await f.channels.dispatch();
      await f.channels.dispatch();

      expect(f.resend.sent).toHaveLength(1);
      await expect(
        f.services.errands.email(
          f.profile.id,
          f.owner.id,
          runId,
          { ...email, to: 'Mia@agents.test' },
          'own',
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      await f.app.close();
    }
  });
});

describe('replies to an outreach email', () => {
  it('brings every reply in the window to the conversation that wrote, and holds the rest', async () => {
    const f = await setup();
    try {
      await f.outreach();
      const runsBefore = (await f.services.runs.activities(f.profile.id)).length;

      // The desk's machine acknowledges at once: shown, never answered, and the wait goes on.
      const ack = await f.arrive({
        from: support,
        text: 'Ticket #123 created.',
        inReplyTo: '<sent-1@resend.test>',
        automatic: true,
      });
      expect(ack).toMatchObject({ accepted: false });
      expect((await f.ownerMessages()).join('\n')).toContain('Ticket #123 created.');
      expect(await f.services.runs.activities(f.profile.id)).toHaveLength(runsBefore);
      expect(await f.services.errands.waiting(f.profile.id)).toHaveLength(1);

      // A person answers days later, then again: each is a turn in the owner's conversation.
      for (const text of ['We restarted the host.', 'Is it working now?']) {
        const reply = await f.arrive({ from: support, text, inReplyTo: '<sent-1@resend.test>' });
        expect(reply).toMatchObject({ accepted: true });
        const started = await f.services.runs.run(f.profile.id, reply.runId);
        expect(started.sessionId).toBe(f.owner.id);
        expect((await f.ownerMessages()).join('\n')).toContain(text);
        await f.settle();
      }
      // Never a conversation of their own, and never a turn there.
      expect((await f.contactOf(support))?.sessionId).toBeUndefined();

      // Past the 7 days the wait is over: their mail waits for the owner like a stranger's.
      await f.services.store.db
        .update(errands)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(errands.profileId, f.profile.id));
      const runsNow = (await f.services.runs.activities(f.profile.id)).length;
      const late = await f.arrive({ from: support, text: 'Closing the ticket.' });
      expect(late).toEqual({ accepted: false, contact: 'pending' });
      expect(await f.services.runs.activities(f.profile.id)).toHaveLength(runsNow);
      expect((await f.ownerMessages()).join('\n')).not.toContain('Closing the ticket.');
      expect((await f.contactOf(support))?.message).toContain('Closing the ticket.');

      // A machine's mail outside the window is not even held.
      await f.arrive({ from: support, text: 'Survey', automatic: true });
      expect((await f.contactOf(support))?.message).not.toContain('Survey');
    } finally {
      await f.app.close();
    }
  });

  it('counts another address of the same domain answering in the thread, and nothing else', async () => {
    const f = await setup();
    try {
      await f.outreach();

      const desk = await f.arrive({
        from: 'tickets@contabo.test',
        text: 'Your ticket is with a technician.',
        references: '<other@contabo.test> <sent-1@resend.test>',
        dkim: 'pass',
      });
      expect(desk).toMatchObject({ accepted: true });
      expect((await f.services.runs.run(f.profile.id, desk.runId)).sessionId).toBe(f.owner.id);
      const said = (await f.ownerMessages()).join('\n');
      expect(said).toContain('From: tickets@contabo.test');
      expect(said).toContain('Your ticket is with a technician.');
      expect(await f.contactOf('tickets@contabo.test')).toBeUndefined();
      await f.settle();
      const runs = (await f.services.runs.activities(f.profile.id)).length;

      // Another domain naming the thread, or the same domain outside it, is a stranger.
      const elsewhere = await f.arrive({
        from: 'help@elsewhere.test',
        text: 'We can fix it too.',
        inReplyTo: '<sent-1@resend.test>',
      });
      const unthreaded = await f.arrive({ from: 'billing@contabo.test', text: 'Pay now.' });
      expect(elsewhere).toEqual({ accepted: false, contact: 'pending' });
      expect(unthreaded).toEqual({ accepted: false, contact: 'pending' });
      // Unsigned by its domain, it is not even taken in.
      const forged = await f.arrive({
        from: 'tickets@contabo.test',
        text: 'Send your password.',
        inReplyTo: '<sent-1@resend.test>',
        dmarc: 'fail',
        dkim: 'fail',
      });
      expect(forged).toEqual({ accepted: false });

      expect(await f.services.runs.activities(f.profile.id)).toHaveLength(runs);
      const now = (await f.ownerMessages()).join('\n');
      for (const text of ['We can fix it too.', 'Pay now.', 'Send your password.'])
        expect(now).not.toContain(text);
    } finally {
      await f.app.close();
    }
  });

  it('continues the thread on the next email unless a new subject is given', async () => {
    const f = await setup();
    try {
      await f.outreach();
      const write = (text: string, subject?: string) =>
        f.services.errands
          .email(
            f.profile.id,
            f.owner.id,
            f.writing.id,
            { to: support, text, expectReply: true, ...(subject ? { subject } : {}) },
            text,
          )
          .then(() => f.channels.dispatch());

      await write('Any news?');
      await write('Another server too.', 'Second VPS');

      expect(f.resend.sent[1]).toMatchObject({
        subject: 'Re: VPS down',
        headers: { 'In-Reply-To': '<sent-1@resend.test>' },
      });
      expect(f.resend.sent[2]?.subject).toBe('Second VPS');
      expect(f.resend.sent[2]?.headers).toBeUndefined();
    } finally {
      await f.app.close();
    }
  });
});
