import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { protectionFor } from '../src/agent/guard.js';
import { guardrail, ruleVerdict } from '../src/agent/guardrail.js';
import { AgentRuntime } from '../src/agent/runtime.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'jian-guardrail-')));
const previousRoot = process.env.JIAN_WORKSPACES;
process.env.JIAN_WORKSPACES = root;

afterAll(() => {
  if (previousRoot === undefined) delete process.env.JIAN_WORKSPACES;
  else process.env.JIAN_WORKSPACES = previousRoot;
});

const run = (command: string) => ruleVerdict('run_command', 'machine', { command });

describe('the guardrail’s fixed rules', () => {
  it('refuses what destroys data, infrastructure or backups, or prints credentials', () => {
    for (const command of [
      'rm -rf /',
      'sudo rm -rf ~ ',
      'rm -fr * && echo done',
      'psql "$DATABASE_URL" -c "DROP DATABASE app"',
      'psql -c "DELETE FROM users"',
      'psql -c "UPDATE accounts SET balance = 0;"',
      'mysql -e "TRUNCATE orders"',
      'terraform destroy -auto-approve',
      'kubectl delete namespace production',
      'docker volume rm postgres-data',
      'aws s3 rm s3://company-backups --recursive',
      'rm -rf /srv/backups/2026',
      'cat .env',
      'cat ~/.ssh/id_ed25519',
      'printenv',
      'echo $STRIPE_SECRET_KEY',
    ]) {
      expect(run(command), command).toMatchObject({ allowed: false });
    }
  });

  it('lets ordinary work through, changes and scoped deletes included', () => {
    for (const command of [
      'rm -rf node_modules dist',
      'psql -c "DELETE FROM sessions WHERE expires_at < now()"',
      'psql -c "UPDATE accounts SET plan = \'pro\' WHERE id = 7;"',
      'git commit -m "drop the backup option from settings"',
      'cat ~/.ssh/id_ed25519.pub',
      'pnpm test && git push origin feature',
      'terraform plan',
    ]) {
      expect(run(command), command).toEqual({ allowed: true });
    }
    // Code that holds such a statement is written, not run.
    expect(
      ruleVerdict('write_file', 'machine', {
        path: 'migrations/9.sql',
        content: 'DROP TABLE old;',
      }),
    ).toEqual({ allowed: true });
    // A service runs what it is handed: a database's query is a query.
    expect(ruleVerdict('mcp__db__query', 'service', { sql: 'DROP TABLE users' })).toMatchObject({
      allowed: false,
    });
  });
});

describe('the guardrail’s judgment', () => {
  const action = { toolName: 'mcp__infra__apply', kind: 'service' as const, input: { plan: 'x' } };

  it('takes Jev’s answer when it gives one, and lets the action run when nobody can answer', async () => {
    const asked = (yes: number | undefined) =>
      guardrail({
        judge: async () =>
          yes === undefined ? undefined : { catastrophic: { type: 'noul', noul: yes } },
      })(action);

    expect(await asked(0.95)).toMatchObject({ allowed: false });
    expect(await asked(0.2)).toEqual({ allowed: true });
    expect(await asked(undefined)).toEqual({ allowed: true });
  });
});

describe('protection on Auto', () => {
  it('guards instead of waiting, for subagents and a channel’s contacts too', () => {
    for (const [subagent, channel] of [
      [false, 'api'],
      [true, 'api'],
      [false, 'whatsapp'],
    ] as const) {
      expect(protectionFor({ mode: 'auto', subagent, channel, contactCanApprove: false })).toEqual({
        mode: 'guard',
      });
    }
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

/** An agent that writes one file, judged by its own model with the verdict given. */
async function setup(verdict: string) {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const session = await services.sessions.createSession(profile.id, {
    title: 'Work',
    channel: 'api',
  });
  await services.sessions.setProtection(profile.id, session.id, { protection: 'auto' });
  const file = join(root, profile.id, 'notes.txt');
  const model = mockModel({
    doGenerate: async (options) => {
      const prompt = JSON.stringify(options.prompt);
      if (prompt.includes('You are the guardrail')) return stop(verdict);
      // The write was asked for: say how it went, as the tool's result says.
      if (prompt.includes('write-1')) {
        return stop(prompt.includes('this conversation is on Auto') ? 'Refused.' : 'Written.');
      }
      if (!prompt.includes('"load_tools"'))
        return call('load', 'load_tools', { groups: ['files'] });
      return call('write-1', 'write_file', { path: file, content: 'hello' });
    },
  });
  const runtime = new AgentRuntime(services, () => model);
  const started = await services.runs.submit(profile.id, session.id, {
    text: 'Write the notes',
    requestKey: crypto.randomUUID(),
  });
  await runtime.execute(profile.id, started.id);

  return { file, finished: await services.runs.run(profile.id, started.id) };
}

describe('a conversation on Auto', () => {
  it('acts without waiting for anyone when the guardrail allows it', async () => {
    const { file, finished } = await setup('ALLOW');

    expect(finished.status).toBe('completed');
    expect(finished.approval).toBeUndefined();
    expect(existsSync(file)).toBe(true);
  });

  it('refuses a catastrophic action, tells the agent, and the run carries on', async () => {
    const { file, finished } = await setup('BLOCK: it overwrites the production database');

    expect(finished.status).toBe('completed');
    expect(finished.output).toBe('Refused.');
    expect(existsSync(file)).toBe(false);
  });
});
