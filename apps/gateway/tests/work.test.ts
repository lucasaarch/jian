import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import { profileTools } from '../src/agent/tools.js';
import { createApp } from '../src/app.js';
import { findMedia } from '../src/media/repository.js';
import { listUnreportedSubagents } from '../src/runs/repository.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

const token = 'synthetic-test-token-at-least-32-characters';
const headers = { authorization: `Bearer ${token}` };

it('runs a scoped subagent in its parent conversation and delivers one durable handoff', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Coordinator',
    instructions: 'Help the owner.',
    identity: { role: 'Persistent coordinator' },
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const session = await services.sessions.createSession(profile.id, { channel: 'api' });
  const other = await services.sessions.createSession(profile.id, { channel: 'api' });
  const parent = await services.runs.submit(profile.id, session.id, {
    text: 'Research the release.',
    requestKey: 'parent',
  });
  const image = await services.media.upload(profile.id, session.id, {
    mimeType: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=',
  });
  await services.memories.remember(profile.id, {
    key: 'release',
    content: 'Private deployment history.',
    expectedVersion: 0,
  });
  const tools = profileTools(services, parent);
  const assignment = {
    role: 'execute' as const,
    name: 'Researcher',
    identity: 'Inspect the release evidence.',
    brief: 'Find the release status and report the exact source.',
    mediaIds: [image.id],
  };
  const call = { toolCallId: 'spawn-one', messages: [], context: {} };
  const child = await tools.spawn_subagent?.execute?.(assignment, call);
  expect(child).toMatchObject({ name: 'Researcher', status: 'queued' });
  if (!child) throw new Error('Subagent was not created');
  expect((await tools.spawn_subagent?.execute?.(assignment, call))?.runId).toBe(child.runId);
  await expect(
    services.work.spawnInConversation(
      parent,
      { ...assignment, brief: 'Different task.' },
      'spawn-one',
    ),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(await services.work.conversationSubagents(profile.id, other.id)).toEqual([]);
  expect(await services.work.conversationSubagents(profile.id, session.id)).toMatchObject([
    { runId: child.runId, parentRunId: parent.id, name: 'Researcher' },
  ]);
  const worker = await services.runs.run(profile.id, child.runId);
  expect(worker.input).not.toContain(image.id);
  const copiedImage = worker.input.match(/\[Attached media: ([a-f0-9-]+)\]/)?.[1];
  expect(copiedImage).toBeDefined();
  expect((await findMedia(services.store.db, profile.id, copiedImage ?? '')).mimeType).toBe(
    'image/png',
  );
  const context = await services.contexts.context(worker, []);
  expect(context.messages.at(-1)?.content).toContain(assignment.brief);
  expect(context.system).not.toContain('Private deployment history.');
  expect(context.system).not.toContain('Research the release.');
  expect(context.system).not.toContain('Persistent coordinator');
  expect(context.system).not.toContain('Relevant shared memories');
  expect(context.system).not.toContain('Current activities');
  expect(profileTools(services, worker)).not.toHaveProperty('spawn_subagent');
  await expect(
    services.work.spawnInConversation(worker, assignment, 'nested'),
  ).rejects.toMatchObject({
    statusCode: 403,
  });
  await services.lifecycle.claim(child.runId, profile.id, 'child-lease');
  await services.lifecycle.finish(profile.id, child.runId, 'child-lease', 'completed', 'Released.');
  await services.work.reportWorker(profile.id, child.runId);
  await services.work.reportWorker(profile.id, child.runId);
  expect(
    (await services.sessions.messages(profile.id, session.id)).filter((message) =>
      message.content.includes('Subagent "Researcher"'),
    ),
  ).toHaveLength(1);
  const app = createApp({ ...services, token, logger: false });
  try {
    const visible = await app.inject({
      url: `/v1/profiles/${profile.id}/sessions/${session.id}/subagents`,
      headers,
    });
    expect(visible.statusCode).toBe(200);
    expect(visible.json()).toMatchObject([{ runId: child.runId, status: 'completed' }]);
    const isolated = await app.inject({
      url: `/v1/profiles/${profile.id}/sessions/${other.id}/subagents`,
      headers,
    });
    expect(isolated.json()).toEqual([]);
    const archive = await app.inject({
      url: `/v1/profiles/${profile.id}/work`,
      headers,
    });
    expect(archive.statusCode).toBe(404);
  } finally {
    await app.close();
  }
});

it('records a late worker report without restarting its cancelled principal', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Coordinator',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const session = await services.sessions.createSession(profile.id, { channel: 'api' });
  const parent = await services.runs.submit(profile.id, session.id, {
    text: 'Review.',
    requestKey: 'parent',
  });
  const child = await services.work.spawnInConversation(
    parent,
    {
      role: 'review',
      name: 'Reviewer',
      identity: 'Review.',
      brief: 'Check the change.',
    },
    'child',
  );
  await services.runs.cancel(profile.id, parent.id);
  await services.lifecycle.claim(child.runId, profile.id, 'worker');
  await services.lifecycle.finish(profile.id, child.runId, 'worker', 'completed', 'Done.');
  await services.work.reportWorker(profile.id, child.runId);
  await services.work.reportWorker(profile.id, child.runId);
  expect(await services.runs.activities(profile.id)).toHaveLength(0);
  expect(await listUnreportedSubagents(services.store.db, 10)).toEqual([]);
  expect(
    (await services.sessions.messages(profile.id, session.id)).some((message) =>
      message.content.includes('Subagent "Reviewer"'),
    ),
  ).toBe(false);
});

it('executes a conversation subagent through the agent loop and retains its transcript', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jian-conversation-worker-')));
  const previous = process.env.JIAN_WORKSPACES;
  process.env.JIAN_WORKSPACES = root;
  try {
    const services = await testServices();
    const profile = await services.profiles.createProfile({
      name: 'Coordinator',
      instructions: 'Help the owner.',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    });
    const session = await services.sessions.createSession(profile.id, { channel: 'api' });
    const parent = await services.runs.submit(profile.id, session.id, {
      text: 'Check the release.',
      requestKey: 'parent',
    });
    const child = await services.work.spawnInConversation(
      parent,
      {
        role: 'execute',
        name: 'Verifier',
        identity: 'Verify the release.',
        brief: 'Run the release check.',
      },
      'spawn',
    );
    const model = mockModel({
      doGenerate: async () => ({
        content: [{ type: 'text' as const, text: 'Release check passed.' }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      }),
    });

    await new AgentRuntime(services, () => model).execute(profile.id, child.runId);
    const finished = await services.runs.run(profile.id, child.runId);
    expect(finished).toMatchObject({ status: 'completed', output: 'Release check passed.' });
    expect(await services.sessions.messages(profile.id, child.sessionId)).toMatchObject([
      { role: 'user', content: 'Run the release check.' },
      { role: 'assistant', content: 'Release check passed.' },
    ]);
    expect(await listUnreportedSubagents(services.store.db, 10)).toContainEqual({
      profileId: profile.id,
      id: child.runId,
    });
    await services.work.reportWorker(profile.id, child.runId);
    expect(
      (await services.sessions.messages(profile.id, session.id)).some((message) =>
        message.content.includes('Release check passed.'),
      ),
    ).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.JIAN_WORKSPACES;
    else process.env.JIAN_WORKSPACES = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

it('lets the owner and the principal cancel workers while enforcing conversation and profile scope', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Coordinator',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Research' });
  const otherSession = await services.sessions.createSession(profile.id, { title: 'Other work' });
  const parent = await services.runs.submit(profile.id, session.id, {
    text: 'Research',
    requestKey: 'parent',
  });
  const other = await services.runs.submit(profile.id, otherSession.id, {
    text: 'Unrelated',
    requestKey: 'other',
  });
  const assignment = {
    name: 'Researcher',
    role: 'execute',
    identity: 'Research.',
    brief: 'Read the release.',
  };
  const child = await services.work.spawnInConversation(parent, assignment, 'child');
  const worker = await services.runs.run(profile.id, child.runId);
  expect(profileTools(services, worker)).not.toHaveProperty('cancel_subagent');
  await expect(services.work.cancelInConversation(worker, child.runId)).rejects.toMatchObject({
    statusCode: 403,
  });
  await expect(services.work.cancelInConversation(other, child.runId)).rejects.toMatchObject({
    statusCode: 403,
  });
  await expect(services.work.cancelInConversation(parent, other.id)).rejects.toMatchObject({
    statusCode: 403,
  });
  await expect(
    services.runs.cancel('00000000-0000-4000-8000-000000000099', child.runId),
  ).rejects.toMatchObject({ statusCode: 404 });
  expect((await services.runs.run(profile.id, child.runId)).status).toBe('queued');

  await services.lifecycle.claim(child.runId, profile.id, 'running-worker');
  let committed: Promise<string> | undefined;
  services.runs.useCancellation((id) => {
    committed = services.runs.run(profile.id, id).then((run) => run.status);
  });
  const tools = profileTools(services, parent);
  const cancel = tools.cancel_subagent?.execute as unknown as (
    input: { runId: string },
    options: { toolCallId: string; messages: [] },
  ) => Promise<unknown>;
  await cancel({ runId: child.runId }, { toolCallId: 'stop', messages: [] });
  expect(await committed).toBe('cancelled');
  expect((await services.runs.run(profile.id, child.runId)).leaseOwner).toBeUndefined();
  await services.work.reportWorker(profile.id, child.runId);
  const messages = await services.sessions.messages(profile.id, session.id);
  expect(
    messages.some((message) => message.content.includes(`Run ${child.runId} status: cancelled`)),
  ).toBe(true);

  const second = await services.work.spawnInConversation(parent, assignment, 'owner-child');
  const app = createApp({ ...services, token, logger: false });
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/profiles/${profile.id}/runs/${second.runId}/cancel`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('cancelled');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/profiles/${profile.id}/runs/${second.runId}/cancel`,
          headers,
        })
      ).json().status,
    ).toBe('cancelled');
  } finally {
    await app.close();
  }
});

it('aborts an in-flight subagent model call after the cancellation commits', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Coordinator',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Research' });
  const parent = await services.runs.submit(profile.id, session.id, {
    text: 'Research.',
    requestKey: 'parent',
  });
  const child = await services.work.spawnInConversation(
    parent,
    { name: 'Reader', role: 'execute', identity: 'Read.', brief: 'Read the release.' },
    'reader',
  );
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let aborted = false;
  const model = mockModel({
    doGenerate: async ({ abortSignal }) => {
      return new Promise<never>((_resolve, reject) => {
        const stop = () => {
          aborted = true;
          reject(new DOMException('Synthetic cancelled request', 'AbortError'));
        };
        if (abortSignal?.aborted) stop();
        else abortSignal?.addEventListener('abort', stop, { once: true });
        started();
      });
    },
  });
  const runtime = new AgentRuntime(services, () => model);
  services.runs.useCancellation((id) => runtime.cancel(id));
  const executing = runtime.execute(profile.id, child.runId);
  try {
    await ready;
    await services.work.cancelInConversation(parent, child.runId);
    await executing;
    expect(aborted).toBe(true);
    const finished = await services.runs.run(profile.id, child.runId);
    expect(finished.status).toBe('cancelled');
    expect(finished.output).toBeUndefined();
    expect(
      (await services.sessions.messages(profile.id, child.sessionId)).some(
        (message) => message.role === 'assistant',
      ),
    ).toBe(false);
  } finally {
    runtime.stop();
  }
});
