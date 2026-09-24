import { describe, expect, it } from 'vitest';
import { testServices } from './helpers/services.js';

async function setup() {
  const services = await testServices();
  const input = {
    instructions: 'Help.',
    model: { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  };
  const profile = await services.profiles.createProfile({ ...input, name: 'Owner' });
  const other = await services.profiles.createProfile({ ...input, name: 'Other' });
  const session = await services.sessions.gatewaySession(profile.id);
  const turn = async (key: string) => {
    const run = await services.runs.submit(profile.id, session.id, {
      text: 'Pesquisa o deploy',
      requestKey: key,
    });

    await services.lifecycle.claim(run.id, profile.id, 'worker');

    return {
      run,
      write: (data: Record<string, unknown>) =>
        services.lifecycle.checkpoint(profile.id, run.id, 'worker', data),
      finish: () => services.lifecycle.finish(profile.id, run.id, 'worker', 'completed', 'Pronto.'),
    };
  };

  return { services, profile, other, session, turn };
}

describe("a conversation's tool timeline", () => {
  it('shows each tool and how it ended, without its input, result or the prompt', async () => {
    const f = await setup();
    const first = await f.turn('first');

    await first.write({
      phase: 'tool-started',
      toolName: 'web_search',
      toolCallId: 'a',
      input: { query: 'deploy jian' },
    });
    await first.write({
      phase: 'tool-started',
      toolName: 'run_command',
      toolCallId: 'b',
      input: { command: 'ls' },
    });
    await first.write({
      phase: 'tool-failed',
      toolName: 'run_command',
      toolCallId: 'b',
      reason: 'exit 1',
    });
    await first.write({
      phase: 'step-completed',
      prompt: { secret: 'the whole prompt, never sent to the timeline' },
      tools: [{ toolName: 'web_search', toolCallId: 'a', result: { hits: 3 } }],
    });
    await first.write({
      phase: 'tool-started',
      toolName: 'fetch_url',
      toolCallId: 'c',
      input: { url: 'x' },
    });
    await first.finish();

    const [timeline] = await f.services.sessions.timeline(f.profile.id, f.session.id);

    expect(timeline?.runId).toBe(first.run.id);
    expect(timeline?.steps.map((step) => [step.toolName, step.status])).toEqual([
      ['web_search', 'done'],
      ['run_command', 'failed'],
      // Started in a turn that ended before it came back.
      ['fetch_url', 'stopped'],
    ]);
    expect(timeline?.steps[1]?.error).toBe('exit 1');
    expect(JSON.stringify(timeline)).not.toContain('the whole prompt');
    expect(JSON.stringify(timeline)).not.toContain('deploy jian');
    expect(JSON.stringify(timeline)).not.toContain('hits');
  });

  it('keeps a tool running while its turn still is, and stays inside its profile', async () => {
    const f = await setup();
    const live = await f.turn('live');

    await live.write({ phase: 'tool-started', toolName: 'web_search', toolCallId: 'a', input: {} });

    const [timeline] = await f.services.sessions.timeline(f.profile.id, f.session.id);

    expect(timeline?.steps[0]?.status).toBe('running');
    await expect(f.services.sessions.timeline(f.other.id, f.session.id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
