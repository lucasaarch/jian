import { eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { DeploymentDrain, drainOptions, predeployDrain } from '../src/runs/drain.js';
import { RunLifecycle } from '../src/runs/lifecycle.js';
import { listQueuedRuns } from '../src/runs/repository.js';
import { deploymentDrain, runs } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

async function setup() {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Release verifier',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Release' });
  const submit = (key: string) =>
    services.runs.submit(profile.id, session.id, {
      text: key,
      requestKey: key,
    });
  return { services, profile, session, submit, drain: new DeploymentDrain(services.store) };
}

it('drains dependencies without running new roots, then fences every claim across replacement', async () => {
  const { services, profile, session, submit, drain } = await setup();
  const parent = await submit('parent');
  await services.sessions.setObjective(profile.id, session.id, { text: 'Verify the release.' });
  await services.lifecycle.claim(parent.id, profile.id, 'parent-owner');
  await drain.request('deploy');
  const inbound = await submit('inbound');
  expect(inbound.id).not.toBe(parent.id);
  expect(inbound.status).toBe('queued');
  expect(await services.lifecycle.claim(inbound.id, profile.id, 'blocked')).toBeNull();

  const child = await services.work.spawnInConversation(
    parent,
    {
      role: 'execute',
      name: 'Verifier',
      identity: 'Verify.',
      brief: 'Check the release.',
    },
    'verify',
  );
  const peerProfile = await services.profiles.createProfile({
    name: 'Peer',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const peerSession = await services.sessions.createSession(peerProfile.id, { title: 'Peer' });
  const peer = await services.runs.submit(
    peerProfile.id,
    peerSession.id,
    {
      text: 'Check.',
      requestKey: 'peer',
    },
    {
      call: {
        fromProfileId: profile.id,
        fromName: profile.name,
        fromRunId: parent.id,
        fromSessionId: session.id,
        depth: 1,
        chain: [profile.id, peerProfile.id],
      },
    },
  );
  // Filter before pagination: an earlier queued inbound must not starve a dependency.
  expect(await listQueuedRuns(services.store.db, 1)).toEqual([
    { id: child.runId, profileId: profile.id },
  ]);
  expect(await services.lifecycle.claim(child.runId, profile.id, 'child-owner')).not.toBeNull();
  expect(await services.lifecycle.claim(peer.id, peerProfile.id, 'peer-owner')).not.toBeNull();
  expect(await drain.poll('deploy')).toBe(false);
  for (const [id, pid, owner] of [
    [child.runId, profile.id, 'child-owner'],
    [peer.id, peerProfile.id, 'peer-owner'],
    [parent.id, profile.id, 'parent-owner'],
  ] as const) {
    await services.lifecycle.finish(pid, id, owner, 'completed', 'Verified.');
  }
  await services.work.reportWorker(profile.id, child.runId);
  const continuation = await services.objectives.continueAfter(parent);
  expect(continuation?.status).toBe('queued');
  expect(await services.lifecycle.claim(continuation?.id ?? '', profile.id, 'blocked')).toBeNull();
  // Terminal status alone is not a drain: runtime handoffs and cleanup still hold a lease.
  expect(await drain.poll('deploy')).toBe(false);
  for (const [id, owner] of [
    [child.runId, 'child-owner'],
    [peer.id, 'peer-owner'],
    [parent.id, 'parent-owner'],
  ] as const)
    await services.lifecycle.releaseExecution(id, owner);
  expect(await drain.poll('deploy')).toBe(true);
  expect(await listQueuedRuns(services.store.db, 100)).toEqual([]);

  const replacement = new RunLifecycle(services.store, services.runs);
  expect(await replacement.claim(inbound.id, profile.id, 'replacement')).toBeNull();
  const lateChild = await services.work.spawnInConversation(
    parent,
    {
      role: 'execute',
      name: 'Late verifier',
      identity: 'Verify.',
      brief: 'Check.',
    },
    'late',
  );
  expect(await replacement.claim(lateChild.runId, profile.id, 'replacement')).toBeNull();
  await drain.release('wrong-owner');
  expect(await replacement.claim(inbound.id, profile.id, 'replacement')).toBeNull();
  await drain.release('deploy');
  expect(await replacement.claim(inbound.id, profile.id, 'replacement')).not.toBeNull();
  expect((await services.runs.run(profile.id, continuation?.id ?? '')).status).toBe('queued');
  expect(await replacement.claim(continuation?.id ?? '', profile.id, 'same-session')).toBeNull();
});

it('steers internal completion to its running caller without consuming queued owner ingress', async () => {
  const { services, profile, submit, drain } = await setup();
  const parent = await submit('parent');
  await services.lifecycle.claim(parent.id, profile.id, 'parent-owner');
  await drain.request('deploy');
  const inbound = await submit('new-owner-request');
  const child = await services.work.spawnInConversation(
    parent,
    {
      role: 'execute',
      name: 'Verifier',
      identity: 'Verify.',
      brief: 'Check.',
    },
    'handoff',
  );
  await services.lifecycle.claim(child.runId, profile.id, 'child-owner');
  await services.lifecycle.finish(
    profile.id,
    child.runId,
    'child-owner',
    'completed',
    'Dependency done.',
  );
  await services.work.reportWorker(profile.id, child.runId);
  expect(await services.lifecycle.steer(parent.id, 'parent-owner')).toContain('Dependency done.');
  expect((await services.runs.run(profile.id, inbound.id)).input).toBe('new-owner-request');
  expect(await services.lifecycle.claim(inbound.id, profile.id, 'blocked')).toBeNull();
  await services.lifecycle.finish(profile.id, parent.id, 'parent-owner', 'completed', 'Done.');
  await services.lifecycle.releaseExecution(child.runId, 'child-owner');
  await services.lifecycle.releaseExecution(parent.id, 'parent-owner');
  expect(await drain.poll('deploy')).toBe(true);
});

it('never reopens by age and rejects consumed generations and stale releases', async () => {
  const { services, profile, submit, drain } = await setup();
  const inbound = await submit('queued');
  await drain.request('killed-hook');
  await services.store.db
    .update(deploymentDrain)
    .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` });
  expect(await services.lifecycle.claim(inbound.id, profile.id, 'old-worker')).toBeNull();
  await drain.request('killed-hook');
  expect(await drain.poll('killed-hook')).toBe(true);
  expect(await drain.poll('killed-hook')).toBe(true);
  await drain.request('killed-hook');
  expect(await drain.release('wrong-generation')).toBe(false);
  expect(await drain.release('killed-hook')).toBe(true);
  expect(await drain.release('killed-hook')).toBe(false);
  await expect(drain.request('killed-hook')).rejects.toThrow('consumed');
  await drain.request('next-deploy');
  await drain.release('killed-hook');
  expect(await drain.poll('next-deploy')).toBe(true);
  await expect(drain.request('competing-hook')).rejects.toThrow('active');
  expect(await services.lifecycle.claim(inbound.id, profile.id, 'old-worker')).toBeNull();
  // No swap acknowledgement exists: an arbitrarily delayed swap must remain fenced.
  await services.store.db
    .update(deploymentDrain)
    .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` });
  expect(await services.lifecycle.claim(inbound.id, profile.id, 'old-worker')).toBeNull();
  await drain.release('next-deploy');
  expect(await services.lifecycle.claim(inbound.id, profile.id, 'old-worker')).not.toBeNull();
});

it('timeout or signal failure keeps admission closed without cancelling execution', async () => {
  const { services, profile, submit, drain } = await setup();
  const busy = await submit('busy');
  await services.lifecycle.claim(busy.id, profile.id, 'busy-owner');
  const signal = new AbortController();
  await expect(
    predeployDrain(drain, { timeoutMs: 20, generation: 'timeout' }, signal.signal),
  ).rejects.toThrow('timed out');
  expect((await services.runs.run(profile.id, busy.id)).status).toBe('running');
  const otherSession = await services.sessions.createSession(profile.id, {
    title: 'After timeout',
  });
  const queued = await services.runs.submit(profile.id, otherSession.id, {
    text: 'After timeout',
    requestKey: 'after-timeout',
  });
  expect(await services.lifecycle.claim(queued.id, profile.id, 'resumed')).toBeNull();
  await drain.release('timeout');

  const pending = predeployDrain(drain, { timeoutMs: 1000, generation: 'aborted' }, signal.signal);
  setTimeout(() => signal.abort(), 10);
  await expect(pending).rejects.toThrow();
  await expect(drain.request('after-abort')).rejects.toThrow('active');
  await drain.release('aborted');
  await drain.request('after-abort');
});

it('success retains its hold and expired execution tails still require explicit cleanup', async () => {
  const { services, profile, submit, drain } = await setup();
  const completed = await submit('completed');
  await services.lifecycle.claim(completed.id, profile.id, 'owner');
  await services.lifecycle.finish(profile.id, completed.id, 'owner', 'completed', 'Done.');
  await services.store.db
    .update(runs)
    .set({ executionUntil: sql`clock_timestamp() - interval '1 second'` })
    .where(eq(runs.id, completed.id));
  await drain.request('tail');
  expect(await drain.poll('tail')).toBe(false);
  await services.lifecycle.releaseExecution(completed.id, 'owner');
  await predeployDrain(
    drain,
    { timeoutMs: 1000, generation: 'tail' },
    new AbortController().signal,
  );
  const queued = await submit('retained');
  expect(await services.lifecycle.claim(queued.id, profile.id, 'blocked')).toBeNull();
});

it('validates finite CLI bounds and rejects ambiguous arguments', () => {
  expect(drainOptions([], 'deployment')).toEqual({ timeoutMs: 480_000, generation: 'deployment' });
  expect(drainOptions(['--timeout-seconds', '5', '--generation', 'new'])).toEqual({
    timeoutMs: 5000,
    generation: 'new',
  });
  expect(() => drainOptions([])).toThrow();
  for (const args of [
    ['--timeout-seconds'],
    ['--timeout-seconds', '0'],
    ['--hold-seconds', '3601'],
    ['--hold-seconds', 'NaN'],
    ['--hold-seconds', '1.5'],
    ['--unknown', '3'],
    ['--hold-seconds', '3', '--hold-seconds', '4'],
  ])
    expect(() => drainOptions(args, 'deployment')).toThrow();
});
