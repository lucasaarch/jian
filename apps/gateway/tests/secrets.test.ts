import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reservedSecretEnvName } from '@jian/contracts';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { plainDescription } from '../src/agent/guard.js';
import { guardrail } from '../src/agent/guardrail.js';
import { redactText } from '../src/agent/results.js';
import { AgentRuntime } from '../src/agent/runtime.js';
import { commandEnvironment } from '../src/agent/shell.js';
import { profileTools } from '../src/agent/tools.js';
import { createApp } from '../src/app.js';
import { Decisions } from '../src/decisions/service.js';
import { readRunAction } from '../src/runs/repository.js';
import { secretForms } from '../src/secrets/forms.js';
import { secretFieldKey } from '../src/secrets/service.js';
import { Telemetry } from '../src/telemetry/service.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'jian-secrets-')));
const previousRoot = process.env.JIAN_WORKSPACES;
process.env.JIAN_WORKSPACES = root;

afterAll(() => {
  if (previousRoot === undefined) delete process.env.JIAN_WORKSPACES;
  else process.env.JIAN_WORKSPACES = previousRoot;
});

const token = 'synthetic-command-secrets-token-32-chars';
const owner = { authorization: `Bearer ${token}` };
const byOwner = { kind: 'owner' } as const;
// Synthetic, with the characters that change under URL and base64 encoding.
const VALUE = 'sk_synthetic/Key+42=ok&more';
const model = { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' };
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function installation() {
  const services = await testServices();
  const agent = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model,
    contextPolicy: { inputTokens: 64000 },
  });
  const other = await services.profiles.createProfile({
    name: 'Vega',
    instructions: 'Help.',
    model,
  });
  const app = createApp({ ...services, token, logger: false, publicUrl: 'https://jian.example' });
  apps.push(app);
  return { services, agent, other, app };
}

const secretsOf = (profileId: string) => `/v1/profiles/${profileId}/secrets`;

/** A Secret of one sensitive field, as a command secret was before Secrets had fields. */
const single = (envName: string, more: Record<string, unknown> = {}) => ({
  title: envName,
  fields: [{ label: 'Value', envName, sensitive: true, value: VALUE }],
  ...more,
});

/** Every row of every table, as text: what a backup of the installation would carry. */
async function everythingStored(services: Awaited<ReturnType<typeof testServices>>) {
  const read = async <T>(query: ReturnType<typeof sql>) =>
    ((await services.store.db.execute(query)) as unknown as { rows: T[] }).rows;
  const tables = await read<{ name: string }>(
    sql`select table_name as name from information_schema.tables where table_schema = 'public'`,
  );
  const rows: string[] = [];
  for (const { name } of tables) {
    const found = await read<{ row: string }>(
      sql`select t::text as row from ${sql.identifier(name)} t`,
    );
    rows.push(...found.map((item) => item.row));
  }
  return rows.join('\n');
}

const leaks = (text: string) => secretForms(VALUE).filter((form) => text.includes(form));

describe('keeping a Secret', () => {
  it('never returns a sensitive value, from any route', async () => {
    const { agent, app } = await installation();
    const made = await app.inject({
      method: 'POST',
      url: secretsOf(agent.id),
      headers: owner,
      payload: {
        title: 'AssemblyAI',
        description: 'Word timings',
        fields: [
          { label: 'API key', envName: 'ASSEMBLYAI_API_KEY', sensitive: true, value: VALUE },
          {
            label: 'Username',
            envName: 'ACME_USER',
            sensitive: false,
            value: 'atlas@example.test',
          },
        ],
      },
    });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({
      title: 'AssemblyAI',
      description: 'Word timings',
      fields: [
        { label: 'API key', envName: 'ASSEMBLYAI_API_KEY', sensitive: true, value: null },
        { label: 'Username', envName: 'ACME_USER', sensitive: false, value: 'atlas@example.test' },
      ],
      profileIds: [agent.id],
      grants: [{ profileId: agent.id, grantedByProfileId: null }],
      createdByProfileId: null,
      lastUsedAt: null,
    });
    expect(made.body).not.toContain(VALUE);

    const listed = await app.inject({ url: secretsOf(agent.id), headers: owner });
    expect(listed.json()).toHaveLength(1);
    expect(listed.json()[0].fields[1].value).toBe('atlas@example.test');
    expect(listed.body).not.toContain(VALUE);

    const replaced = await app.inject({
      method: 'PATCH',
      url: `${secretsOf(agent.id)}/${made.json().id}`,
      headers: owner,
      payload: {
        fields: [
          {
            label: 'API key',
            envName: 'ASSEMBLYAI_API_KEY',
            sensitive: true,
            value: `${VALUE}-rotated`,
          },
          { label: 'Username', envName: 'ACME_USER', sensitive: false },
        ],
      },
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.body).not.toContain(VALUE);
    expect(replaced.json().fields[1].value).toBe('atlas@example.test');
  });

  it('refuses a name a command already has, or one of Jian’s own', async () => {
    const { agent, app } = await installation();
    for (const name of ['PATH', 'HOME', 'JIAN_TOOLBOX', 'LC_ALL', 'LD_PRELOAD', 'lowercase_key']) {
      const response = await app.inject({
        method: 'POST',
        url: secretsOf(agent.id),
        headers: owner,
        payload: single(name),
      });
      expect(response.statusCode, name).toBe(400);
    }
  });

  it('reserves every variable a command is started with', () => {
    const env = commandEnvironment(
      { home: '/w', temp: '/w/tmp' },
      { PATH: '/usr/bin', LANG: 'C', LC_ALL: 'C', JIAN_TOOLBOX: '1', SSH_AUTH_SOCK: '/s' },
      'ssh -i key',
    );
    for (const name of Object.keys(env)) expect(reservedSecretEnvName(name), name).toBe(true);
  });

  it('refuses a request with no credential', async () => {
    const { agent, app } = await installation();
    const response = await app.inject({ url: secretsOf(agent.id) });
    expect(response.statusCode).toBe(401);
  });

  it('lets a paired phone see the Secrets but not add, replace or delete one', async () => {
    const { agent, app } = await installation();
    const made = await app.inject({
      method: 'POST',
      url: secretsOf(agent.id),
      headers: owner,
      payload: single('ASSEMBLYAI_API_KEY'),
    });
    const id = made.json().id;
    const pairing = await app.inject({
      method: 'POST',
      url: '/v1/devices/pairings',
      headers: owner,
    });
    const paired = await app.inject({
      method: 'POST',
      url: '/v1/devices/pair',
      payload: { code: pairing.json().code, name: 'Pixel', platform: 'android' },
    });
    const phone = { authorization: `Bearer ${paired.json().token}` };

    const seen = await app.inject({ url: secretsOf(agent.id), headers: phone });
    expect(seen.statusCode).toBe(200);
    expect(seen.json()).toHaveLength(1);
    expect(seen.body).not.toContain(VALUE);
    for (const request of [
      { method: 'POST' as const, url: secretsOf(agent.id), payload: single('S3_KEY') },
      {
        method: 'PATCH' as const,
        url: `${secretsOf(agent.id)}/${id}`,
        payload: single('ASSEMBLYAI_API_KEY', { title: 'Replaced' }),
      },
      { method: 'DELETE' as const, url: `${secretsOf(agent.id)}/${id}` },
    ]) {
      const response = await app.inject({ ...request, headers: phone });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe('A paired device cannot change Secrets.');
    }
  });

  it('keeps another agent’s Secret out of reach until it is shared', async () => {
    const { services, agent, other, app } = await installation();
    const made = await app.inject({
      method: 'POST',
      url: secretsOf(agent.id),
      headers: owner,
      payload: single('ASSEMBLYAI_API_KEY'),
    });
    const id = made.json().id;

    expect((await app.inject({ url: secretsOf(other.id), headers: owner })).json()).toEqual([]);
    const changed = await app.inject({
      method: 'PATCH',
      url: `${secretsOf(other.id)}/${id}`,
      headers: owner,
      payload: { profileIds: [other.id] },
    });
    expect(changed.statusCode).toBe(404);
    const deleted = await app.inject({
      method: 'DELETE',
      url: `${secretsOf(other.id)}/${id}`,
      headers: owner,
    });
    expect(deleted.statusCode).toBe(404);
    await expect(services.secrets.reveal(other.id, ['ASSEMBLYAI_API_KEY'])).rejects.toMatchObject({
      statusCode: 403,
    });

    await app.inject({
      method: 'PATCH',
      url: `${secretsOf(agent.id)}/${id}`,
      headers: owner,
      payload: { profileIds: [agent.id, other.id] },
    });
    expect(await services.secrets.reveal(other.id, ['ASSEMBLYAI_API_KEY'])).toEqual({
      ASSEMBLYAI_API_KEY: VALUE,
    });
  });

  it('goes with the last agent that could use it, value and all', async () => {
    const { services, agent, other } = await installation();
    const only = await services.secrets.create(agent.id, single('ONLY_ATLAS'), byOwner);
    await services.secrets.create(
      agent.id,
      single('SHARED_KEY', { profileIds: [other.id] }),
      byOwner,
    );

    await services.profiles.deleteProfile(agent.id);

    expect(await services.gatewayVault.read(secretFieldKey(only.id, 'ONLY_ATLAS'))).toBeUndefined();
    expect((await services.secrets.list(other.id)).map((item) => item.title)).toEqual([
      'SHARED_KEY',
    ]);
  });
});

describe('the fields of a Secret', () => {
  it('refuses a sensitive value under 8 characters and takes a short username', async () => {
    const { agent, app } = await installation();
    const field = (sensitive: boolean, value: string) => ({
      method: 'POST' as const,
      url: secretsOf(agent.id),
      headers: owner,
      payload: {
        title: 'Acme',
        fields: [{ label: 'User', envName: 'ACME_USER', sensitive, value }],
      },
    });

    expect((await app.inject(field(true, 'short'))).statusCode).toBe(400);
    const made = await app.inject(field(false, 'ana'));
    expect(made.statusCode).toBe(201);
    expect(made.json().fields[0].value).toBe('ana');
  });

  it('refuses two fields with one variable, and a variable another Secret uses', async () => {
    const { services, agent, other, app } = await installation();
    const twice = await app.inject({
      method: 'POST',
      url: secretsOf(agent.id),
      headers: owner,
      payload: {
        title: 'Acme',
        fields: [
          { label: 'Key', envName: 'ACME_KEY', sensitive: true, value: VALUE },
          { label: 'Again', envName: 'ACME_KEY', sensitive: false, value: 'ana' },
        ],
      },
    });
    expect(twice.statusCode).toBe(400);
    expect(twice.body).toContain('ACME_KEY');

    // Taken by a Secret this agent cannot even see: the name is the installation's.
    await services.secrets.create(other.id, single('ACME_KEY'), byOwner);
    const taken = await app.inject({
      method: 'POST',
      url: secretsOf(agent.id),
      headers: owner,
      payload: single('ACME_KEY'),
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toBe(
      'A Secret already uses the variable ACME_KEY. Choose another name.',
    );

    const mine = await services.secrets.create(agent.id, single('ATLAS_KEY'), byOwner);
    await expect(
      services.secrets.update(agent.id, mine.id, single('ACME_KEY'), byOwner),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('keeps a value when a field is saved without one, and refuses making a short one sensitive', async () => {
    const { services, agent } = await installation();
    const made = await services.secrets.create(
      agent.id,
      {
        title: 'Acme',
        fields: [
          { label: 'Key', envName: 'ACME_KEY', sensitive: true, value: VALUE },
          { label: 'User', envName: 'ACME_USER', sensitive: false, value: 'ana' },
          { label: 'Region', envName: 'ACME_REGION', sensitive: false, value: 'eu-west-1' },
        ],
      },
      byOwner,
    );

    const renamed = await services.secrets.update(
      agent.id,
      made.id,
      {
        fields: [
          { label: 'API key', envName: 'ACME_KEY', sensitive: true },
          { label: 'User', envName: 'ACME_USER', sensitive: false },
        ],
      },
      byOwner,
    );
    expect(renamed.fields).toEqual([
      { label: 'API key', envName: 'ACME_KEY', sensitive: true, value: null },
      { label: 'User', envName: 'ACME_USER', sensitive: false, value: 'ana' },
    ]);
    expect(await services.secrets.reveal(agent.id, ['ACME_KEY'])).toEqual({
      ACME_KEY: VALUE,
      ACME_USER: 'ana',
    });
    // A field that went away takes its value with it.
    expect(
      await services.gatewayVault.read(secretFieldKey(made.id, 'ACME_REGION')),
    ).toBeUndefined();

    await expect(
      services.secrets.update(
        agent.id,
        made.id,
        { fields: [{ label: 'User', envName: 'ACME_USER', sensitive: true }] },
        byOwner,
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'A sensitive value has at least 8 characters: type a longer one',
    });
    await expect(
      services.secrets.update(
        agent.id,
        made.id,
        { fields: [{ label: 'New', envName: 'ACME_TOKEN', sensitive: true }] },
        byOwner,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    // Made plain, a sensitive value would come back on the next read: it has to be typed again.
    await expect(
      services.secrets.update(
        agent.id,
        made.id,
        { fields: [{ label: 'Key', envName: 'ACME_KEY', sensitive: false }] },
        byOwner,
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      message:
        'ACME_KEY was sensitive, so its value is never shown: type the value again to make it not sensitive.',
    });
    expect((await services.secrets.list(agent.id))[0]?.fields).toEqual(renamed.fields);
  });

  it('stores a site as its origin and refuses one that is not https', async () => {
    const { agent, app } = await installation();
    const made = await app.inject({
      method: 'POST',
      url: secretsOf(agent.id),
      headers: owner,
      payload: single('ACME_KEY', {
        sites: [
          'https://app.example.com/login?x=1',
          'https://app.example.com/settings',
          'https://admin.example.com',
        ],
      }),
    });
    expect(made.statusCode).toBe(201);
    expect(made.json().sites).toEqual(['https://app.example.com', 'https://admin.example.com']);

    for (const site of [
      'http://app.example.com',
      'https://atlas:hunter22@app.example.com',
      'ftp://files.example.com',
      'app.example.com',
    ]) {
      const refused = await app.inject({
        method: 'PATCH',
        url: `${secretsOf(agent.id)}/${made.json().id}`,
        headers: owner,
        payload: { sites: [site] },
      });
      expect(refused.statusCode, site).toBe(400);
    }
  });
});

describe('Secrets agents make', () => {
  it('keeps a Secret others use when the agent that made it is deleted', async () => {
    const { services, agent, other } = await installation();
    const byVega = { kind: 'agent', profileId: other.id } as const;
    const shared = await services.secrets.create(other.id, single('VEGA_SHARED'), byVega);
    await services.secrets.share(other.id, shared.id, agent.id);
    const alone = await services.secrets.create(other.id, single('VEGA_ALONE'), byVega);

    await services.profiles.deleteProfile(other.id);

    const [kept, ...more] = await services.secrets.list(agent.id);
    expect(more).toEqual([]);
    expect(kept).toMatchObject({
      id: shared.id,
      createdByProfileId: null,
      profileIds: [agent.id],
      grants: [{ profileId: agent.id, grantedByProfileId: null }],
    });
    expect(await services.secrets.reveal(agent.id, ['VEGA_SHARED'])).toEqual({
      VEGA_SHARED: VALUE,
    });
    expect(
      await services.gatewayVault.read(secretFieldKey(alone.id, 'VEGA_ALONE')),
    ).toBeUndefined();
    expect(await services.secrets.masks()).toEqual([VALUE]);
  });

  it('lets an agent change and delete only the Secrets it made', async () => {
    const { services, agent, other } = await installation();
    const byAtlas = { kind: 'agent', profileId: agent.id } as const;
    const theOwners = await services.secrets.create(agent.id, single('OWNER_KEY'), byOwner);
    const vegas = await services.secrets.create(other.id, single('VEGA_KEY'), {
      kind: 'agent',
      profileId: other.id,
    });
    await services.secrets.share(other.id, vegas.id, agent.id);

    for (const id of [theOwners.id, vegas.id]) {
      await expect(
        services.secrets.update(agent.id, id, { title: 'Mine now' }, byAtlas),
      ).rejects.toMatchObject({
        statusCode: 403,
        message:
          'This Secret was made by the owner or another agent: you can use it, not change it.',
      });
      await expect(services.secrets.remove(agent.id, id, byAtlas)).rejects.toMatchObject({
        statusCode: 403,
      });
    }

    const made = await services.secrets.create(
      agent.id,
      single('ATLAS_KEY', { profileIds: [other.id] }),
      byAtlas,
    );
    // An agent's own `profileIds` are not its to set: it alone gets the Secret it made.
    expect(made).toMatchObject({
      createdByProfileId: agent.id,
      profileIds: [agent.id],
      grants: [{ profileId: agent.id, grantedByProfileId: agent.id }],
    });
    await expect(
      services.secrets.update(agent.id, made.id, { profileIds: [agent.id, other.id] }, byAtlas),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(
      await services.secrets.update(agent.id, made.id, { title: 'Atlas key' }, byAtlas),
    ).toMatchObject({ title: 'Atlas key' });
    expect(await services.secrets.remove(agent.id, made.id, byAtlas)).toEqual({ id: made.id });
    expect(await services.gatewayVault.read(secretFieldKey(made.id, 'ATLAS_KEY'))).toBeUndefined();
  });

  it('shares a Secret and records who shared it', async () => {
    const { services, agent, other } = await installation();
    const made = await services.secrets.create(agent.id, single('ATLAS_KEY'), byOwner);

    expect(await services.secrets.share(agent.id, made.id, other.id)).toEqual({ shared: true });
    const [seen] = await services.secrets.list(other.id);
    expect(seen?.id).toBe(made.id);
    expect(seen?.grants).toContainEqual(
      expect.objectContaining({ profileId: other.id, grantedByProfileId: agent.id }),
    );
    expect(await services.secrets.share(agent.id, made.id, other.id)).toEqual({ shared: false });

    const vegas = await services.secrets.create(other.id, single('VEGA_KEY'), byOwner);
    await expect(services.secrets.share(agent.id, vegas.id, other.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      services.secrets.share(agent.id, made.id, '00000000-0000-4000-8000-000000000000'),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('masking a secret in what a command prints', () => {
  it('finds the value wherever base64 puts it in a longer text', () => {
    const forms = new Set(secretForms(VALUE));
    for (const before of ['', 'u', 'us', 'user:']) {
      const encoded = Buffer.from(`${before}${VALUE}trailing`).toString('base64');
      expect(redactText(encoded, forms)).toContain('[REDACTED]');
    }
  });
});

async function shellOf(services: Awaited<ReturnType<typeof testServices>>, profileId: string) {
  const session = await services.sessions.createSession(profileId, { title: 'Shell' });
  const run = await services.runs.submit(profileId, session.id, { text: 'Hi', requestKey: 'one' });
  const decisions = new Decisions(
    services.store,
    services.gatewayVault,
    async () => Response.json({}),
    () => {},
  );
  const offered = await services.secrets.usable(profileId);
  const tools = profileTools(
    { ...services, decisions, store: services.store },
    run,
    undefined,
    undefined,
    [],
    undefined,
    false,
    [],
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    offered.length
      ? { offered, reveal: (names) => services.secrets.reveal(profileId, names) }
      : undefined,
  );
  const runCommand = tools.run_command as unknown as {
    description: string;
    inputSchema: { safeParse: (input: unknown) => { success: boolean } };
    execute: (input: unknown, options: unknown) => Promise<{ stdout: string; stderr: string }>;
  };
  return {
    tool: runCommand,
    run: (input: unknown) =>
      runCommand.execute(input, { toolCallId: 'test', messages: [], context: {} }),
  };
}

describe('lending a secret to one command', () => {
  it('hands the command the variable and masks it however it is printed', async () => {
    const { services, agent } = await installation();
    await services.secrets.create(
      agent.id,
      single('ASSEMBLYAI_API_KEY', { description: 'Word timings' }),
      byOwner,
    );
    const shell = await shellOf(services, agent.id);
    expect(shell.tool.description).toContain('ASSEMBLYAI_API_KEY (Word timings)');
    expect(shell.tool.description).not.toContain(VALUE);

    const result = await shell.run({
      command: [
        'printf "plain:%s\\n" "$ASSEMBLYAI_API_KEY"',
        'printf "%s" "$ASSEMBLYAI_API_KEY" | base64',
        'printf "user:%s" "$ASSEMBLYAI_API_KEY" | base64',
        `node -e 'process.stdout.write(encodeURIComponent(process.env.ASSEMBLYAI_API_KEY))'`,
        'printf "%s" "$ASSEMBLYAI_API_KEY" >&2',
      ].join('; '),
      secrets: ['ASSEMBLYAI_API_KEY'],
      timeoutMs: 10_000,
    });

    expect(result.stdout).toContain('plain:[REDACTED]');
    expect(leaks(result.stdout)).toEqual([]);
    expect(leaks(result.stderr)).toEqual([]);
    expect(result.stderr).toContain('[REDACTED]');
    expect((await services.secrets.list(agent.id))[0]?.lastUsedAt).not.toBeNull();
  });

  it('gives a command without `secrets` none of them', async () => {
    const { services, agent } = await installation();
    await services.secrets.create(agent.id, single('ASSEMBLYAI_API_KEY'), byOwner);
    const shell = await shellOf(services, agent.id);

    const result = await shell.run({
      command: 'printf "[%s]" "$ASSEMBLYAI_API_KEY"',
      timeoutMs: 10_000,
    });
    expect(result.stdout).toBe('[]');
  });

  it('refuses a secret this agent may not use before the command runs', async () => {
    const { services, agent, other } = await installation();
    const made = await services.secrets.create(agent.id, single('ASSEMBLYAI_API_KEY'), byOwner);
    await services.secrets.create(other.id, single('VEGA_TOKEN'), byOwner);
    const shell = await shellOf(services, agent.id);
    const marker = join(root, `${agent.id}-ran`);

    // Not in the call's own schema: the model's call is refused before it is approved or run.
    expect(
      shell.tool.inputSchema.safeParse({ command: 'true', secrets: ['VEGA_TOKEN'] }).success,
    ).toBe(false);
    expect(
      shell.tool.inputSchema.safeParse({ command: 'true', secrets: ['ASSEMBLYAI_API_KEY'] })
        .success,
    ).toBe(true);
    // An approved call is run from what was stored, past the schema: it is refused there too.
    const result = await shell.run({
      command: `touch ${marker}`,
      secrets: ['VEGA_TOKEN'],
      timeoutMs: 10_000,
    });
    expect(result.stderr).toContain('may not use VEGA_TOKEN');
    expect(existsSync(marker)).toBe(false);

    // Taken away after the run started: refused the same way.
    await services.secrets.remove(agent.id, made.id, byOwner);
    const gone = await shell.run({
      command: `touch ${marker}`,
      secrets: ['ASSEMBLYAI_API_KEY'],
      timeoutMs: 10_000,
    });
    expect(gone.stderr).toContain('may not use ASSEMBLYAI_API_KEY');
    expect(existsSync(marker)).toBe(false);
  });
});

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

describe('a command with a secret in a conversation that asks first', () => {
  it('waits for the owner on a card that names the secret, and records no value anywhere', async () => {
    const { services, agent } = await installation();
    await services.secrets.create(
      agent.id,
      single('ASSEMBLYAI_API_KEY', { description: 'Word timings' }),
      byOwner,
    );
    const session = await services.sessions.createSession(agent.id, {
      title: 'Captions',
      channel: 'api',
    });
    const seen: string[] = [];
    const command =
      'printf "%s" "$ASSEMBLYAI_API_KEY"; printf "user:%s" "$ASSEMBLYAI_API_KEY" | base64';
    const runtime = new AgentRuntime(services, () =>
      mockModel({
        doGenerate: async (options) => {
          const prompt = JSON.stringify(options.prompt);
          // A card the model writes would be the agent's word about itself: none is asked for.
          if (options.responseFormat?.type === 'json') throw new Error('No card from the model');
          if (prompt.includes('approved the action')) {
            seen.push(prompt);
            return stop('Done.');
          }
          if (!prompt.includes('"load_tools"')) {
            return call('load', 'load_tools', { groups: ['shell'] });
          }
          return call('cmd-1', 'run_command', {
            command,
            secrets: ['ASSEMBLYAI_API_KEY'],
            timeoutMs: 10_000,
          });
        },
      }),
    );

    const run = await services.runs.submit(agent.id, session.id, {
      text: 'Fetch the word timings',
      requestKey: 'one',
    });
    await runtime.execute(agent.id, run.id);

    const parked = await services.runs.run(agent.id, run.id);
    expect(parked.status).toBe('waiting');
    expect(parked.approval).toMatchObject({
      toolName: 'run_command',
      title: 'Run a command with the secret ASSEMBLYAI_API_KEY',
      detail: command,
    });
    expect(leaks(JSON.stringify(parked))).toEqual([]);
    expect(await readRunAction(services.store.db, run.id)).toMatchObject({
      input: { secrets: ['ASSEMBLYAI_API_KEY'] },
    });

    const resume = await services.runs.decideApproval(agent.id, run.id, { decision: 'approve' });
    await runtime.execute(agent.id, resume.id);

    expect(await services.runs.run(agent.id, resume.id)).toMatchObject({ status: 'completed' });
    expect(seen.at(-1)).toContain('[REDACTED]');
    expect(leaks(seen.join('\n'))).toEqual([]);
    const timeline = await services.sessions.timeline(agent.id, session.id);
    expect(JSON.stringify(timeline)).toContain('[REDACTED]');
    expect(leaks(JSON.stringify(timeline))).toEqual([]);
    expect(leaks(await everythingStored(services))).toEqual([]);

    const sent: string[] = [];
    await new Telemetry(services.store, {
      env: {},
      fetcher: (async (_url: string, init?: RequestInit) => {
        sent.push(String(init?.body));
        return new Response('{}');
      }) as typeof fetch,
      version: '1.6.0',
      mode: 'server',
      role: 'all',
      destination: { key: 'phc_synthetic_key', host: 'https://posthog.example.test' },
    }).reportIfDue();
    expect(sent.join('')).toContain('run_command');
    expect(leaks(sent.join(''))).toEqual([]);
  });
});

describe('a command with a secret on Auto', () => {
  it('tells the guardrail which secrets it gets', async () => {
    const prompts: string[] = [];
    const judge = guardrail({
      model: {
        model: mockModel({
          doGenerate: async (options) => {
            prompts.push(JSON.stringify(options.prompt));
            return stop('ALLOW');
          },
        }),
        subscription: false,
        account: async () => {},
      },
    });

    await judge({
      toolName: 'run_command',
      kind: 'machine',
      input: {
        command: 'curl -H "Authorization: $ASSEMBLYAI_API_KEY" https://api.example',
        secrets: ['ASSEMBLYAI_API_KEY'],
      },
    });
    expect(prompts[0]).toContain("receives the owner's secrets ASSEMBLYAI_API_KEY");
  });

  it('writes its card from the call itself', () => {
    expect(
      plainDescription({
        toolName: 'run_command',
        kind: 'machine',
        input: { command: 'make upload', secrets: ['S3_KEY', 'S3_SECRET'] },
      }),
    ).toMatchObject({
      title: 'Run a command with the secrets S3_KEY, S3_SECRET',
      detail: 'make upload',
    });
  });
});
