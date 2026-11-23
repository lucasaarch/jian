import { randomUUID } from 'node:crypto';
import type { Message } from '@jian/contracts';
import { expect, it } from 'vitest';
import {
  cutToolEvidence,
  toolRecordsByRun,
  wholeToolRuns,
  withToolHistory,
} from '../src/context/tool-history.js';
import { insertCheckpoint, listContextToolCheckpoints } from '../src/runs/repository.js';
import { insertMessage, listUncompactedMessages } from '../src/sessions/repository.js';
import { testServices } from './helpers/services.js';

const input = {
  name: 'Atlas',
  instructions: 'Help.',
  model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
};

it('tells a long history the same when its older runs are read a few at a time', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const chat = await services.sessions.createSession(profile.id, { channel: 'api' });
  const db = services.store.db;
  const start = Date.now() - 100_000;
  const history: Message[] = [];
  const runIds: string[] = [];

  for (let turn = 0; turn < 5; turn++) {
    const run = await services.runs.submit(profile.id, chat.id, {
      text: `Question ${turn}`,
      requestKey: `turn-${turn}`,
    });
    await services.lifecycle.claim(run.id, profile.id, 'worker');
    await services.lifecycle.finish(profile.id, run.id, 'worker', 'completed', `Answer ${turn}`);
    runIds.push(run.id);
    const write = (data: unknown, at: number) =>
      insertCheckpoint(db, {
        id: randomUUID(),
        profileId: profile.id,
        runId: run.id,
        createdAt: new Date(start + turn * 10 + at).toISOString(),
        data,
      });
    await write(
      {
        phase: 'tool-started',
        toolName: 'read_file',
        toolCallId: `call-${turn}`,
        input: { path: 'x'.repeat(900), turn },
      },
      0,
    );
    await write(
      {
        phase: 'step-completed',
        prompt: { breakdown: 'never told to the agent' },
        tools: [
          {
            toolName: 'read_file',
            toolCallId: `call-${turn}`,
            result: { text: 'r'.repeat(1_200) },
          },
        ],
      },
      1,
    );
    history.push({
      id: randomUUID(),
      profileId: profile.id,
      sessionId: chat.id,
      runId: run.id,
      role: 'assistant',
      content: `Answer ${turn}`,
      createdAt: new Date(start + turn * 10 + 2).toISOString(),
    });
  }

  const current = randomUUID();
  const everything = await listContextToolCheckpoints(db, profile.id, runIds);
  expect(JSON.stringify(everything)).not.toContain('never told');

  const whole = wholeToolRuns(history, current);
  const cut = new Map<string, string>();
  for (const runId of runIds.filter((id) => !whole.has(id))) {
    const rows = await listContextToolCheckpoints(db, profile.id, [runId]);
    for (const [id, records] of toolRecordsByRun(rows)) cut.set(id, cutToolEvidence(records));
  }
  const recent = await listContextToolCheckpoints(db, profile.id, [...whole]);

  expect(withToolHistory(history, toolRecordsByRun(recent), current, cut)).toEqual(
    withToolHistory(history, toolRecordsByRun(everything), current),
  );
});

it('loads a transcript past its budget from the newest turn, in order', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const chat = await services.sessions.createSession(profile.id, { channel: 'api' });
  const start = Date.now() - 100_000;

  for (let turn = 0; turn < 6; turn++) {
    await insertMessage(services.store.db, {
      id: randomUUID(),
      profileId: profile.id,
      sessionId: chat.id,
      role: 'user',
      content: String(turn).repeat(1_000),
      createdAt: new Date(start + turn).toISOString(),
    });
  }
  const first = (text: Message[]) => text.map((message) => message.content[0]);

  expect(first(await listUncompactedMessages(services.store.db, chat.id))).toEqual([
    '0',
    '1',
    '2',
    '3',
    '4',
    '5',
  ]);
  // The row that crosses the budget is read, and the newest always is, whatever its size.
  expect(
    first(await listUncompactedMessages(services.store.db, chat.id, undefined, undefined, 2_000)),
  ).toEqual(['4', '5']);
  expect(
    first(await listUncompactedMessages(services.store.db, chat.id, undefined, undefined, 1)),
  ).toEqual(['5']);
});
