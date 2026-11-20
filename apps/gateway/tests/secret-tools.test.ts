import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_SESSION_CHANNEL } from '@jian/contracts';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import { channels, contacts } from '../src/storage/schema.js';
import { mockModel } from './helpers/model.js';
import { everythingStored, leaksOf } from './helpers/secrets.js';
import { testServices } from './helpers/services.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'jian-secret-tools-')));
const previousRoot = process.env.JIAN_WORKSPACES;
process.env.JIAN_WORKSPACES = root;

afterAll(() => {
  if (previousRoot === undefined) delete process.env.JIAN_WORKSPACES;
  else process.env.JIAN_WORKSPACES = previousRoot;
});

// Synthetic, with the characters that change under URL and base64 encoding.
const VALUE = 'sk_synthetic/Key+42=ok&more';
const leaks = leaksOf(VALUE);
const byOwner = { kind: 'owner' } as const;
const model = { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' };
const SECRET_TOOLS = ['list_secrets', 'save_secret', 'delete_secret', 'share_secret'];

async function installation() {
  const services = await testServices();
  const atlas = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model,
    contextPolicy: { inputTokens: 64000 },
  });
  const vega = await services.profiles.createProfile({
    name: 'Vega',
    instructions: 'Help.',
    model,
  });
  return { services, atlas, vega };
}
type Services = Awaited<ReturnType<typeof installation>>['services'];

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

/** A call whose input is the text given, which need not be JSON at all. */
const written = (toolCallId: string, toolName: string, input: string) => ({
  ...call(toolCallId, toolName, {}),
  content: [{ type: 'tool-call' as const, toolCallId, toolName, input }],
});

type Results = Map<string, unknown>;
type Step = (results: Results) => ReturnType<typeof call>;

/** What each call answered so far, by call id: a value, or the failure the agent was told. */
function resultsOf(prompt: unknown[]): Results {
  const found: Results = new Map();
  for (const message of prompt as { role: string; content: unknown }[]) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content as {
      type: string;
      toolCallId: string;
      output: { value: unknown };
    }[]) {
      if (part.type === 'tool-result') found.set(part.toolCallId, part.output.value);
    }
  }
  return found;
}

/**
 * One turn of `profileId` in `sessionId`, its model taking `steps` in order and then stopping.
 * A call without tools is a title or a guardrail, and is answered without a step.
 */
async function turn(
  services: Services,
  profileId: string,
  sessionId: string,
  steps: Step[],
  runId?: string,
) {
  const seen = { tools: [] as string[], results: new Map() as Results };
  let next = 0;
  const id =
    runId ??
    (await services.runs.submit(profileId, sessionId, { text: 'Work', requestKey: randomUUID() }))
      .id;
  const runtime = new AgentRuntime(services, () =>
    mockModel({
      doGenerate: async (options) => {
        if (!options.tools) return stop('ALLOW');
        seen.tools = options.tools.map((item) => item.name);
        seen.results = resultsOf(options.prompt);
        const step = steps[next++];
        return (step ? step(seen.results) : stop('Done.')) as ReturnType<typeof stop>;
      },
    }),
  );
  await runtime.execute(profileId, id);
  return { ...seen, run: await services.runs.run(profileId, id) };
}

const loading =
  (...groups: string[]) =>
  () =>
    call('load', 'load_tools', { groups });

async function session(services: Services, profileId: string, protection: 'ask' | 'full') {
  const made = await services.sessions.createSession(profileId, { title: 'Keys', channel: 'api' });
  await services.sessions.setProtection(profileId, made.id, { protection });
  return made;
}

describe('the agent keeping Secrets', () => {
  it('masks a value saved mid-run in that run and stores it nowhere', async () => {
    const { services, atlas } = await installation();
    const chat = await session(services, atlas.id, 'full');

    const { results, run } = await turn(services, atlas.id, chat.id, [
      loading('secrets', 'shell'),
      () =>
        call('save', 'save_secret', {
          title: 'Acme',
          fields: [{ label: 'Key', envName: 'ACME_KEY', sensitive: true, value: VALUE }],
        }),
      () =>
        call('cmd', 'run_command', {
          command: 'printf "%s" "$ACME_KEY"',
          secrets: ['ACME_KEY'],
          timeoutMs: 10_000,
        }),
    ]);

    expect(run.status).toBe('completed');
    expect(results.get('save')).toMatchObject({
      title: 'Acme',
      fields: [{ envName: 'ACME_KEY', sensitive: true, value: null }],
    });
    expect(JSON.stringify(results.get('cmd'))).toContain('[REDACTED]');
    const timeline = await services.sessions.timeline(atlas.id, chat.id);
    expect(JSON.stringify(timeline)).toContain('save_secret');
    expect(leaks(JSON.stringify(timeline))).toEqual([]);
    expect(leaks(await everythingStored(services))).toEqual([]);
    // Kept in the vault, where nothing reads it as text.
    expect(await services.secrets.reveal(atlas.id, ['ACME_KEY'])).toEqual({
      ACME_KEY: { value: VALUE, sensitive: true },
    });
  });

  it('refuses to save a value that was masked', async () => {
    const { services, atlas } = await installation();
    const chat = await session(services, atlas.id, 'full');

    const { results } = await turn(services, atlas.id, chat.id, [
      loading('secrets'),
      () =>
        call('save', 'save_secret', {
          title: 'Acme',
          fields: [
            { label: 'Key', envName: 'ACME_KEY', sensitive: true, value: 'key [REDACTED] end' },
          ],
        }),
    ]);

    expect(JSON.stringify(results.get('save'))).toContain(
      'That value was masked before you saw it; it cannot be saved',
    );
    expect(await services.secrets.list(atlas.id)).toEqual([]);
  });

  it('masks a value in a save of the wrong shape, in all it stores and looks back on', async () => {
    const { services, atlas } = await installation();
    const chat = await session(services, atlas.id, 'full');
    const flagged = 'sk_synthetic_flagged_0123456789';
    const misnamed = 'sk_synthetic_misnamed_0123456789';
    const broken = 'sk_synthetic_broken_0123456789';
    const looked: unknown[] = [];
    // A failed call is what makes a look back happen: its brief quotes the failure.
    const watched = {
      ...services,
      learning: {
        consider: async (_run: unknown, turn: unknown) => {
          looked.push(turn);
        },
      },
    } as Services;

    const { results, run } = await turn(watched, atlas.id, chat.id, [
      loading('secrets'),
      () =>
        call('flagged', 'save_secret', {
          title: 'Acme',
          fields: [{ label: 'Key', envName: 'ACME_KEY', sensitive: 'true', value: flagged }],
        }),
      () =>
        call('misnamed', 'save_secret', {
          secretId: 'not-a-uuid',
          title: 'Acme',
          fields: [{ label: 'Key', envName: 'ACME_KEY', sensitive: true, value: misnamed }],
        }),
      () =>
        written(
          'broken',
          'save_secret',
          `{"title":"Acme","fields":[{"label":"Key","envName":"ACME_KEY","sensitive":true,"value":"${broken}"}`,
        ),
    ]);

    expect(run.status).toBe('completed');
    expect(JSON.stringify(results.get('flagged'))).toContain('fields.0.sensitive');
    expect(JSON.stringify(results.get('misnamed'))).toContain('secretId');
    // The model is answered with what it wrote, in memory; what is kept is masked.
    expect(JSON.stringify(results.get('broken'))).toContain('Invalid input for tool save_secret');
    expect(await services.secrets.list(atlas.id)).toEqual([]);
    expect(looked).not.toEqual([]);
    const stored = [
      JSON.stringify(looked),
      JSON.stringify(await services.sessions.timeline(atlas.id, chat.id)),
      await everythingStored(services),
    ].join('\n');
    for (const value of [flagged, misnamed, broken]) {
      expect(leaksOf(value)(stored)).toEqual([]);
    }
  });

  it("lets an agent delete its own Secret but not the owner's", async () => {
    const { services, atlas } = await installation();
    const chat = await session(services, atlas.id, 'full');
    const owners = await services.secrets.create(
      atlas.id,
      {
        title: 'Owner key',
        fields: [{ label: 'Key', envName: 'OWNER_KEY', sensitive: true, value: VALUE }],
      },
      byOwner,
    );

    const { results } = await turn(services, atlas.id, chat.id, [
      loading('secrets'),
      () =>
        call('save', 'save_secret', {
          title: 'Mine',
          fields: [{ label: 'Key', envName: 'ATLAS_KEY', sensitive: true, value: VALUE }],
        }),
      () => call('theirs', 'delete_secret', { secretId: owners.id }),
      (seen) =>
        call('mine', 'delete_secret', { secretId: (seen.get('save') as { id: string }).id }),
    ]);

    expect(JSON.stringify(results.get('theirs'))).toContain(
      'This Secret was made by the owner or another agent: you can use it, not change it.',
    );
    expect(results.get('mine')).toEqual({ id: expect.any(String) });
    expect((await services.secrets.list(atlas.id)).map((secret) => secret.id)).toEqual([owners.id]);
  });

  it('shares a Secret with another agent without asking', async () => {
    const { services, atlas, vega } = await installation();
    const chat = await session(services, atlas.id, 'ask');
    const made = await services.secrets.create(
      atlas.id,
      {
        title: 'Acme',
        fields: [{ label: 'Key', envName: 'ACME_KEY', sensitive: true, value: VALUE }],
      },
      byOwner,
    );

    const { results, run } = await turn(services, atlas.id, chat.id, [
      loading('secrets'),
      () => call('share', 'share_secret', { secretId: made.id, agentId: vega.id }),
    ]);

    expect(run.status).toBe('completed');
    expect(results.get('share')).toEqual({ shared: true });
    const [seen] = await services.secrets.list(vega.id);
    expect(seen?.id).toBe(made.id);
    expect(seen?.grants).toContainEqual(
      expect.objectContaining({ profileId: vega.id, grantedByProfileId: atlas.id }),
    );
  });

  it('refuses a malformed id as a mistake in the call', async () => {
    const { services, atlas } = await installation();
    const chat = await session(services, atlas.id, 'full');

    const { results, run } = await turn(services, atlas.id, chat.id, [
      loading('secrets'),
      () => call('share', 'share_secret', { secretId: 'not-an-id', agentId: 'nobody' }),
    ]);

    expect(run.status).toBe('completed');
    expect(JSON.stringify(results.get('share'))).toMatch(/Invalid input for tool share_secret/);
  });
});

describe('where the Secret tools are offered', () => {
  /** The tools the model is offered once it asked for the Secret tools' group. */
  const offered = async (
    services: Services,
    profileId: string,
    sessionId: string,
    runId?: string,
  ) =>
    (await turn(services, profileId, sessionId, [loading('secrets')], runId)).tools.filter((name) =>
      SECRET_TOOLS.includes(name),
    );

  it('offers the Secret tools only where someone may approve', async () => {
    const { services, atlas } = await installation();

    const api = await services.sessions.createSession(atlas.id, { channel: 'api' });
    expect(await offered(services, atlas.id, api.id)).toEqual(SECRET_TOOLS);

    const peer = await services.sessions.createSession(atlas.id, {
      channel: AGENT_SESSION_CHANNEL,
    });
    expect(await offered(services, atlas.id, peer.id)).toEqual(SECRET_TOOLS);

    // A subagent acts on Auto, where nobody approves what it does.
    const parent = await services.runs.submit(atlas.id, api.id, {
      text: 'Use a helper',
      requestKey: 'parent',
    });
    const own = await services.sessions.createSession(atlas.id, { title: 'Helper' });
    const child = await services.runs.submit(
      atlas.id,
      own.id,
      { text: 'Save the key', requestKey: 'child' },
      {
        subagent: {
          parentRunId: parent.id,
          spawnKey: 'keys',
          inputHash: 'a'.repeat(64),
          role: 'execute',
          name: 'Helper',
          identity: 'Keeps keys.',
        },
      },
    );
    // The run reached the model and loaded the group: the Secret tools are absent, not unasked.
    const helper = await turn(services, atlas.id, own.id, [loading('secrets')], child.id);
    expect(helper.tools).toContain('load_tools');
    expect(helper.results.has('load')).toBe(true);
    expect(helper.tools.filter((name) => SECRET_TOOLS.includes(name))).toEqual([]);

    // A WhatsApp contact the owner did not let approve could otherwise have the agent keep, or
    // hand to another agent, whatever they send it.
    const whatsapp = await services.sessions.createSession(atlas.id, { channel: 'whatsapp' });
    const channelId = randomUUID();
    await services.store.db.insert(channels).values({
      id: channelId,
      profileId: atlas.id,
      type: 'whatsapp',
      webhookTokenHash: 'synthetic-hash',
    });
    const contactId = randomUUID();
    await services.store.db.insert(contacts).values({
      id: contactId,
      profileId: atlas.id,
      channelId,
      scope: 'direct',
      chatId: '5500000000000@s.whatsapp.net',
      actorId: '5500000000000@s.whatsapp.net',
      status: 'approved',
      canApprove: false,
      sessionId: whatsapp.id,
    });
    expect(await offered(services, atlas.id, whatsapp.id)).toEqual([]);

    // The same chat, once its contact may approve.
    await services.store.db
      .update(contacts)
      .set({ canApprove: true })
      .where(eq(contacts.id, contactId));
    expect(await offered(services, atlas.id, whatsapp.id)).toEqual(SECRET_TOOLS);
  });

  it('offers none to a contact of the API Server, and keeps them in the owner’s API sessions', async () => {
    const { services, atlas } = await installation();
    const channelId = randomUUID();
    await services.store.db.insert(channels).values({
      id: channelId,
      profileId: atlas.id,
      type: 'api',
      webhookTokenHash: 'synthetic-hash',
    });
    // An app's user on the API Server: their conversation is an `api` session, like the owner's.
    const outside = await services.sessions.createSession(atlas.id, { channel: 'api' });
    await services.store.db.insert(contacts).values({
      id: randomUUID(),
      profileId: atlas.id,
      channelId,
      scope: 'direct',
      chatId: 'app-user-vega',
      actorId: 'app-user-vega',
      status: 'approved',
      canApprove: false,
      sessionId: outside.id,
    });
    const contact = await turn(services, atlas.id, outside.id, [loading('secrets')]);
    expect(contact.results.has('load')).toBe(true);
    expect(contact.tools.filter((name) => SECRET_TOOLS.includes(name))).toEqual([]);

    const owner = await services.sessions.createSession(atlas.id, { channel: 'api' });
    expect(await offered(services, atlas.id, owner.id)).toEqual(SECRET_TOOLS);
  });
});
