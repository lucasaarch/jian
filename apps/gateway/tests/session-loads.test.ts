import { expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import { listLoads, useLoads } from '../src/sessions/loads.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};
const answer = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage,
  warnings: [],
});
const calls = (...items: Array<{ id: string; name: string; input: unknown }>) => ({
  content: items.map((item) => ({
    type: 'tool-call' as const,
    toolCallId: item.id,
    toolName: item.name,
    input: JSON.stringify(item.input),
  })),
  finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
  usage,
  warnings: [],
});

/** What the model is sent on one call, as the mock receives it. */
type LanguageModelV3CallOptions = Parameters<
  NonNullable<Parameters<typeof mockModel>[0]['doGenerate']>
>[0];

const BODY = 'Look things up in the catalog by their exact code.';

async function conversation(
  skills = [{ name: 'lookup', description: 'Search the catalog', instructions: BODY }],
  model = { provider: 'openai', modelId: 'test' },
) {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: { ...model, apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    skills,
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Loads' });

  /** One turn whose model answers each step with `steps[i]`, recording what it was sent. */
  const turn = async (
    text: string,
    steps: Array<ReturnType<typeof calls> | ReturnType<typeof answer>>,
  ) => {
    const sent: LanguageModelV3CallOptions[] = [];
    let step = 0;
    const model = mockModel({
      doGenerate: async (options) => {
        // The call that names a new conversation has no tools: it is not a step of the turn.
        if (!options.tools) return answer('Loads');
        sent.push(options);
        return steps[Math.min(step++, steps.length - 1)] as ReturnType<typeof answer>;
      },
    });
    const run = await services.runs.submit(profile.id, session.id, {
      text,
      requestKey: `${text}-${Date.now()}-${Math.random()}`,
    });
    await new AgentRuntime(services, () => model).execute(profile.id, run.id);
    expect((await services.runs.run(profile.id, run.id)).status).toBe('completed');
    return sent;
  };

  const system = (options: LanguageModelV3CallOptions) =>
    options.prompt
      .flatMap((message) => (message.role === 'system' ? [message.content] : []))
      .join('\n\n');
  const rest = (options: LanguageModelV3CallOptions) =>
    JSON.stringify(options.prompt.filter((message) => message.role !== 'system'));

  return { services, profile, session, turn, system, rest };
}

it('keeps a loaded skill in the instructions, and never sends it twice', async () => {
  const { services, profile, session, turn, system, rest } = await conversation();

  const first = await turn('Find X-1', [
    calls({ id: 'skill-1', name: 'load_skill', input: { name: 'lookup' } }),
    answer('Found it.'),
  ]);
  // The first load answers with the body, so the turn can use it at once.
  expect(rest(first[1] as LanguageModelV3CallOptions)).toContain(BODY);
  expect(
    (await listLoads(services.store.db, profile.id, session.id)).map((load) => load.name),
  ).toEqual(['lookup']);

  const second = await turn('Find X-2', [
    calls({ id: 'skill-2', name: 'load_skill', input: { name: 'lookup' } }),
    answer('Found that one too.'),
  ]);
  const [opening, after] = second as [LanguageModelV3CallOptions, LanguageModelV3CallOptions];

  // In the instructions, once, and marked loaded in the catalog.
  expect(system(opening)).toContain('## Skill: lookup');
  expect(system(opening).split(BODY)).toHaveLength(2);
  expect(system(opening)).toContain('"loaded":true');
  // The record of the first turn names the load; the body is not sent again with it.
  expect(rest(opening)).toContain('loaded skill lookup');
  expect(rest(opening)).not.toContain(BODY);
  // Asked again, the tool says it is loaded rather than answering with the body.
  expect(rest(after)).toContain('Already loaded in this conversation');
  expect(rest(after)).not.toContain(BODY);
});

it('keeps a loaded group of tools from one turn to the next', async () => {
  const { turn } = await conversation();

  await turn('Look at the picture', [
    calls({ id: 'tools-1', name: 'load_tools', input: { groups: ['media'] } }),
    answer('Looked.'),
  ]);
  const [next] = await turn('And the next one?', [answer('Looked again.')]);

  expect(next?.tools?.map((tool) => tool.name)).toContain('analyze_media');
});

it('lets go at compaction of what was not used since the one before', async () => {
  const { services, profile, session } = await conversation();
  const scope = { profileId: profile.id, sessionId: session.id };
  await useLoads(services.store.db, scope, 'skill', ['lookup'], new Date());
  await useLoads(services.store.db, scope, 'tool', ['analyze_media'], new Date());

  await services.sessions.summarize(profile.id, session.id, 'First summary.');
  // Used again between the two compactions: it stays.
  await useLoads(services.store.db, scope, 'skill', ['lookup'], new Date());
  await services.sessions.summarize(profile.id, session.id, 'Second summary.');

  expect(
    (await listLoads(services.store.db, profile.id, session.id)).map((load) => load.name),
  ).toEqual(['lookup']);
});

it('lets the least recently used skill go past a tenth of the window, and one the profile lost', async () => {
  const big = (name: string) => ({
    name,
    description: `Skill ${name}`,
    // About 2,000 tokens each, at the byte a token unknown models are counted at: one fits in a
    // tenth of the default 32,000, two do not.
    instructions: `${name} `.repeat(330),
  });
  const { services, profile, session, turn, system } = await conversation([
    big('older'),
    big('newer'),
  ]);
  const scope = { profileId: profile.id, sessionId: session.id };
  await useLoads(services.store.db, scope, 'skill', ['older'], new Date(Date.now() - 60_000));
  await useLoads(services.store.db, scope, 'skill', ['newer'], new Date());
  await useLoads(services.store.db, scope, 'skill', ['deleted'], new Date());

  const [opening] = await turn('Go on', [answer('Going.')]);

  expect(system(opening as LanguageModelV3CallOptions)).toContain('## Skill: newer');
  expect(system(opening as LanguageModelV3CallOptions)).not.toContain('## Skill: older');
  expect(
    (await listLoads(services.store.db, profile.id, session.id)).map((load) => load.name),
  ).toEqual(['newer']);
});

it('keeps loaded skills on Claude up to their room in Claude tokens, not bytes', async () => {
  const big = (name: string) => ({
    name,
    description: `Skill ${name}`,
    // About 2,000 bytes each: some 1,000 of Claude's tokens at the half a token it starts from.
    // A tenth of the default 32,000 holds both; counted a byte a token, as before, only one.
    instructions: `${name} `.repeat(330),
  });
  const { services, profile, session, turn, system } = await conversation(
    [big('older'), big('newer')],
    { provider: 'anthropic', modelId: 'claude-test' },
  );
  const scope = { profileId: profile.id, sessionId: session.id };
  await useLoads(services.store.db, scope, 'skill', ['older'], new Date(Date.now() - 60_000));
  await useLoads(services.store.db, scope, 'skill', ['newer'], new Date());

  const [opening] = await turn('Go on', [answer('Going.')]);

  expect(system(opening as LanguageModelV3CallOptions)).toContain('## Skill: newer');
  expect(system(opening as LanguageModelV3CallOptions)).toContain('## Skill: older');
});
