import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RemoteTask } from '@jian/contracts';
import type { Tool, ToolSet } from 'ai';
import { like } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { githubGitTools } from '../src/agent/github-git.js';
import { localPlace, remotePlace } from '../src/agent/github-git-place.js';
import { plainDescription } from '../src/agent/guard.js';
import { ruleVerdict } from '../src/agent/guardrail.js';
import { redactOutput } from '../src/agent/results.js';
import { AgentRuntime } from '../src/agent/runtime.js';
import { workspaceOf } from '../src/agent/workspace.js';
import { GitHubIntegrations } from '../src/integrations/github.js';
import {
  gatewaySecrets,
  githubInstallations,
  projects,
  remoteTasks,
} from '../src/storage/schema.js';
import { bareRepository, git, gitServer } from './helpers/git-server.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'jian-github-git-')));
const previousRoot = process.env.JIAN_WORKSPACES;
process.env.JIAN_WORKSPACES = join(root, 'workspaces');
const servers: Array<{ close(): Promise<void> }> = [];

afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
  if (previousRoot === undefined) delete process.env.JIAN_WORKSPACES;
  else process.env.JIAN_WORKSPACES = previousRoot;
});

const model = { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' };
const REPOSITORIES = {
  '101': [{ id: 42, owner: 'octo-example', name: 'site' }],
  '202': [{ id: 7, owner: 'mona', name: 'notes' }],
} as Record<string, Array<{ id: number; owner: string; name: string }>>;

/**
 * A GitHub with two connected accounts, its API and its git endpoint both faked: the API mints
 * numbered tokens, each for the repositories asked for, and git accepts a token only for a
 * repository it was minted for.
 */
async function github({ registered = true, accounts = true } = {}) {
  const services = await testServices();
  const minted: Array<{ token: string; installation: string; repositoryIds: number[] }> = [];

  if (registered) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await services.gatewayVault.put(
      'github-app-config',
      JSON.stringify({
        appId: 1,
        slug: 'jian-example',
        clientId: 'synthetic-client',
        clientSecret: 'synthetic-secret',
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }),
    );
  }

  const api = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);

    if (mint?.[1]) {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as { repository_ids?: number[] })
        : {};
      const token = `synthetic-git-token-${minted.length + 1}`;
      minted.push({ token, installation: mint[1], repositoryIds: body.repository_ids ?? [] });
      return Response.json({ token, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (url.pathname === '/installation/repositories') {
      const token = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '');
      const installation = minted.find((item) => item.token === token)?.installation ?? '';
      return Response.json({
        repositories: (REPOSITORIES[installation] ?? []).map(({ id, owner, name }) => ({
          id,
          name,
          full_name: `${owner}/${name}`,
          owner: { login: owner },
          private: true,
          html_url: `https://github.com/${owner}/${name}`,
          clone_url: `https://github.com/${owner}/${name}.git`,
          default_branch: 'main',
        })),
      });
    }
    return new Response('not found', { status: 404 });
  };

  const repositories = mkdtempSync(join(root, 'github-'));
  bareRepository(repositories, 'octo-example/site');
  bareRepository(repositories, 'mona/notes');
  const server = await gitServer(repositories, (token, fullName) => {
    const lent = minted.find((item) => item.token === token);
    const repository = Object.values(REPOSITORIES)
      .flat()
      .find(({ owner, name }) => `${owner}/${name}` === fullName);
    return Boolean(
      lent &&
        repository &&
        (REPOSITORIES[lent.installation] ?? []).includes(repository) &&
        (!lent.repositoryIds.length || lent.repositoryIds.includes(repository.id)),
    );
  });
  servers.push(server);

  const integrations = new GitHubIntegrations(
    services.store,
    services.gatewayVault,
    'https://jian.example.test',
    api as typeof fetch,
    Date.now,
    server.origin,
  );
  const organization = randomUUID();
  if (accounts) {
    await services.store.db.insert(githubInstallations).values([
      {
        id: organization,
        installationId: 101,
        accountId: 1,
        login: 'octo-example',
        type: 'Organization',
      },
      { id: randomUUID(), installationId: 202, accountId: 2, login: 'mona', type: 'User' },
    ]);
  }
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model,
  });
  const home = await workspaceOf(profile.id);
  const lent = new Set<string>();
  const tools = (place = localPlace(profile.id, { readOnly: [], writable: [] })) =>
    githubGitTools({
      github: integrations,
      profileId: profile.id,
      place,
      lend: (secret) => lent.add(secret),
    });

  return {
    services,
    integrations,
    minted,
    server,
    repositories,
    organization,
    profile,
    home,
    lent,
    tools,
  };
}

const run = (tools: ToolSet, input: Record<string, unknown>) =>
  (tools.github_git as Tool<Record<string, unknown>>).execute?.(input, {
    toolCallId: randomUUID(),
    messages: [],
    context: {},
  }) as Promise<Record<string, unknown>>;

const leaksNothing = (text: string, secrets: Iterable<string>) => {
  for (const secret of secrets) expect(text).not.toContain(secret);
  expect(text).not.toContain('x-access-token');
};

describe('github_git in the gateway workspace', () => {
  it("clones with the App's token, and leaves no credential in the checkout", async () => {
    const { tools, home, server, minted, lent } = await github();

    const cloned = await run(tools(), { action: 'clone', repository: 'octo-example/site' });

    expect(cloned).toMatchObject({
      ok: true,
      repository: 'octo-example/site',
      path: join(home, 'site'),
    });
    // Minted for that repository alone, and sent to GitHub as the header of that command.
    expect(minted.at(-1)).toMatchObject({ installation: '101', repositoryIds: [42] });
    const token = minted.at(-1)?.token ?? '';
    expect(lent).toContain(token);
    expect(server.headers).toContain(
      `basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    );
    // The checkout keeps the plain URL and nothing else.
    const checkout = join(home, 'site');
    expect(git(checkout, 'remote', 'get-url', 'origin')).toBe(
      `${server.origin}/octo-example/site.git`,
    );
    leaksNothing(readFileSync(join(checkout, '.git', 'config'), 'utf8'), lent);
  });

  it('pushes a checkout whose origin is SSH over HTTPS with the token, and leaves origin as it was', async () => {
    const { tools, home, repositories, lent } = await github();
    await run(tools(), { action: 'clone', repository: 'octo-example/site' });
    const checkout = join(home, 'site');
    git(checkout, 'remote', 'set-url', 'origin', 'git@github.com:octo-example/site.git');
    git(checkout, 'checkout', '-q', '-b', 'feat/x');
    git(checkout, 'commit', '-q', '--allow-empty', '-m', 'Change');

    const pushed = await run(tools(), {
      action: 'push',
      repository: 'octo-example/site',
      path: checkout,
      branch: 'feat/x',
    });

    expect(pushed).toMatchObject({ ok: true, action: 'push' });
    expect(git(join(repositories, 'octo-example/site.git'), 'rev-parse', 'refs/heads/feat/x')).toBe(
      git(checkout, 'rev-parse', 'HEAD'),
    );
    expect(git(checkout, 'config', '--get', 'remote.origin.url')).toBe(
      'git@github.com:octo-example/site.git',
    );
    leaksNothing(readFileSync(join(checkout, '.git', 'config'), 'utf8'), lent);
  });

  it('says a push that is not a fast-forward must pull first', async () => {
    const { tools, home } = await github();
    await run(tools(), { action: 'clone', repository: 'octo-example/site', path: 'one' });
    await run(tools(), { action: 'clone', repository: 'octo-example/site', path: 'two' });
    for (const name of ['one', 'two']) {
      git(join(home, name), 'commit', '-q', '--allow-empty', '-m', `From ${name}`);
    }
    const push = (name: string) =>
      run(tools(), {
        action: 'push',
        repository: 'octo-example/site',
        path: join(home, name),
        branch: 'main',
      });

    expect(await push('one')).toMatchObject({ ok: true });
    expect(await push('two')).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/non-fast-forward.*Pull/),
    });
  });

  it('lends nothing to a checkout whose origin is another repository', async () => {
    const { tools, home, server, minted } = await github();
    await run(tools(), { action: 'clone', repository: 'octo-example/site' });
    const sent = server.headers.length;

    await expect(
      run(tools(), {
        action: 'push',
        repository: 'mona/notes',
        path: join(home, 'site'),
        branch: 'main',
      }),
    ).rejects.toThrow(/origin of .* is .*octo-example\/site\.git, not mona\/notes/);
    // The token minted for mona/notes never left the gateway.
    expect(minted.at(-1)?.repositoryIds).toEqual([7]);
    expect(server.headers.slice(sent)).toEqual([]);
  });
});

describe('what github_git reaches', () => {
  it('reaches only the repository of a project bound to one', async () => {
    const { services, integrations, organization, profile } = await github();
    const project = randomUUID();
    await services.store.db.insert(projects).values({
      id: project,
      profileId: profile.id,
      name: 'Site',
      repositoryUrl: 'https://github.com/octo-example/site.git',
      githubAccountId: organization,
      githubRepositoryId: 42,
    });

    await expect(
      integrations.gitAccess(profile.id, project, 'Octo-Example/Site'),
    ).resolves.toMatchObject({ repository: 'octo-example/site', defaultBranch: 'main' });
    await expect(integrations.gitAccess(profile.id, project, 'mona/notes')).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringMatching(/bound to octo-example\/site, and mona\/notes is outside it/),
    });
  });

  it('reaches every repository the App was granted outside a project', async () => {
    const { integrations, profile } = await github();

    for (const repository of ['octo-example/site', 'mona/notes']) {
      await expect(integrations.gitAccess(profile.id, null, repository)).resolves.toMatchObject({
        repository,
      });
    }
  });

  it('says to grant a repository the App cannot reach, or to install it on its owner', async () => {
    const { integrations, profile } = await github();

    await expect(integrations.gitAccess(profile.id, null, 'mona/diary')).rejects.toMatchObject({
      statusCode: 404,
      message: expect.stringMatching(/cannot reach mona\/diary.*grant it on GitHub/),
    });
    await expect(integrations.gitAccess(profile.id, null, 'stranger/tools')).rejects.toMatchObject({
      statusCode: 404,
      message: expect.stringMatching(/not installed on stranger/),
    });
  });

  it('says no GitHub App is connected, or no account is', async () => {
    const none = await github({ registered: false });
    await expect(run(none.tools(), { action: 'clone', repository: 'mona/notes' })).rejects.toThrow(
      /No GitHub App is connected/,
    );
    expect(none.minted).toEqual([]);

    const empty = await github({ accounts: false });
    await expect(
      empty.integrations.gitAccess(empty.profile.id, null, 'mona/notes'),
    ).rejects.toThrow(/no GitHub account is connected/);
  });
});

describe('github_git on the machine a conversation targets', () => {
  /** A worker that answers each task it is handed with `answer`, until told to stop. */
  function worker(
    services: Awaited<ReturnType<typeof testServices>>,
    machine: { id: string; token: string },
    answer: (task: RemoteTask) => { exitCode: number; stdout: string; stderr: string },
  ) {
    const tasks: RemoteTask[] = [];
    let stopped = false;
    const loop = (async () => {
      while (!stopped) {
        const { task } = await services.remote.poll(
          machine.id,
          `Bearer ${machine.token}`,
          'linux-x64',
          'shell-secret-env-v1',
        );
        if (!task) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          continue;
        }
        tasks.push(task as RemoteTask);
        await services.remote.complete(machine.id, task.id, `Bearer ${machine.token}`, {
          taskId: task.id,
          timedOut: false,
          ...answer(task as RemoteTask),
        });
      }
    })();
    return {
      tasks,
      stop: async () => {
        stopped = true;
        await loop;
      },
    };
  }

  it('carries the credential in the task alone, never its command, row or result', async () => {
    const { services, tools, profile, lent } = await github();
    const machine = await services.remote.create({ name: 'Studio' });
    const remote = worker(services, machine, (task) =>
      task.command?.includes('config')
        ? {
            exitCode: 0,
            stdout: 'remote.origin.url git@github.com:octo-example/site.git\n',
            stderr: '',
          }
        : // A worker that echoes what it was given: the run must still show none of it.
          { exitCode: 0, stdout: '', stderr: JSON.stringify(task.env) },
    );
    await services.remote.poll(
      machine.id,
      `Bearer ${machine.token}`,
      'linux-x64',
      'shell-secret-env-v1',
    );

    const pushed = await run(tools(remotePlace(profile.id, machine.id, services.remote)), {
      action: 'push',
      repository: 'octo-example/site',
      path: '/home/owner/site',
      branch: 'feat/x',
    });
    await remote.stop();

    const [query, push] = remote.tasks;
    expect(query?.env).toBeUndefined();
    expect(push?.command).toBe(
      "git '-C' '/home/owner/site' 'push' '--set-upstream' 'origin' 'refs/heads/feat/x:refs/heads/feat/x'",
    );
    // The SSH origin is sent to HTTPS, with the token as the header, for that command only.
    expect(Object.values(push?.env ?? {})).toEqual(
      expect.arrayContaining(['git@github.com:octo-example/site.git', '0']),
    );
    const secrets = [...lent];
    expect(secrets.some((secret) => JSON.stringify(push?.env).includes(secret))).toBe(true);

    // What the gateway records of a task names the variables, never their values. (What a
    // worker sends back is its own to mask; the remote-core tests hold it to that.)
    const rows = await services.store.db
      .select({ command: remoteTasks.command, payload: remoteTasks.payload })
      .from(remoteTasks);
    for (const secret of secrets) expect(JSON.stringify(rows)).not.toContain(secret);
    expect(rows.map((row) => row.payload)).toContainEqual({
      env: expect.arrayContaining([
        'GIT_CONFIG_COUNT',
        'GIT_CONFIG_VALUE_0',
        'GIT_TERMINAL_PROMPT',
      ]),
    });
    expect(
      await services.store.db
        .select()
        .from(gatewaySecrets)
        .where(like(gatewaySecrets.name, 'remote-task-env:%')),
    ).toEqual([]);
    leaksNothing(JSON.stringify(redactOutput(pushed, lent)), lent);
  });

  it('asks for an update before handing credentials to an older worker, and says when the machine is offline', async () => {
    const { services, tools, profile } = await github();
    const older = await services.remote.create({ name: 'Laptop' });
    await services.remote.poll(older.id, `Bearer ${older.token}`, 'darwin-arm64', '');

    await expect(
      run(tools(remotePlace(profile.id, older.id, services.remote)), {
        action: 'clone',
        repository: 'mona/notes',
      }),
    ).rejects.toThrow(/cannot take credentials.*update_remote_machine/);

    const away = await services.remote.create({ name: 'Desk' });
    await expect(
      run(tools(remotePlace(profile.id, away.id, services.remote)), {
        action: 'clone',
        repository: 'mona/notes',
      }),
    ).rejects.toThrow(/Desk is offline/);
  });
});

/** The integration with no MCP server to attach: the run reaches no network but the fakes. */
const gitOnly = (integrations: GitHubIntegrations) => ({
  mcpAccess: async () => [],
  gitAccess: integrations.gitAccess.bind(integrations),
});

describe('github_git under protection', () => {
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

  /** A conversation whose agent makes one github_git call, then says what came back. */
  async function conversation(protection: 'ask' | 'auto' | 'full', call: Record<string, unknown>) {
    const fixture = await github();
    const { services, profile, integrations } = fixture;
    const session = await services.sessions.createSession(profile.id, {
      title: 'Work',
      channel: 'api',
    });
    await services.sessions.setProtection(profile.id, session.id, { protection });
    const agent = mockModel({
      doGenerate: async (options) => {
        const prompt = JSON.stringify(options.prompt);
        // No card from the model: the plain one is what the owner sees.
        if (options.responseFormat?.type === 'json') return stop('no card');
        if (prompt.includes('You are the guardrail')) return stop('ALLOW');
        if (prompt.includes('git-1'))
          return stop(prompt.includes('its guardrail refused') ? 'Refused.' : 'Done.');
        return {
          content: [
            {
              type: 'tool-call' as const,
              toolCallId: 'git-1',
              toolName: 'github_git',
              input: JSON.stringify(call),
            },
          ],
          finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
          usage,
          warnings: [],
        };
      },
    });
    const runtime = new AgentRuntime(services, () => agent, { github: gitOnly(integrations) });
    const started = await services.runs.submit(profile.id, session.id, {
      text: 'Ship it',
      requestKey: randomUUID(),
    });
    await runtime.execute(profile.id, started.id);
    return { ...fixture, finished: await services.runs.run(profile.id, started.id) };
  }

  /** A checkout of octo-example/site in the workspace with one new commit on feat/x. */
  async function branch(fixture: Awaited<ReturnType<typeof github>>) {
    await run(fixture.tools(), { action: 'clone', repository: 'octo-example/site' });
    const checkout = join(fixture.home, 'site');
    git(checkout, 'checkout', '-q', '-b', 'feat/x');
    git(checkout, 'commit', '-q', '--allow-empty', '-m', 'Change');
    return checkout;
  }

  it('asks before a push, and says plainly what it will do', async () => {
    const { finished, repositories } = await conversation('ask', {
      action: 'push',
      repository: 'octo-example/site',
      path: '/nowhere',
      branch: 'feat/x',
    });

    expect(finished.status).toBe('waiting');
    expect(finished.approval).toMatchObject({
      toolName: 'github_git',
      kind: 'service',
      title: 'Push branch feat/x to octo-example/site',
      confirmLabel: 'Push',
    });
    expect(() =>
      git(
        join(repositories, 'octo-example/site.git'),
        'rev-parse',
        '--verify',
        '-q',
        'refs/heads/feat/x',
      ),
    ).toThrow();
  });

  it('asks before a clone too, as a change to the machine', async () => {
    const { finished } = await conversation('ask', { action: 'clone', repository: 'mona/notes' });

    expect(finished.approval).toMatchObject({ kind: 'machine', title: 'Clone mona/notes' });
  });

  it('pushes without asking in full access', async () => {
    const fixture = await github();
    const checkout = await branch(fixture);
    // The conversation is the same agent's: its workspace already holds the checkout.
    const { services, profile, integrations, repositories } = fixture;
    const session = await services.sessions.createSession(profile.id, {
      title: 'Work',
      channel: 'api',
    });
    await services.sessions.setProtection(profile.id, session.id, { protection: 'full' });
    const call = {
      action: 'push',
      repository: 'octo-example/site',
      path: checkout,
      branch: 'feat/x',
    };
    const agent = mockModel({
      doGenerate: async (options) => {
        const prompt = JSON.stringify(options.prompt);
        if (prompt.includes('git-1')) return stop('Done.');
        return {
          content: [
            {
              type: 'tool-call' as const,
              toolCallId: 'git-1',
              toolName: 'github_git',
              input: JSON.stringify(call),
            },
          ],
          finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
          usage,
          warnings: [],
        };
      },
    });
    const started = await services.runs.submit(profile.id, session.id, {
      text: 'Ship it',
      requestKey: randomUUID(),
    });
    await new AgentRuntime(services, () => agent, { github: gitOnly(integrations) }).execute(
      profile.id,
      started.id,
    );

    const finished = await services.runs.run(profile.id, started.id);
    expect(finished).toMatchObject({ status: 'completed', output: 'Done.' });
    expect(finished.approval).toBeUndefined();
    expect(git(join(repositories, 'octo-example/site.git'), 'rev-parse', 'refs/heads/feat/x')).toBe(
      git(checkout, 'rev-parse', 'HEAD'),
    );
  });

  it('refuses a force-push to the default branch on Auto, by its fixed rules', async () => {
    const { finished, minted } = await conversation('auto', {
      action: 'push',
      repository: 'octo-example/site',
      path: '/nowhere',
      branch: 'main',
      force: true,
    });

    expect(finished).toMatchObject({ status: 'completed', output: 'Refused.' });
    // Refused before anything ran: no token was even minted for it.
    expect(minted).toEqual([]);
  });

  it('reads a force-push to a default branch as dangerous through the shell too', () => {
    const shell = (command: string) => ruleVerdict('run_command', 'machine', { command });

    for (const command of [
      'git push --force origin main',
      'git push -f origin master',
      'git push origin +main',
      'git push --force-with-lease origin HEAD:refs/heads/main',
    ]) {
      expect(shell(command), command).toMatchObject({ allowed: false });
    }
    for (const command of ['git push origin main', 'git push --force origin feat/x']) {
      expect(shell(command), command).toEqual({ allowed: true });
    }
    expect(
      ruleVerdict('github_git', 'service', { action: 'push', branch: 'feat/x', force: true }),
    ).toEqual({ allowed: true });
    expect(
      plainDescription({
        toolName: 'github_git',
        kind: 'service',
        input: { action: 'push', repository: 'octo-example/site', branch: 'main', force: true },
      }).title,
    ).toBe('Force-push branch main to octo-example/site');
  });
});
