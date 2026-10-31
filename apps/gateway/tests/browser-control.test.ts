import { expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import type { NativeBrowser } from '../src/web/native.js';
import { WebSearch } from '../src/web/service.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const call = (toolName: string, input: unknown) => ({
  content: [
    { type: 'tool-call' as const, toolCallId: toolName, toolName, input: JSON.stringify(input) },
  ],
  finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
  usage,
  warnings: [],
});
const answer = {
  content: [{ type: 'text' as const, text: 'Done.' }],
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage,
  warnings: [],
};
const acted = {
  url: 'https://atlas.test/',
  title: 'Atlas',
  viewport: { width: 800, height: 600 },
  visible: true,
  screenshot: null,
  frames: [],
};
const capture = {
  screenshot: Buffer.from('shot'),
  archive: Buffer.from('zip'),
  snapshot: {
    url: 'https://atlas.test/',
    title: 'Atlas',
    viewport: { width: 800, height: 600 },
    actions: [],
    frames: [],
    resources: [],
    blocked: [],
    framesTruncated: false,
    sourceNote: '',
  },
};

async function setup(native?: NativeBrowser) {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    // A model's own window, not the floor of one nobody has chosen yet.
    contextPolicy: { inputTokens: 200_000 },
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Web' });
  const web = new WebSearch(services.store, services.gatewayVault, fetch, native);
  return { services: { ...services, web }, profile, session };
}
const nativeStub = () => ({
  inspect: vi.fn(async () => capture),
  act: vi.fn(async () => acted),
});
type Options = { tools?: Array<{ name: string }> };
/** Scripts the agent's steps. A summary the gateway asks for offers no tools and is no step. */
const scripted = (
  step: (index: number, tools: string[]) => ReturnType<typeof call> | typeof answer,
) => {
  let index = 0;
  return mockModel({
    doGenerate: async (options: Options) => {
      if (!options.tools?.length) return answer;
      index += 1;
      return step(
        index,
        options.tools.map((tool) => tool.name),
      );
    },
  });
};

it('offers the browser with the web tools only where there is one', async () => {
  for (const [native, offered] of [
    [nativeStub(), true],
    [undefined, false],
  ] as const) {
    const { services, profile, session } = await setup(native);
    let seen: string[] = [];
    const model = scripted((step, tools) => {
      if (step === 1) return call('load_tools', { groups: ['web'] });
      seen = tools;
      return answer;
    });
    const run = await services.runs.submit(profile.id, session.id, {
      text: 'Look around',
      requestKey: 'look',
    });
    await new AgentRuntime(services, () => model).execute(profile.id, run.id);
    expect(seen.includes('browser_control')).toBe(offered);
    expect(seen).toContain('inspect_page');
  }
});

it('keeps the browser in reach after an approved inspection, in the turn that carries on', async () => {
  const native = nativeStub();
  const { services, profile, session } = await setup(native);
  let afterApproval: string[] = [];
  const model = scripted((step, tools) => {
    if (step === 1) return call('load_tools', { groups: ['web'] });
    if (step === 2) return call('inspect_page', { url: 'https://atlas.test/' });
    afterApproval = tools;
    return answer;
  });
  const runtime = new AgentRuntime(services, () => model);
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Explore the prototype',
    requestKey: 'explore',
  });
  await runtime.execute(profile.id, run.id);
  expect((await services.runs.run(profile.id, run.id)).status).toBe('waiting');

  const resume = await services.runs.decideApproval(profile.id, run.id, { decision: 'approve' });
  await runtime.execute(profile.id, resume.id);

  expect(native.inspect).toHaveBeenCalledOnce();
  expect(afterApproval).toContain('browser_control');
});

it('asks before acting in a conversation that asks first, and then acts in its scope', async () => {
  const native = nativeStub();
  const { services, profile, session } = await setup(native);
  const model = scripted((step) => {
    if (step === 1) return call('load_tools', { groups: ['web'] });
    if (step === 2) return call('browser_control', { action: 'click', selector: '#buy' });
    return answer;
  });
  const runtime = new AgentRuntime(services, () => model);
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Click it',
    requestKey: 'click',
  });
  await runtime.execute(profile.id, run.id);

  const parked = await services.runs.run(profile.id, run.id);
  expect(parked.status).toBe('waiting');
  expect(parked.approval).toMatchObject({ toolName: 'browser_control', kind: 'machine' });
  expect(native.act).not.toHaveBeenCalled();

  const resume = await services.runs.decideApproval(profile.id, run.id, { decision: 'approve' });
  await runtime.execute(profile.id, resume.id);

  expect(native.act).toHaveBeenCalledOnce();
  expect(native.act.mock.calls[0]?.slice(0, 2)).toMatchObject([
    { action: 'click', selector: '#buy' },
    { profileId: profile.id, sessionId: session.id },
  ]);
});
