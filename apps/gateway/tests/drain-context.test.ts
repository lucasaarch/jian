import type { ToolSet } from 'ai';
import { expect, it } from 'vitest';
import { profileTools } from '../src/agent/tools.js';
import { Coordination } from '../src/coordination/service.js';
import { DeploymentDrain } from '../src/runs/drain.js';
import { testServices } from './helpers/services.js';

async function invoke(tools: ToolSet, name: string, input: unknown) {
  const definition = tools[name];
  if (!definition?.execute) throw new Error(`Tool ${name} is unavailable`);
  return definition.execute(input as never, { toolCallId: 'test', messages: [], context: {} });
}

it('keeps queued ingress out of context and model read tools without hiding owner history or same-run steer', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Context race',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Drain race' });
  const submit = (text: string) =>
    services.runs.submit(profile.id, session.id, { text, requestKey: text });
  const prior = await submit('PRIOR_HISTORY');
  await services.lifecycle.claim(prior.id, profile.id, 'prior');
  await services.lifecycle.finish(profile.id, prior.id, 'prior', 'completed', 'PRIOR_ANSWER');
  await services.lifecycle.releaseExecution(prior.id, 'prior');
  const current = await submit('ORIGINAL_REQUEST');
  const claimed = await services.lifecycle.claim(current.id, profile.id, 'current');
  if (!claimed) throw new Error('Claim missing');
  const steer = await submit('SAME_RUN_STEER');
  expect(steer.id).toBe(current.id);
  const drain = new DeploymentDrain(services.store);
  await drain.request('context');
  const queued = await submit('NEW_INGRESS_DO_NOT_ENROLL');
  expect(queued.id).not.toBe(current.id);
  expect(queued.status).toBe('queued');
  const serialized = JSON.stringify(await services.contexts.context(claimed));
  expect(serialized).not.toContain('NEW_INGRESS_DO_NOT_ENROLL');
  expect(serialized).toContain('ORIGINAL_REQUEST');
  expect(serialized).toContain('PRIOR_HISTORY');
  expect(serialized).toContain('PRIOR_ANSWER');
  expect(serialized).toContain('SAME_RUN_STEER');
  const tools = profileTools(services, claimed);
  const read = await invoke(tools, 'read_session', { sessionId: session.id });
  const activities = await invoke(tools, 'list_activities', {});
  const history = await invoke(tools, 'search_history', { sessionId: session.id, limit: 20 });
  const search = await invoke(tools, 'search_history', {
    sessionId: session.id,
    q: 'NEW_INGRESS_DO_NOT_ENROLL',
    limit: 20,
  });
  expect(JSON.stringify([read, activities, history, search])).not.toContain(
    'NEW_INGRESS_DO_NOT_ENROLL',
  );
  expect(JSON.stringify(read)).toContain('SAME_RUN_STEER');
  expect(JSON.stringify(history)).toContain('PRIOR_ANSWER');
  // Queue management still sees that deferred work exists, never its actionable payload.
  expect(activities).toContainEqual(expect.objectContaining({ id: queued.id, status: 'queued' }));
  expect(
    JSON.stringify(await new Coordination(services).history(profile.id, session.id, { limit: 20 })),
  ).toContain('NEW_INGRESS_DO_NOT_ENROLL');
  expect(
    (await services.sessions.messages(profile.id, session.id)).some(
      (message) => message.content === 'NEW_INGRESS_DO_NOT_ENROLL',
    ),
  ).toBe(true);
  await services.lifecycle.finish(
    profile.id,
    current.id,
    'current',
    'completed',
    'Finished original.',
  );
  await services.lifecycle.releaseExecution(current.id, 'current');
  expect(await drain.poll('context')).toBe(true);
  await drain.release('context');
  const resumed = await services.lifecycle.claim(queued.id, profile.id, 'resumed');
  if (!resumed) throw new Error('Resumed claim missing');
  const resumedContext = JSON.stringify(await services.contexts.context(resumed));
  expect(resumedContext).toContain('NEW_INGRESS_DO_NOT_ENROLL');
  expect(resumedContext).toContain('Finished original.');
  const resumedTools = profileTools(services, resumed);
  expect(
    JSON.stringify(await invoke(resumedTools, 'read_session', { sessionId: session.id })),
  ).toContain('NEW_INGRESS_DO_NOT_ENROLL');
  expect(JSON.stringify(await invoke(resumedTools, 'list_activities', {}))).toContain(
    'NEW_INGRESS_DO_NOT_ENROLL',
  );
  expect(
    JSON.stringify(
      await invoke(resumedTools, 'search_history', { sessionId: session.id, limit: 20 }),
    ),
  ).toContain('NEW_INGRESS_DO_NOT_ENROLL');
});
