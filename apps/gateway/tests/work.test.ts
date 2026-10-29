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
