import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { DeploymentDrain } from '../src/runs/drain.js';
import { DrainRecovery, recoveryOptions } from '../src/runs/drain-recovery.js';
import { listQueuedRuns } from '../src/runs/repository.js';
import { events, runs } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

it('requires an exact generation and owner to reconcile an explicitly stopped executor', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Recovery',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Crash' });
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Work',
    requestKey: 'work',
  });
  await services.lifecycle.claim(run.id, profile.id, 'executor');
  const drain = new DeploymentDrain(services.store);
  const recovery = new DrainRecovery(services.store);
  await drain.request('generation');
  await services.store.db
    .update(runs)
    .set({
      executionUntil: sql`clock_timestamp() - interval '1 hour'`,
      leaseUntil: 0,
    })
    .where(eq(runs.id, run.id));
  await services.lifecycle.recover();
  expect((await recovery.inspect()).executions).toHaveLength(1);
  expect(await drain.poll('generation')).toBe(false);
  await expect(recovery.reconcileExecution('wrong', run.id, 'executor')).rejects.toThrow(
    'generation',
  );
  await expect(recovery.reconcileExecution('generation', run.id, 'stale')).rejects.toThrow('owner');
  expect(await drain.poll('generation')).toBe(false);
  await recovery.reconcileExecution('generation', run.id, 'executor');
  expect((await recovery.inspect()).executions).toEqual([]);
  expect((await services.runs.run(profile.id, run.id)).status).toBe('interrupted');
  expect(await drain.poll('generation')).toBe(true);
  await expect(recovery.reconcileExecution('generation', run.id, 'executor')).rejects.toThrow(
    'owner',
  );
  const audit = await services.store.db
    .select()
    .from(events)
    .where(eq(events.type, 'run.execution-reconciled'));
  expect(audit).toHaveLength(1);
});

it('does not enroll owner-answer peer continuations as dependencies during drain', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Ingress',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Peer answer' });
  const run = await services.runs.submit(
    profile.id,
    session.id,
    {
      text: 'Human answer',
      requestKey: `ask-answer:${randomUUID()}`,
    },
    {
      call: {
        fromProfileId: profile.id,
        fromName: 'Caller',
        fromRunId: randomUUID(),
        fromSessionId: session.id,
        depth: 1,
        chain: [profile.id],
      },
    },
  );
  const drain = new DeploymentDrain(services.store);
  await drain.request('answer');
  expect(await services.lifecycle.claim(run.id, profile.id, 'executor')).toBeNull();
  expect(await listQueuedRuns(services.store.db, 10)).toEqual([]);
  expect(await drain.poll('answer')).toBe(true);
  await drain.release('answer');
  expect(await services.lifecycle.claim(run.id, profile.id, 'executor')).not.toBeNull();
});

it('defaults to inspection and requires explicit stop assertions for mutations', () => {
  expect(recoveryOptions([])).toEqual({ action: 'inspect' });
  expect(recoveryOptions(['inspect'])).toEqual({ action: 'inspect' });
  expect(
    recoveryOptions(['release', '--generation', 'id', '--confirm-deployment-stopped']),
  ).toEqual({ action: 'release', generation: 'id' });
  const runId = randomUUID();
  expect(
    recoveryOptions([
      'reconcile',
      '--generation',
      'id',
      '--run-id',
      runId,
      '--execution-owner',
      'owner',
      '--confirm-executor-stopped',
    ]),
  ).toEqual({ action: 'reconcile', generation: 'id', runId, executionOwner: 'owner' });
  for (const args of [
    ['release', '--generation', 'id'],
    ['release', '--generation', 'id', '--confirm-executor-stopped'],
    ['release', '--generation', 'id', '--generation', 'new', '--confirm-deployment-stopped'],
    ['reconcile', '--generation', 'id', '--run-id', runId, '--execution-owner', 'owner'],
    ['inspect', '--confirm-deployment-stopped'],
    ['release', '--generation', 'id', '--unknown'],
  ])
    expect(() => recoveryOptions(args)).toThrow();
});
