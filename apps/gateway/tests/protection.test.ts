import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NO_APPROVER, protectionFor } from '../src/agent/guard.js';
import { AgentRuntime } from '../src/agent/runtime.js';
import { createApp } from '../src/app.js';
import { readRunAction } from '../src/runs/repository.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'jian-protection-')));
const previousRoot = process.env.JIAN_WORKSPACES;
process.env.JIAN_WORKSPACES = root;

afterAll(() => {
  if (previousRoot === undefined) delete process.env.JIAN_WORKSPACES;
  else process.env.JIAN_WORKSPACES = previousRoot;
});

const token = 'synthetic-protection-admin-token-32-chars';
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

/**
 * An agent that writes one file. It loads the file tools, writes, and once a later turn tells
 * it what happened, says so. The approval card is asked of the same model, as JSON.
 */
function writer(file: string, seen: string[]) {
  return mockModel({
    doGenerate: async (options) => {
      const prompt = JSON.stringify(options.prompt);

      if (options.responseFormat?.type === 'json') {
        return stop(
          JSON.stringify({
            title: 'Write notes.txt',
            detail: 'Creates the file with one line.',
            confirmLabel: 'Write the file',
          }),
        );
      }
      if (prompt.includes('approved the action') || prompt.includes('rejected the action')) {
        seen.push(prompt);
        return stop('Done.');
      }
      if (prompt.includes('"write-1"')) return stop('Done.');
      if (prompt.includes('You are the guardrail')) return stop('ALLOW');
      if (!prompt.includes('"load_tools"'))
        return call('load', 'load_tools', { groups: ['files'] });
      return call('write-1', 'write_file', { path: file, content: 'hello' });
    },
  });
}

async function setup(channel = 'api') {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Work', channel });
  const file = join(root, profile.id, 'notes.txt');
  const seen: string[] = [];
  const runtime = new AgentRuntime(services, () => writer(file, seen));
  const ask = async (text = 'Write the notes') =>
    services.runs.submit(profile.id, session.id, { text, requestKey: crypto.randomUUID() });

  return { services, profile, session, file, seen, runtime, ask };
}

describe('a conversation that asks first', () => {
  it('parks an action on an approval and runs nothing', async () => {
    const { services, profile, session, file, runtime, ask } = await setup();

    expect(session.protection).toBe('ask');

    const run = await ask();
    await runtime.execute(profile.id, run.id);

    const parked = await services.runs.run(profile.id, run.id);
    expect(parked.status).toBe('waiting');
    expect(parked.approval).toMatchObject({
      toolName: 'write_file',
      kind: 'machine',
      title: 'Write notes.txt',
      confirmLabel: 'Write the file',
    });
    expect(parked.approval?.decision).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    // The real call is kept beside the run, and never on the record the API serves.
    expect(await readRunAction(services.store.db, run.id)).toMatchObject({
      toolName: 'write_file',
      input: { path: file, content: 'hello' },
      state: 'pending',
    });
    expect(JSON.stringify(parked)).not.toContain('"state"');
  });

  it('runs exactly the approved call, once, and carries on from its result', async () => {
    const { services, profile, file, seen, runtime, ask } = await setup();
    const run = await ask();
    await runtime.execute(profile.id, run.id);

    const resume = await services.runs.decideApproval(profile.id, run.id, { decision: 'approve' });
    // Deciding again is the same decision, not a second continuation.
    const again = await services.runs.decideApproval(profile.id, run.id, { decision: 'approve' });
    expect(again.id).toBe(resume.id);
    await expect(
      services.runs.decideApproval(profile.id, run.id, { decision: 'reject' }),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect((await services.runs.run(profile.id, run.id)).approval).toMatchObject({
      decision: 'approved',
      decidedBy: 'owner',
    });

    await runtime.execute(profile.id, resume.id);

    expect(readFileSync(file, 'utf8')).toBe('hello');
    expect(await services.runs.run(profile.id, resume.id)).toMatchObject({
      status: 'completed',
      output: 'Done.',
    });
    expect(seen.at(-1)).toContain('Result of the approved action');
    // Spent: nothing is left to run a second time.
    expect(await readRunAction(services.store.db, resume.id)).toBeNull();
    expect(await readRunAction(services.store.db, run.id)).toBeNull();
  });

  it('shows the approved call as done in the conversation, with what it changed', async () => {
    const { services, profile, session, runtime, ask } = await setup();
    const run = await ask();
    await runtime.execute(profile.id, run.id);
    const resume = await services.runs.decideApproval(profile.id, run.id, { decision: 'approve' });
    await runtime.execute(profile.id, resume.id);

    // It runs ahead of any model step, so no step closes it: it has to close itself, or the
    // timeline reads it as unfinished and the panel leaves out its diff.
    const step = (await services.sessions.timeline(profile.id, session.id))
      .flatMap((entry) => entry.steps)
      .find((item) => item.toolCallId === 'write-1');
    expect(step).toMatchObject({ toolName: 'write_file', status: 'done' });
    expect(step?.diff).toMatchObject({ created: true, additions: 1, deletions: 0 });
  });

  it('never runs a rejected action', async () => {
    const { services, profile, file, seen, runtime, ask } = await setup();
    const run = await ask();
    await runtime.execute(profile.id, run.id);

    const resume = await services.runs.decideApproval(profile.id, run.id, { decision: 'reject' });
    await runtime.execute(profile.id, resume.id);

    expect(existsSync(file)).toBe(false);
    expect(seen.at(-1)).toContain('rejected the action');
    expect(await readRunAction(services.store.db, resume.id)).toBeNull();
  });

  it('takes the owner writing instead of deciding as a no, with what they wrote', async () => {
    const { services, profile, session, runtime, ask } = await setup();
    const run = await ask();
    await runtime.execute(profile.id, run.id);

    const resume = await services.runs.submit(
      profile.id,
      session.id,
      { text: 'Wait, use a different name', requestKey: 'instead' },
      { ownerMessage: true },
    );

    expect(resume.continuationOf).toBe(run.id);
    expect((await services.runs.run(profile.id, run.id)).approval).toMatchObject({
      decision: 'rejected',
      note: 'Wait, use a different name',
    });
    expect(await readRunAction(services.store.db, resume.id)).toBeNull();
  });

  it('leaves the approval pending when someone else writes', async () => {
    const { services, profile, session, runtime, ask } = await setup();
    const run = await ask();
    await runtime.execute(profile.id, run.id);

    const other = await services.runs.submit(profile.id, session.id, {
      text: 'yes',
      requestKey: 'someone',
    });

    expect(other.continuationOf).toBeUndefined();
    expect((await services.runs.run(profile.id, run.id)).status).toBe('waiting');
    expect((await readRunAction(services.store.db, run.id))?.state).toBe('pending');
  });

  it('lets the tools that only read run', async () => {
    const { services, profile, session } = await setup();
    const runtime = new AgentRuntime(services, () =>
      mockModel({
        doGenerate: async (options) =>
          JSON.stringify(options.prompt).includes('"read_memories"')
            ? stop('Nothing kept yet.')
            : call('read', 'read_memories', {}),
      }),
    );
    const run = await services.runs.submit(profile.id, session.id, {
      text: 'What do you remember?',
      requestKey: 'read',
    });

    await runtime.execute(profile.id, run.id);

    expect(await services.runs.run(profile.id, run.id)).toMatchObject({ status: 'completed' });
  });
});

describe('full access', () => {
  it('runs actions without asking', async () => {
    const { services, profile, session, file, runtime, ask } = await setup();
    await services.sessions.setProtection(profile.id, session.id, { protection: 'full' });

    const run = await ask();
    await runtime.execute(profile.id, run.id);

    expect(readFileSync(file, 'utf8')).toBe('hello');
    expect((await services.runs.run(profile.id, run.id)).approval).toBeUndefined();
  });
});

describe('a chat channel nobody may approve from', () => {
  it('declines the action at once, without parking, and runs nothing', async () => {
    const { services, profile, file, runtime, ask } = await setup('telegram');
    const run = await ask();

    await runtime.execute(profile.id, run.id);

    const ended = await services.runs.run(profile.id, run.id);
    expect(ended.status).not.toBe('waiting');
    expect(ended.approval).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });
});

describe('a subagent', () => {
  async function child(protection: 'ask' | 'auto' | 'full') {
    const { services, profile, session, file, runtime, ask } = await setup();
    await services.sessions.setProtection(profile.id, session.id, { protection });
    const parent = await ask('Have someone write the notes');
    const sent = await services.work.spawnInConversation(
      parent,
      { role: 'execute', name: 'Scribe', identity: 'Write files.', brief: 'Write the notes.' },
      `spawn-${protection}`,
    );
    expect((await services.sessions.session(profile.id, sent.sessionId)).protection).toBe('auto');
    await runtime.execute(profile.id, sent.runId);

    return {
      file,
      run: await services.runs.run(profile.id, sent.runId),
      session: await services.sessions.session(profile.id, session.id),
    };
  }

  it.each(['ask', 'auto', 'full'] as const)(
    'runs on Auto independently of the principal mode (%s)',
    async (mode) => {
      const result = await child(mode);
      expect(result.run.status).toBe('completed');
      expect(result.run.approval).toBeUndefined();
      expect(readFileSync(result.file, 'utf8')).toBe('hello');
      expect(result.session.protection).toBe(mode);
    },
  );
});

describe('who decides an action', () => {
  const base = {
    mode: 'ask' as const,
    subagent: false,
    channel: 'gateway',
    contactCanApprove: false,
  };

  it('asks the owner in the panel, and a chat only through a contact allowed to approve', () => {
    expect(protectionFor(base)).toEqual({ mode: 'pause' });
    expect(protectionFor({ ...base, channel: 'api' })).toEqual({ mode: 'pause' });
    expect(protectionFor({ ...base, channel: 'telegram' })).toEqual({
      mode: 'decline',
      reason: NO_APPROVER,
    });
    expect(protectionFor({ ...base, channel: 'whatsapp', contactCanApprove: true })).toEqual({
      mode: 'pause',
    });
  });

  it.each(['ask', 'auto', 'full'] as const)(
    'keeps the Auto guardrail for every subagent (%s)',
    (mode) => {
      expect(protectionFor({ ...base, mode, subagent: true })).toEqual({ mode: 'guard' });
      expect(protectionFor({ ...base, mode: 'full', channel: 'telegram' })).toEqual({
        mode: 'run',
      });
    },
  );
});

describe('the approval and protection routes', () => {
  it('approves from the panel, refuses a chat channel conversation, and keeps the mode', async () => {
    const { services, profile, session, runtime, ask } = await setup();
    const app = createApp({ ...services, token, logger: false });
    const headers = { authorization: `Bearer ${token}` };

    try {
      const run = await ask();
      await runtime.execute(profile.id, run.id);

      const decided = await app.inject({
        method: 'POST',
        url: `/v1/profiles/${profile.id}/runs/${run.id}/approval`,
        headers,
        payload: { decision: 'approve' },
      });
      expect(decided.statusCode).toBe(202);
      expect(decided.json().continuationOf).toBe(run.id);

      const chat = await services.sessions.createSession(profile.id, {
        title: 'Chat',
        channel: 'telegram',
      });
      const parked = await services.runs.submit(profile.id, chat.id, {
        text: 'x',
        requestKey: 'chat',
      });
      const refused = await app.inject({
        method: 'POST',
        url: `/v1/profiles/${profile.id}/runs/${parked.id}/approval`,
        headers,
        payload: { decision: 'approve' },
      });
      expect(refused.statusCode).toBe(403);

      const changed = await app.inject({
        method: 'PUT',
        url: `/v1/profiles/${profile.id}/sessions/${session.id}/protection`,
        headers,
        payload: { protection: 'full' },
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json().protection).toBe('full');
      expect((await services.sessions.session(profile.id, session.id)).protection).toBe('full');

      const events = await app.inject({ url: `/v1/profiles/${profile.id}/events`, headers });
      expect(events.json().map((event: { type: string }) => event.type)).toEqual(
        expect.arrayContaining(['run.waiting', 'run.approved', 'session.protection']),
      );
    } finally {
      await app.close();
    }
  });
});
