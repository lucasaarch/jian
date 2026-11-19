import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reservedCommandSecretName } from '@jian/contracts';
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
import { secretForms } from '../src/command-secrets/forms.js';
import { commandSecretKey } from '../src/command-secrets/service.js';
import { Decisions } from '../src/decisions/service.js';
import { readRunAction } from '../src/runs/repository.js';
import { Telemetry } from '../src/telemetry/service.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'jian-command-secrets-')));
const previousRoot = process.env.JIAN_WORKSPACES;
process.env.JIAN_WORKSPACES = root;

afterAll(() => {
  if (previousRoot === undefined) delete process.env.JIAN_WORKSPACES;
  else process.env.JIAN_WORKSPACES = previousRoot;
});

const token = 'synthetic-command-secrets-token-32-chars';
const owner = { authorization: `Bearer ${token}` };
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

const secretsOf = (profileId: string) => `/v1/profiles/${profileId}/command-secrets`;

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

describe('keeping a command secret', () => {
  it('never returns the value, from any route', async () => {
    const { agent, app } = await installation();
    const made = await app.inject({
      method: 'POST',
      url: secretsOf(agent.id),
      headers: owner,
      payload: { name: 'ASSEMBLYAI_API_KEY', value: VALUE, description: 'Word timings' },
    });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({
      name: 'ASSEMBLYAI_API_KEY',
      description: 'Word timings',
      profileIds: [agent.id],
      lastUsedAt: null,
    });
    expect(made.body).not.toContain(VALUE);

    const listed = await app.inject({ url: secretsOf(agent.id), headers: owner });
    expect(listed.json()).toHaveLength(1);
    expect(listed.body).not.toContain(VALUE);

    const replaced = await app.inject({
      method: 'PATCH',
      url: `${secretsOf(agent.id)}/ASSEMBLYAI_API_KEY`,
      headers: owner,
      payload: { value: `${VALUE}-rotated` },
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.body).not.toContain(VALUE);
  });

  it('refuses a name a command already has, or one of Jian’s own', async () => {
    const { agent, app } = await installation();
    for (const name of ['PATH', 'HOME', 'JIAN_TOOLBOX', 'LC_ALL', 'LD_PRELOAD', 'lowercase_key']) {
      const response = await app.inject({
        method: 'POST',
        url: secretsOf(agent.id),
        headers: owner,
        payload: { name, value: VALUE },
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
    for (const name of Object.keys(env)) expect(reservedCommandSecretName(name), name).toBe(true);
  });

  it('refuses a request with no credential', async () => {
    const { agent, app } = await installation();
    const response = await app.inject({ url: secretsOf(agent.id) });
    expect(response.statusCode).toBe(401);
  });

  it('lets a paired phone see the names but not add, replace or delete one', async () => {
    const { agent, app } = await installation();
    await app.inject({
      method: 'POST',
      url: secretsOf(agent.id),
      headers: owner,
      payload: { name: 'ASSEMBLYAI_API_KEY', value: VALUE },
    });
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
    expect(seen.body).not.toContain(VALUE);
    for (const request of [
      {
        method: 'POST' as const,
        url: secretsOf(agent.id),
        payload: { name: 'S3_KEY', value: VALUE },
      },
      {
        method: 'PATCH' as const,
        url: `${secretsOf(agent.id)}/ASSEMBLYAI_API_KEY`,
        payload: { value: 'sk_phone_replacement' },
      },
      { method: 'DELETE' as const, url: `${secretsOf(agent.id)}/ASSEMBLYAI_API_KEY` },
    ]) {
      expect((await app.inject({ ...request, headers: phone })).statusCode).toBe(403);
    }
  });

  it('keeps another agent’s secret out of reach until it is shared', async () => {
    const { services, agent, other, app } = await installation();
    await app.inject({
      method: 'POST',
      url: secretsOf(agent.id),
      headers: owner,
      payload: { name: 'ASSEMBLYAI_API_KEY', value: VALUE },
    });

    expect((await app.inject({ url: secretsOf(other.id), headers: owner })).json()).toEqual([]);
    const changed = await app.inject({
      method: 'PATCH',
      url: `${secretsOf(other.id)}/ASSEMBLYAI_API_KEY`,
      headers: owner,
      payload: { profileIds: [other.id] },
    });
    expect(changed.statusCode).toBe(404);
    await expect(
      services.commandSecrets.reveal(other.id, ['ASSEMBLYAI_API_KEY']),
    ).rejects.toMatchObject({ statusCode: 403 });

    await app.inject({
      method: 'PATCH',
      url: `${secretsOf(agent.id)}/ASSEMBLYAI_API_KEY`,
      headers: owner,
      payload: { profileIds: [agent.id, other.id] },
    });
    expect(await services.commandSecrets.reveal(other.id, ['ASSEMBLYAI_API_KEY'])).toEqual({
      ASSEMBLYAI_API_KEY: VALUE,
    });
  });

  it('goes with the last agent that could use it, value and all', async () => {
    const { services, agent, other } = await installation();
    await services.commandSecrets.create(agent.id, { name: 'ONLY_ATLAS', value: VALUE });
    await services.commandSecrets.create(agent.id, {
      name: 'SHARED_KEY',
      value: VALUE,
      profileIds: [other.id],
    });

    await services.profiles.deleteProfile(agent.id);

    expect(await services.gatewayVault.read(commandSecretKey('ONLY_ATLAS'))).toBeUndefined();
    expect((await services.commandSecrets.list(other.id)).map((item) => item.name)).toEqual([
      'SHARED_KEY',
    ]);
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
  const offered = await services.commandSecrets.usable(profileId);
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
      ? { offered, reveal: (names) => services.commandSecrets.reveal(profileId, names) }
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
    await services.commandSecrets.create(agent.id, {
      name: 'ASSEMBLYAI_API_KEY',
      value: VALUE,
      description: 'Word timings',
    });
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
    expect((await services.commandSecrets.list(agent.id))[0]?.lastUsedAt).not.toBeNull();
  });

  it('gives a command without `secrets` none of them', async () => {
    const { services, agent } = await installation();
    await services.commandSecrets.create(agent.id, { name: 'ASSEMBLYAI_API_KEY', value: VALUE });
    const shell = await shellOf(services, agent.id);

    const result = await shell.run({
      command: 'printf "[%s]" "$ASSEMBLYAI_API_KEY"',
      timeoutMs: 10_000,
    });
    expect(result.stdout).toBe('[]');
  });

  it('refuses a secret this agent may not use before the command runs', async () => {
    const { services, agent, other } = await installation();
    await services.commandSecrets.create(agent.id, { name: 'ASSEMBLYAI_API_KEY', value: VALUE });
    await services.commandSecrets.create(other.id, { name: 'VEGA_TOKEN', value: VALUE });
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
    await services.commandSecrets.remove(agent.id, 'ASSEMBLYAI_API_KEY');
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
    await services.commandSecrets.create(agent.id, {
      name: 'ASSEMBLYAI_API_KEY',
      value: VALUE,
      description: 'Word timings',
    });
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
