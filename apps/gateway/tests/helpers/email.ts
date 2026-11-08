import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { AgentRuntime } from '../../src/agent/runtime.js';
import { createApp } from '../../src/app.js';
import { Channels } from '../../src/channels/service.js';
import { mockModel } from './model.js';
import { testServices } from './services.js';

const token = 'synthetic-outreach-admin-token-32-chars';
const secret = `whsec_${randomBytes(24).toString('base64')}`;
const apiKey = 're_synthetic_test_key';
export const support = 'support@contabo.test';
/** Why Mia writes to the desk, as she would give it with the email. */
export const brief =
  'Get the owner’s VPS booting again; tell them when it works or it costs money.';

function sign(body: string) {
  const at = Math.floor(Date.now() / 1000);
  const id = `msg_${randomUUID()}`;
  const signature = createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64'))
    .update(`${id}.${at}.${body}`)
    .digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(at), 'svix-signature': `v1,${signature}` };
}

export type Received = {
  from: string;
  text: string;
  subject?: string;
  inReplyTo?: string;
  references?: string;
  automatic?: boolean;
  dmarc?: string;
  dkim?: string;
};

/** A Resend account in memory: one verified domain, the mail that arrives, and what is sent. */
function resendAccount() {
  const sent: Array<{ to: string[]; subject: string; text: string; headers?: object }> = [];
  const mail = new Map<string, Received & { to: string }>();
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
        to: [item.to],
        subject: item.subject ?? 'Re: VPS down',
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

/** An agent that loads the contacts tools and makes one call to one of them, then says it did. */
export function caller(toolName: string, input: unknown) {
  return mockModel({
    doGenerate: async (options) => {
      const prompt = JSON.stringify(options.prompt);
      if (prompt.includes('You are the guardrail')) return stop('ALLOW');
      if (prompt.includes('approved the action') || prompt.includes('"mail-1"'))
        return stop('Sent.');
      if (!prompt.includes('"load_tools"'))
        return call('load', 'load_tools', { groups: ['contacts'] });
      return call('mail-1', toolName, input);
    },
  });
}

export const mailer = (email: unknown) => caller('send_email', email);

/** Mia with an email channel at mia@agents.test, her owner's conversation on Auto, and a webhook. */
export async function emailSetup() {
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

  /** Mail for this address arriving at that channel's webhook, as Resend would announce it. */
  const arriveAt = (channelId: string, to: string, received: Received) => {
    const id = randomUUID();
    resend.mail.set(id, { ...received, to });
    const payload = JSON.stringify({
      type: 'email.received',
      data: { email_id: id, to: [to], cc: [], received_for: [] },
    });
    return app
      .inject({
        method: 'POST',
        url: `/v1/email/${channelId}`,
        headers: { 'content-type': 'application/json', ...sign(payload) },
        payload,
      })
      .then((response) => response.json());
  };
  const arrive = (received: Received) => arriveAt(channel.id, 'mia@agents.test', received);

  /** Asks the agent, in the owner's conversation, to make this call, and runs the turn. */
  const askTool = async (toolName: string, input: unknown, sessionId = owner.id) => {
    const runtime = new AgentRuntime(services, () => caller(toolName, input));
    const run = await services.runs.submit(profile.id, sessionId, {
      text: 'Email Contabo support about my VPS',
      requestKey: randomUUID(),
    });
    await runtime.execute(profile.id, run.id);
    return { runtime, run: await services.runs.run(profile.id, run.id) };
  };
  const ask = (email: unknown, sessionId = owner.id) => askTool('send_email', email, sessionId);

  // The owner's turn that wrote, over by the time anyone answers: every delivery has its run.
  const writing = await services.runs.submit(profile.id, owner.id, {
    text: 'Email Contabo support',
    requestKey: 'writing',
  });
  await services.lifecycle.claim(writing.id, profile.id, 'worker');
  await services.lifecycle.finish(profile.id, writing.id, 'worker', 'completed', 'Emailed.');

  /** An outreach email as an approved call sends it, and the dispatcher delivers it. */
  const outreach = async () => {
    const sent = await services.errands.email(
      profile.id,
      owner.id,
      writing.id,
      { to: support, subject: 'VPS down', text: 'My VPS does not boot.', brief },
      'outreach',
    );
    await channels.dispatch();
    return sent;
  };

  /** What a conversation now holds, newest last: the owner's unless another is named. */
  const messagesOf = async (sessionId = owner.id) =>
    (await services.sessions.messages(profile.id, sessionId, 100)).map((m) => m.content);
  const ownerMessages = () => messagesOf();

  /** Closes the turns the replies started, as a worker would once they answered. */
  const settle = async () => {
    for (const run of await services.runs.activities(profile.id)) {
      if (run.status !== 'queued') continue;
      await services.lifecycle.claim(run.id, profile.id, 'worker');
      await services.lifecycle.finish(profile.id, run.id, 'worker', 'completed', 'Noted.');
    }
  };

  /** Another agent of this installation, with an address of its own on the same account. */
  const another = async (name: string, address: string) => {
    const other = await services.profiles.createProfile({
      name,
      instructions: 'Help.',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
      contextPolicy: { inputTokens: 64000 },
    });
    const mailbox = await channels.connect(other.id, {
      type: 'email',
      email: { provider: 'resend', apiKey, address },
    });
    return {
      profile: other,
      arrive: (received: Received) => arriveAt(mailbox.id, address, received),
    };
  };

  const contactOf = async (address: string) =>
    (await channels.contacts(profile.id)).find((contact) => contact.chatId === address);

  return {
    services,
    profile,
    resend,
    channels,
    channel,
    owner,
    writing,
    app,
    arrive,
    arriveAt,
    ask,
    askTool,
    another,
    outreach,
    ownerMessages,
    messagesOf,
    settle,
    contactOf,
  };
}
