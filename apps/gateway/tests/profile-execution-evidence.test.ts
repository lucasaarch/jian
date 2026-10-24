import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { remoteTasks, runs } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

async function setup() {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Evidence',
    instructions: 'Help.',
  });
  const session = await services.sessions.gatewaySession(profile.id);
  return { services, profile, session };
}

it.each(['completed', 'failed', 'cancelled', 'interrupted', 'waiting'] as const)(
  'preserves an unresolved worker marker on a %s run during reset and delete',
  async (status) => {
    const { services, profile, session } = await setup();
    const id = randomUUID();
    await services.store.db.insert(runs).values({
      id,
      profileId: profile.id,
      sessionId: session.id,
      profileVersion: profile.version,
      requestKey: id,
      input: 'Synthetic work',
      status,
      executionOwner: 'unsettled-worker',
    });
    for (const operation of ['resetProfile', 'deleteProfile'] as const) {
      await expect(services.profiles[operation](profile.id)).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(await services.store.db.select().from(runs)).toHaveLength(1);
      expect((await services.profiles.profile(profile.id)).professionId).toBeNull();
    }
    await services.store.db.update(runs).set({ executionOwner: null }).where(eq(runs.id, id));
    await expect(services.profiles.resetProfile(profile.id)).resolves.toMatchObject({
      id: profile.id,
    });
    await expect(services.profiles.deleteProfile(profile.id)).resolves.toEqual({ id: profile.id });
  },
);

it.each(['queued', 'running'] as const)(
  'refuses to erase %s Remote task evidence by deleting the profile',
  async (status) => {
    const { services, profile } = await setup();
    const machine = await services.remote.create({
      name: 'Synthetic',
      allowedProfileIds: [profile.id],
    });
    const id = randomUUID();
    await services.store.db.insert(remoteTasks).values({
      id,
      profileId: profile.id,
      machineId: machine.id,
      command: 'printf ok',
      timeoutMs: 1000,
      status,
    });
    await expect(services.profiles.deleteProfile(profile.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(services.profiles.resetProfile(profile.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(await services.store.db.select().from(remoteTasks)).toHaveLength(1);
    await services.store.db
      .update(remoteTasks)
      .set({ status: 'completed' })
      .where(eq(remoteTasks.id, id));
    await expect(services.profiles.deleteProfile(profile.id)).resolves.toEqual({ id: profile.id });
  },
);

it.each(['completed', 'failed', 'interrupted'] as const)(
  'preserves a pending %s subagent handoff even after execution settles',
  async (status) => {
    const { services, profile, session } = await setup();
    const id = randomUUID();
    await services.store.db.insert(runs).values({
      id,
      profileId: profile.id,
      sessionId: session.id,
      profileVersion: profile.version,
      requestKey: id,
      input: 'Synthetic worker',
      status,
      subagent: {
        role: 'review',
        name: 'Reviewer',
        identity: 'Review.',
        parentRunId: randomUUID(),
        spawnKey: id,
        inputHash: 'a'.repeat(64),
      },
    });
    for (const operation of ['resetProfile', 'deleteProfile'] as const) {
      await expect(services.profiles[operation](profile.id)).rejects.toMatchObject({
        statusCode: 409,
      });
    }
    expect(await services.store.db.select().from(runs)).toHaveLength(1);
    await services.store.db
      .update(runs)
      .set({ subagentReportedAt: new Date() })
      .where(eq(runs.id, id));
    await expect(services.profiles.resetProfile(profile.id)).resolves.toMatchObject({
      id: profile.id,
    });
    await expect(services.profiles.deleteProfile(profile.id)).resolves.toEqual({ id: profile.id });
  },
);

it('does not block another profile because an execution marker exists elsewhere', async () => {
  const { services, profile, session } = await setup();
  const other = await services.profiles.createProfile({ name: 'Other', instructions: 'Help.' });
  const id = randomUUID();
  await services.store.db.insert(runs).values({
    id,
    profileId: profile.id,
    sessionId: session.id,
    profileVersion: profile.version,
    requestKey: id,
    input: 'Synthetic work',
    status: 'completed',
    executionOwner: 'worker',
  });
  await expect(services.profiles.deleteProfile(other.id)).resolves.toEqual({ id: other.id });
  expect(await services.store.db.select().from(runs)).toHaveLength(1);
});
