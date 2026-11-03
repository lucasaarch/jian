import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { profileTools } from '../src/agent/tools.js';
import { testServices } from './helpers/services.js';

/**
 * A conversation whose turns run one tool each. `clock` moves a minute per turn, so anything
 * that depends on the time has a reason to differ from one turn to the next.
 */
async function conversation(provider = 'anthropic') {
  let now = Date.UTC(2026, 10, 3, 9, 0, 0);
  const services = await testServices(() => now);
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help the owner.',
    model: { provider, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    skills: [{ name: 'lookup', description: 'Search the catalog', instructions: 'Body' }],
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Cache' });

  /** A finished turn that called `read_file` once and got `output`. */
  const turn = async (text: string, output: unknown) => {
    now += 60_000;
    const run = await services.runs.submit(profile.id, session.id, {
      text,
      requestKey: randomUUID(),
    });
    const owner = randomUUID();
    await services.lifecycle.claim(run.id, profile.id, owner);
    await services.lifecycle.checkpoint(profile.id, run.id, owner, {
      phase: 'tool-started',
      toolName: 'read_file',
      toolCallId: `call-${run.id}`,
      input: { path: `${text}.txt` },
    });
    await services.lifecycle.checkpoint(profile.id, run.id, owner, {
      phase: 'step-completed',
      tools: [{ toolName: 'read_file', toolCallId: `call-${run.id}`, result: output }],
    });
    await services.lifecycle.finish(profile.id, run.id, owner, 'completed', `Read ${text}.`);
    return run;
  };

  /** The context of a new turn asking `text`. */
  const ask = async (text: string) => {
    now += 60_000;
    const run = await services.runs.submit(profile.id, session.id, {
      text,
      requestKey: randomUUID(),
    });
    return { run, context: await services.contexts.context(run, []) };
  };

  return { services, profile, session, turn, ask };
}

it('sends the same prefix two turns running, whatever the turn context says', async () => {
  // The prompt is built the same for every provider: the prefix is what each one caches.
  for (const provider of ['anthropic', 'openai']) {
    const { services, profile, turn, ask } = await conversation(provider);
    await turn('alpha', { content: 'first file' });
    const { run, context: before } = await ask('And the second?');
    const owner = randomUUID();
    await services.lifecycle.claim(run.id, profile.id, owner);
    await services.lifecycle.finish(profile.id, run.id, owner, 'completed', 'It is empty.');
    // A memory made between the turns changes what the next one recalls, and only that.
    await services.memories.remember(profile.id, {
      key: 'second-file',
      content: 'The second file is empty',
      expectedVersion: 0,
    });

    const { context: after } = await ask('What did the second file hold?');
    const start = before.currentStartIndex ?? 0;

    expect(after.system).toBe(before.system);
    expect(after.messages.slice(0, start)).toEqual(before.messages.slice(0, start));
    // What changes is after the history: the time, and what this turn recalls.
    expect(after.messages[after.currentStartIndex ?? 0]?.content).toContain(
      'The second file is empty',
    );
    expect(after.system).not.toMatch(/It is .* in /);
  }
});

it('keeps the two latest turns’ results whole and cuts the older ones', async () => {
  const { turn, ask } = await conversation();
  const long = 'x'.repeat(5_000);
  const first = await turn('one', { content: `${long}first` });
  await turn('two', { content: `${long}second` });
  await turn('three', { content: `${long}third` });

  const { context } = await ask('Go on.');
  const activity = context.messages
    .filter((message) => message.content.startsWith('Recorded tool activity'))
    .map((message) => message.content);

  expect(activity).toHaveLength(3);
  expect(activity[0]).toContain('"cut":true');
  expect(activity[0]).toContain(`call-${first.id}`);
  expect(activity[0]).toContain('read_artifact with their callId as toolCallId');
  expect(activity[0]).not.toContain('first');
  expect(activity[1]).toContain(`${long}second`);
  expect(activity[2]).toContain(`${long}third`);
});

it('reads a cut result back whole, only from its own conversation', async () => {
  const { services, profile, turn, ask } = await conversation();
  const first = await turn('one', { content: `${'y'.repeat(3_000)}end` });
  const { run } = await ask('Go on.');
  const read = profileTools(services, run).read_artifact?.execute as (
    input: unknown,
    options: unknown,
  ) => Promise<{ content: string; nextOffset: number | null }>;

  let content = '';
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await read(
      { toolCallId: `call-${first.id}`, offset, limit: 16_000 },
      { messages: [], toolCallId: 'read' },
    );
    content += page.content;
    offset = page.nextOffset;
  }
  expect(JSON.parse(content)).toEqual({ content: `${'y'.repeat(3_000)}end` });

  const elsewhere = await services.sessions.createSession(profile.id, { title: 'Other' });
  const stranger = await services.runs.submit(profile.id, elsewhere.id, {
    text: 'Read it',
    requestKey: 'other',
  });
  const readElsewhere = profileTools(services, stranger).read_artifact?.execute as typeof read;
  await expect(
    readElsewhere(
      { toolCallId: `call-${first.id}`, offset: 0, limit: 16_000 },
      { messages: [], toolCallId: 'read' },
    ),
  ).rejects.toThrow('Tool call not found');
});
