import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { insertMessage } from '../src/sessions/repository.js';
import { testServices } from './helpers/services.js';

const token = 'test-token-that-is-at-least-32-characters';
const headers = { authorization: `Bearer ${token}` };
const input = {
  name: 'Atlas',
  instructions: 'Help.',
  model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
};
/** GitHub's `create_pull_request`, under the name the gateway gives the model for it. */
const CREATE = 'mcp__github_create_pull_reques_becd65b1';

const pr = (number: number) => `https://github.com/acme/harbor/pull/${number}`;
/** What GitHub's MCP server answers a creation with. */
const created = (url: string, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify({ id: '4242', url }) }],
  ...(isError ? { isError } : {}),
});

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function conversation() {
  const services = await testServices();
  const app = createApp({ ...services, token, logger: false });
  apps.push(app);
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createSession(profile.id, { channel: 'api' });
  const url = `/v1/profiles/${profile.id}/sessions/${session.id}/pull-requests`;

  /**
   * A turn of `sessionId` whose step called `toolName` and got `result`; as a subagent of
   * `parentRunId` when given, or as an action approved before its step, which closes itself.
   */
  const turn = async (
    result: unknown,
    {
      sessionId = session.id,
      toolName = CREATE,
      parentRunId,
      approved = false,
    }: { sessionId?: string; toolName?: string; parentRunId?: string; approved?: boolean } = {},
  ) => {
    const run = await services.runs.submit(
      profile.id,
      sessionId,
      { text: 'Open the pull request.', requestKey: randomUUID() },
      parentRunId
        ? {
            subagent: {
              parentRunId,
              spawnKey: randomUUID(),
              inputHash: 'a'.repeat(64),
              role: 'execute',
              name: 'Helper',
              identity: 'Opens pull requests.',
            },
          }
        : {},
    );
    await services.lifecycle.claim(run.id, profile.id, 'worker');
    await services.lifecycle.checkpoint(
      profile.id,
      run.id,
      'worker',
      approved
        ? { phase: 'tool-completed', toolName, toolCallId: 'call-1', result }
        : { phase: 'step-completed', tools: [{ toolName, toolCallId: 'call-1', result }] },
    );
    await services.lifecycle.finish(profile.id, run.id, 'worker', 'completed', 'Done');
    return run.id;
  };

  const read = async () =>
    (await app.inject({ url, headers })).json().map((item: { url: string }) => item.url);

  return { app, services, profile, session, url, turn, read };
}

it('lists the pull requests the agent created, the latest first', async () => {
  const { turn, read } = await conversation();

  await turn(created(pr(1)));
  await turn(created(pr(2)));

  expect(await read()).toEqual([pr(2), pr(1)]);
});

it('leaves out a pull request the agent only read or linked', async () => {
  const { services, profile, session, turn, read } = await conversation();

  await insertMessage(services.store.db, {
    id: randomUUID(),
    profileId: profile.id,
    sessionId: session.id,
    role: 'assistant',
    content: `Opened ${pr(3)}.`,
    createdAt: new Date().toISOString(),
  });
  await turn(created(pr(4)), { toolName: 'mcp__github_pull_request_read_1a2b3c4d' });

  expect(await read()).toEqual([]);
});

it('leaves out a creation GitHub refused', async () => {
  const { turn, read } = await conversation();

  await turn(created(pr(5), true));

  expect(await read()).toEqual([]);
});

it('counts one approved before its step', async () => {
  const { turn, read } = await conversation();

  await turn(created(pr(6)), { approved: true });

  expect(await read()).toEqual([pr(6)]);
});

it('counts what its subagents created, and theirs, as the conversation’s own', async () => {
  const { services, profile, turn, read } = await conversation();
  const own = await turn({ content: [] });
  const first = await services.sessions.createSession(profile.id, { channel: 'api' });
  const second = await services.sessions.createSession(profile.id, { channel: 'api' });

  const child = await turn(created(pr(7)), { sessionId: first.id, parentRunId: own });
  await turn(created(pr(8)), { sessionId: second.id, parentRunId: child });

  expect(await read()).toEqual([pr(8), pr(7)]);
});

it('keeps to its own conversation', async () => {
  const { services, profile, turn, read } = await conversation();
  const other = await services.sessions.createSession(profile.id, { channel: 'api' });

  await turn(created(pr(9)), { sessionId: other.id });

  expect(await read()).toEqual([]);
});

it('reads the pull request from the API address when the answer was cut before its page', async () => {
  const { turn, read } = await conversation();

  await turn({
    content: [
      { type: 'text', text: '{"url":"https://api.github.com/repos/acme/harbor/pulls/10","id":1' },
    ],
  });

  expect(await read()).toEqual([pr(10)]);
});

it('refuses a caller with no token', async () => {
  const { app, url } = await conversation();

  expect((await app.inject({ url })).statusCode).toBe(401);
});
