import type { RunProgress } from '@jian/contracts';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import { testServices } from './helpers/services.js';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};
type Chunk = Record<string, unknown>;

/** A model whose steps are lists of stream chunks, as a provider sends them. */
const scripted = (steps: Chunk[][]) => {
  let step = 0;

  return new MockLanguageModelV4({
    doStream: async () => ({
      // biome-ignore lint/suspicious/noExplicitAny: the mock's own chunk type is not exported.
      stream: simulateReadableStream({ chunks: steps[step++] ?? [] }) as any,
    }),
  });
};

const calls = (reason: 'tool-calls' | 'stop'): Chunk => ({
  type: 'finish',
  finishReason: { unified: reason, raw: reason },
  usage,
});

/** The input of one tool call, written in pieces the way a model writes it. */
const writing = (toolName: string, id: string, input: object, pieces = 4): Chunk[] => {
  const json = JSON.stringify(input);
  const size = Math.ceil(json.length / pieces);
  const parts = Array.from({ length: pieces }, (_, index) =>
    json.slice(index * size, (index + 1) * size),
  );

  return [
    { type: 'tool-input-start', id, toolName },
    ...parts.map((delta) => ({ type: 'tool-input-delta', id, delta })),
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName, input: json },
  ];
};

const load: Chunk[] = [
  { type: 'stream-start', warnings: [] },
  {
    type: 'tool-call',
    toolCallId: 'load',
    toolName: 'load_tools',
    input: JSON.stringify({ groups: ['artifacts'] }),
  },
  calls('tool-calls'),
];

const text = (answer: string): Chunk[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: answer },
  { type: 'text-end', id: 't' },
  calls('stop'),
];

async function setup() {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    contextPolicy: { inputTokens: 64000 },
  });
  const session = await services.sessions.createGatewaySession(profile.id, {});
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Write it',
    requestKey: 'live',
  });
  const told: RunProgress[] = [];
  const progress = services.lifecycle.progress.bind(services.lifecycle);
  services.lifecycle.progress = async (runId, owner, snapshot) => {
    if (snapshot) told.push(snapshot);
    await progress(runId, owner, snapshot);
  };

  return { services, profile, session, run, told };
}

const drafts = (told: RunProgress[]) =>
  told.flatMap((frame) => (frame.artifact ? [frame.artifact] : []));

describe('an Artifact written live', () => {
  it('is told as it grows, never kept as a version, and ends when the version is made', async () => {
    const { services, profile, session, run, told } = await setup();
    const model = scripted([
      load,
      [
        { type: 'stream-start', warnings: [] },
        ...writing('create_artifact', 'make', {
          title: 'Plan',
          type: 'markdown',
          content: `# Plan\n\n${'A line of the plan.\n'.repeat(20)}`,
        }),
        calls('tool-calls'),
      ],
      text('Done.'),
    ]);

    await new AgentRuntime(services, () => model).execute(profile.id, run.id);

    const seen = drafts(told);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[0]).toMatchObject({ toolCallId: 'make' });
    // The last draft holds all of it, with its title and type.
    expect(seen.at(-1)).toMatchObject({ title: 'Plan', type: 'markdown' });
    expect(seen.at(-1)?.content.startsWith('# Plan')).toBe(true);
    expect(seen.at(-1)?.content.length).toBeGreaterThan(300);
    // Once the tool ran the draft was let go, and a single version is what exists.
    expect(told.at(-1)).not.toHaveProperty('artifact');
    const [made] = await services.artifacts.list(profile.id, session.id);
    expect(made).toMatchObject({ title: 'Plan', version: 1 });
    // The run, read back, carries no draft once it is over.
    expect((await services.runs.run(profile.id, run.id)).progress).toBeUndefined();
  });

  it('streams a revision only once the Artifact is named in full', async () => {
    const { services, profile, session, run, told } = await setup();
    const made = await services.artifacts.create(profile.id, session.id, {
      title: 'Plan',
      type: 'markdown',
      content: '# One',
    });
    const model = scripted([
      load,
      [
        { type: 'stream-start', warnings: [] },
        ...writing(
          'update_artifact',
          'revise',
          { artifactId: made.id, content: '# Two\n\nMore.' },
          6,
        ),
        calls('tool-calls'),
      ],
      text('Done.'),
    ]);

    await new AgentRuntime(services, () => model).execute(profile.id, run.id);

    const seen = drafts(told);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((draft) => draft.artifactId === made.id)).toBe(true);
    expect(seen.at(-1)?.content).toBe('# Two\n\nMore.');
    expect((await services.artifacts.list(profile.id, session.id))[0]).toMatchObject({
      version: 2,
    });
  });

  it('hands a deck over slide by slide, never one half written', async () => {
    const { services, profile, run, told } = await setup();
    const slide = (name: string) =>
      `<!doctype html><html><body><h1>${name}</h1><p>${'Words. '.repeat(30)}</p></body></html>`;
    const slides = [slide('First'), slide('Second'), slide('Third')];
    const model = scripted([
      load,
      [
        { type: 'stream-start', warnings: [] },
        ...writing('create_artifact', 'deck', { title: 'Talk', type: 'deck', slides }, 12),
        calls('tool-calls'),
      ],
      text('Done.'),
    ]);

    await new AgentRuntime(services, () => model).execute(profile.id, run.id);

    const seen = drafts(told);
    // Every slide handed over is one of the deck's, whole, in its place.
    for (const draft of seen) {
      expect(draft.slides).toEqual(slides.slice(0, draft.slides?.length));
    }
    expect(seen.some((draft) => (draft.slides?.length ?? 0) < slides.length)).toBe(true);
    // The end of the input has every slide, and the content stays the slides one after another.
    expect(seen.at(-1)?.slides).toEqual(slides);
    expect(seen.at(-1)?.content).toBe(slides.join('\n\n'));
  });

  it('ends when the tool refuses what was written, and keeps nothing', async () => {
    const { services, profile, session, run, told } = await setup();
    const model = scripted([
      load,
      [
        { type: 'stream-start', warnings: [] },
        // A whiteboard that is not JSON: the tool refuses it after it was shown.
        ...writing('create_artifact', 'bad', {
          title: 'Board',
          type: 'board',
          content: 'not json at all',
        }),
        calls('tool-calls'),
      ],
      text('It failed.'),
    ]);

    await new AgentRuntime(services, () => model).execute(profile.id, run.id);

    expect(drafts(told).length).toBeGreaterThan(0);
    expect(told.at(-1)).not.toHaveProperty('artifact');
    expect(await services.artifacts.list(profile.id, session.id)).toEqual([]);
  });

  it('is read only through its own profile’s run', async () => {
    const { services, profile, run } = await setup();
    const other = await services.profiles.createProfile({
      name: 'Other',
      instructions: 'Help.',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    });

    await expect(services.runs.run(other.id, run.id)).rejects.toThrow();
    expect((await services.runs.run(profile.id, run.id)).id).toBe(run.id);
  });
});
