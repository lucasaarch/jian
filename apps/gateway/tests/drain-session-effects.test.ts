import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { DeploymentDrain } from '../src/runs/drain.js';
import type { SubmitOptions } from '../src/runs/port.js';
import { cavemanMode, ponytailMode } from '../src/sessions/repository.js';
import { runs } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

async function setup() {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Session isolation',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const session = await services.sessions.createSession(profile.id, { channel: 'api' });
  let key = 0;
  const submit = (
    text: string,
    options: SubmitOptions = { ownerMessage: true },
    requestKey = `input-${++key}`,
  ) => services.runs.submit(profile.id, session.id, { text, requestKey }, options);
  const read = () => services.sessions.session(profile.id, session.id);
  const pending = async (id: string) => {
    const [row] = await services.store.db
      .select({ effects: runs.pendingSessionEffects })
      .from(runs)
      .where(eq(runs.id, id));
    return row?.effects;
  };
  const modes = async () => ({
    ponytail: await ponytailMode(services.store.db, profile.id, session.id),
    caveman: await cavemanMode(services.store.db, profile.id, session.id),
  });
  return {
    services,
    profile,
    session,
    submit,
    read,
    pending,
    modes,
    drain: new DeploymentDrain(services.store),
  };
}

it('keeps claimed A isolated from queued B until an admitted claim; consumes exactly once', async () => {
  const { services, profile, session, submit, read, pending, drain } = await setup();
  await services.sessions.setObjective(profile.id, session.id, { text: 'OLD' });
  const a = await submit('Start');
  await services.lifecycle.claim(a.id, profile.id, 'A');
  await drain.request('deploy');
  const b = await submit('/objective NEW', { ownerMessage: true }, 'B');
  expect((await read()).objective?.text).toBe('OLD');
  expect(await pending(b.id)).toMatchObject({ objectiveCommand: { action: 'set', text: 'NEW' } });
  expect(await services.lifecycle.claim(b.id, profile.id, 'denied')).toBeNull();
  expect(await drain.release('wrong-generation')).toBe(false);
  expect((await read()).objective?.text).toBe('OLD');
  await drain.release('deploy');
  // Releasing admission is not a claim; a still executing A also prevents the effect.
  expect((await read()).objective?.text).toBe('OLD');
  expect(await services.lifecycle.claim(b.id, profile.id, 'still-denied')).toBeNull();
  await services.lifecycle.finish(profile.id, a.id, 'A', 'completed', 'Done');
  expect(await services.lifecycle.claim(b.id, profile.id, 'tail-denied')).toBeNull();
  await services.lifecycle.releaseExecution(a.id, 'A');
  expect(await services.lifecycle.claim(b.id, profile.id, 'B')).not.toBeNull();
  expect((await read()).objective?.text).toBe('NEW');
  expect(await pending(b.id)).toBeNull();
  await services.sessions.setObjective(profile.id, session.id, { text: 'Later edit' });
  expect(await services.lifecycle.claim(b.id, profile.id, 'stale')).toBeNull();
  expect((await submit('/objective NEW', { ownerMessage: true }, 'B')).id).toBe(b.id);
  expect((await read()).objective?.text).toBe('Later edit');
});

it.each([
  ['/objective NEW', 'open', 'NEW'],
  ['/objective done', 'done', 'OLD'],
  ['/done', 'done', 'OLD'],
  ['/objective cancel', 'cancelled', 'OLD'],
  ['/cancel objective', 'cancelled', 'OLD'],
  ['Here is the answer', 'open', 'OLD'],
])(
  'defers objective semantics for %s and uses claim-time session state',
  async (text, status, goal) => {
    const { services, profile, session, submit, read, drain } = await setup();
    await services.sessions.setObjective(profile.id, session.id, {
      text: 'Before submission',
      status: 'blocked',
      note: 'Need input',
    });
    await drain.request('deploy');
    const run = await submit(text);
    expect((await read()).objective).toMatchObject({
      text: 'Before submission',
      status: 'blocked',
    });
    await services.sessions.setObjective(profile.id, session.id, {
      text: 'OLD',
      status: 'blocked',
      note: 'Fresh block',
    });
    await drain.release('deploy');
    expect((await read()).objective?.status).toBe('blocked');
    await services.lifecycle.claim(run.id, profile.id, 'owner');
    expect((await read()).objective).toMatchObject({ text: goal, status });
  },
);

it.each([
  ['/ponytail off', { ownerMessage: true }, { ponytail: 'off', caveman: 'off' }],
  ['/caveman ultra', { ownerMessage: true }, { ponytail: 'full', caveman: 'ultra' }],
  ['/ponytail off', { activity: 'channel' }, { ponytail: 'full', caveman: 'off' }],
  ['/caveman ultra', {}, { ponytail: 'full', caveman: 'off' }],
] as const)('persists only authorized mode intent for %s (%j)', async (text, options, expected) => {
  const { services, profile, submit, modes, drain } = await setup();
  await drain.request('deploy');
  const run = await submit(text, options);
  expect(await modes()).toEqual({ ponytail: 'full', caveman: 'off' });
  expect(await services.lifecycle.claim(run.id, profile.id, 'denied')).toBeNull();
  await drain.release('deploy');
  expect(await modes()).toEqual({ ponytail: 'full', caveman: 'off' });
  await services.lifecycle.claim(run.id, profile.id, 'owner');
  expect(await modes()).toEqual(expected);
});

it('does not upgrade internal objective-looking input or ordinary internal replies to person authority', async () => {
  const { services, profile, session, submit, read, drain } = await setup();
  await services.sessions.setObjective(profile.id, session.id, { text: 'OLD', status: 'blocked' });
  await drain.request('deploy');
  const run = await submit('/objective NEW', {});
  await drain.release('deploy');
  await services.lifecycle.claim(run.id, profile.id, 'owner');
  expect((await read()).objective).toMatchObject({ text: 'OLD', status: 'blocked' });
});

it.each(['/objective NEW', '/ponytail off', '/caveman ultra', 'Here is my answer'])(
  'defers waiting-answer effects for %s, not its generated resume prompt',
  async (text) => {
    const { services, profile, session, submit, read, pending, modes, drain } = await setup();
    const a = await submit('Ask');
    await services.lifecycle.claim(a.id, profile.id, 'A');
    await services.lifecycle.wait(profile.id, a.id, 'A', {
      id: a.id,
      prompt: 'What next?',
      askedAt: new Date().toISOString(),
    });
    await services.sessions.setObjective(profile.id, session.id, {
      text: 'OLD',
      status: 'blocked',
    });
    await drain.request('deploy');
    const b = await submit(text);
    expect(b.continuationOf).toBe(a.id);
    expect(b.input).toContain('What next?');
    expect(await pending(b.id)).not.toBeNull();
    expect((await read()).objective).toMatchObject({ text: 'OLD', status: 'blocked' });
    expect(await modes()).toEqual({ ponytail: 'full', caveman: 'off' });
    expect(await services.lifecycle.claim(b.id, profile.id, 'denied')).toBeNull();
    await services.lifecycle.releaseExecution(a.id, 'A');
    await drain.release('deploy');
    await services.lifecycle.claim(b.id, profile.id, 'B');
    expect((await read()).objective).toMatchObject({
      text: text === '/objective NEW' ? 'NEW' : 'OLD',
      status: 'open',
    });
    expect(await modes()).toEqual({
      ponytail: text === '/ponytail off' ? 'off' : 'full',
      caveman: text === '/caveman ultra' ? 'ultra' : 'off',
    });
    expect(await pending(b.id)).toBeNull();
  },
);

it('cancelled queued input never applies its effects', async () => {
  const { services, profile, session, submit, read, drain } = await setup();
  await services.sessions.setObjective(profile.id, session.id, { text: 'OLD' });
  await drain.request('deploy');
  const run = await submit('/objective NEW');
  await services.runs.cancel(profile.id, run.id);
  await drain.release('deploy');
  expect(await services.lifecycle.claim(run.id, profile.id, 'owner')).toBeNull();
  expect((await read()).objective?.text).toBe('OLD');
});

it('same-run server handoffs cannot introduce session effects or resume blocked work', async () => {
  const { services, profile, session, submit, read, modes, drain } = await setup();
  const a = await submit('Start');
  await services.lifecycle.claim(a.id, profile.id, 'A');
  await services.sessions.setObjective(profile.id, session.id, { text: 'OLD', status: 'blocked' });
  await drain.request('deploy');
  for (const text of ['/objective NEW', '/ponytail off', '/caveman ultra', 'Result']) {
    expect(
      (await submit(text, { activity: 'channel', ownerMessage: true, handoffToRunId: a.id })).id,
    ).toBe(a.id);
  }
  expect((await read()).objective).toMatchObject({ text: 'OLD', status: 'blocked' });
  expect(await modes()).toEqual({ ponytail: 'full', caveman: 'off' });
});

it('preserves immediate non-drain commands, steering, blocked resume and duplicate idempotency', async () => {
  const { services, profile, session, submit, read, modes, pending } = await setup();
  const a = await submit('/objective NEW', { ownerMessage: true }, 'objective');
  expect((await read()).objective?.text).toBe('NEW');
  expect(await pending(a.id)).toBeNull();
  await services.sessions.setObjective(profile.id, session.id, {
    text: 'Later',
    status: 'blocked',
  });
  expect((await submit('/objective NEW', { ownerMessage: true }, 'objective')).id).toBe(a.id);
  expect((await read()).objective).toMatchObject({ text: 'Later', status: 'blocked' });
  expect((await submit('Answer')).id).toBe(a.id);
  expect((await read()).objective).toMatchObject({ text: 'Later', status: 'open' });
  expect((await submit('/ponytail off')).id).toBe(a.id);
  expect((await submit('/caveman ultra')).id).toBe(a.id);
  expect(await modes()).toEqual({ ponytail: 'off', caveman: 'ultra' });
});
