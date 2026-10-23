import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeploymentDrain } from '../src/runs/drain.js';
import { SecretBox } from '../src/security/crypto.js';
import { GatewayVault } from '../src/security/gateway-vault.js';
import { Vault } from '../src/security/vault.js';
import { buildServices } from '../src/services.js';
import { PostgresStore } from '../src/storage/postgres.js';
import { deploymentDrain, runs } from '../src/storage/schema.js';

// Opt in with a disposable database, independently of the ordinary PGlite suite.
const url = process.env.DRAIN_TEST_DATABASE_URL;

describe.skipIf(!url)('PostgreSQL deployment drain concurrency', () => {
  const stores: PostgresStore[] = [];
  const box = new SecretBox({ activeKeyId: 'test', keys: { test: randomBytes(32) } });
  function connect() {
    const store = new PostgresStore(url ?? '');
    stores.push(store);
    return {
      store,
      ...buildServices({
        store,
        vault: new Vault(store, box),
        gatewayVault: new GatewayVault(store, box),
      }),
    };
  }
  let first: ReturnType<typeof connect>;
  let second: ReturnType<typeof connect>;

  beforeAll(async () => {
    first = connect();
    second = connect();
    await first.store.migrate();
  });

  afterAll(async () => {
    await Promise.all(stores.map((store) => store.close()));
  });

  it('serializes the drain transition with claims across profiles and database connections', async () => {
    const drain = new DeploymentDrain(second.store);
    for (let iteration = 0; iteration < 12; iteration++) {
      const batch = await Promise.all(
        Array.from({ length: 4 }, async (_, index) => {
          const services = index % 2 ? first : second;
          const profile = await services.profiles.createProfile({
            name: 'Drain race',
            instructions: 'Help.',
            model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
          });
          const session = await services.sessions.createSession(profile.id, { title: 'Race' });
          const run = await services.runs.submit(profile.id, session.id, {
            text: 'Work',
            requestKey: randomUUID(),
          });
          return { services, profile, run, owner: randomUUID() };
        }),
      );
      const deployment = randomUUID();
      try {
        const claims = batch.map(
          ({ services, run, profile, owner }) =>
            () =>
              services.lifecycle.claim(run.id, profile.id, owner),
        );
        // Reverse scheduling too: exercise both ordinary claim-first and drain-first races.
        const requested = iteration % 2 ? drain.request(deployment) : undefined;
        const results = await Promise.all(claims.map((claim) => claim()));
        await (requested ?? drain.request(deployment));
        expect(await drain.poll(deployment)).toBe(!results.some(Boolean));
        for (let index = 0; index < batch.length; index++) {
          const item = batch[index];
          if (!item) throw new Error('Missing test run');
          if (results[index]) {
            await item.services.lifecycle.finish(
              item.profile.id,
              item.run.id,
              item.owner,
              'completed',
              'Done',
            );
            // A terminal row is not sufficient: cleanup still owns execution.
            expect(await drain.poll(deployment)).toBe(false);
            await item.services.lifecycle.releaseExecution(item.run.id, item.owner);
          } else {
            expect(
              await item.services.lifecycle.claim(item.run.id, item.profile.id, item.owner),
            ).toBeNull();
          }
        }
        // poll may already have transitioned to holding when drain won every race.
        if (results.some(Boolean)) expect(await drain.poll(deployment)).toBe(true);
        await drain.release(randomUUID());
        for (const item of batch) {
          if ((await item.services.runs.run(item.profile.id, item.run.id)).status === 'queued') {
            expect(
              await item.services.lifecycle.claim(item.run.id, item.profile.id, item.owner),
            ).toBeNull();
          }
        }
      } finally {
        await drain.release(deployment);
        // Finish any roots that queued behind this iteration's gate; no state leaks to the next.
        for (const item of batch) {
          if (await item.services.lifecycle.claim(item.run.id, item.profile.id, item.owner)) {
            await item.services.lifecycle.finish(
              item.profile.id,
              item.run.id,
              item.owner,
              'completed',
              'Done',
            );
            await item.services.lifecycle.releaseExecution(item.run.id, item.owner);
          }
        }
      }
    }
  }, 30_000);

  async function queuedRun() {
    const profile = await first.profiles.createProfile({
      name: 'Uncertain deployment',
      instructions: 'Help.',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    });
    const session = await first.sessions.createSession(profile.id, { title: 'Uncertainty' });
    const run = await first.runs.submit(profile.id, session.id, {
      text: 'Work',
      requestKey: randomUUID(),
    });
    return { profile, run, owner: randomUUID() };
  }

  it('does not reopen admission merely because the successful hook hold has aged', async () => {
    const drain = new DeploymentDrain(second.store);
    const deployment = randomUUID();
    const { profile, run, owner } = await queuedRun();
    try {
      await drain.request(deployment);
      expect(await drain.poll(deployment)).toBe(true);
      // Simulate Cubeship pausing longer than any nominal hold before its eventual swap.
      await first.store.db
        .update(deploymentDrain)
        .set({
          expiresAt: sql`clock_timestamp() - interval '1 hour'`,
        })
        .where(eq(deploymentDrain.id, 1));
      expect(await first.lifecycle.claim(run.id, profile.id, owner)).toBeNull();
    } finally {
      await drain.release(deployment);
      const current = await first.runs.run(profile.id, run.id);
      if (current.status === 'running') {
        await first.lifecycle.finish(profile.id, run.id, owner, 'completed', 'Done');
        await first.lifecycle.releaseExecution(run.id, owner);
      }
    }
  });

  it('includes an already-queued dependency when its parent has finished', async () => {
    const drain = new DeploymentDrain(second.store);
    const deployment = randomUUID();
    const { profile, run, owner } = await queuedRun();
    let childId: string | undefined;
    try {
      await first.lifecycle.claim(run.id, profile.id, owner);
      const child = await first.work.spawnInConversation(
        run,
        {
          role: 'execute',
          name: 'Dependency',
          identity: 'Verify.',
          brief: 'Check.',
        },
        randomUUID(),
      );
      childId = child.runId;
      await first.lifecycle.finish(profile.id, run.id, owner, 'completed', 'Done');
      await first.lifecycle.releaseExecution(run.id, owner);
      await drain.request(deployment);
      expect(await drain.poll(deployment)).toBe(false);
      expect(await second.lifecycle.claim(child.runId, profile.id, owner)).not.toBeNull();
    } finally {
      await drain.release(deployment);
      if (childId) {
        const child = await first.runs.run(profile.id, childId);
        if (child.status === 'queued') await first.lifecycle.claim(childId, profile.id, owner);
        await first.lifecycle.finish(profile.id, childId, owner, 'completed', 'Done');
        await first.lifecycle.releaseExecution(childId, owner);
      }
    }
  });

  it('excludes a same-session successor until terminal cleanup confirms release', async () => {
    const { profile, run, owner } = await queuedRun();
    expect(await first.lifecycle.claim(run.id, profile.id, owner)).not.toBeNull();
    await first.lifecycle.finish(profile.id, run.id, owner, 'completed', 'Done');
    const next = await first.runs.submit(profile.id, run.sessionId, {
      text: 'Next',
      requestKey: randomUUID(),
    });
    const nextOwner = randomUUID();
    try {
      expect(await second.lifecycle.claim(next.id, profile.id, nextOwner)).toBeNull();
      await first.lifecycle.releaseExecution(run.id, randomUUID());
      expect(await second.lifecycle.claim(next.id, profile.id, nextOwner)).toBeNull();
      await first.lifecycle.releaseExecution(run.id, owner);
      expect(await second.lifecycle.claim(next.id, profile.id, nextOwner)).not.toBeNull();
    } finally {
      await first.lifecycle.releaseExecution(run.id, owner);
      const current = await first.runs.run(profile.id, next.id);
      if (current.status === 'queued') await second.lifecycle.claim(next.id, profile.id, nextOwner);
      await second.lifecycle.finish(profile.id, next.id, nextOwner, 'completed', 'Done');
      await second.lifecycle.releaseExecution(next.id, nextOwner);
    }
  });

  it('preserves execution evidence across reset and profile deletion', async () => {
    const { profile, run, owner } = await queuedRun();
    try {
      expect(await first.lifecycle.claim(run.id, profile.id, owner)).not.toBeNull();
      await first.lifecycle.finish(profile.id, run.id, owner, 'completed', 'Done');
      await expect(first.profiles.resetProfile(profile.id)).rejects.toThrow();
      await expect(second.profiles.deleteProfile(profile.id)).rejects.toThrow();
      const [marker] = await first.store.db.select().from(runs).where(eq(runs.id, run.id));
      expect(marker?.executionOwner).toBe(owner);
    } finally {
      await first.lifecycle.releaseExecution(run.id, owner);
    }
  });

  it('does not mistake an expired terminal execution marker for confirmed cleanup', async () => {
    const drain = new DeploymentDrain(second.store);
    const deployment = randomUUID();
    const { profile, run, owner } = await queuedRun();
    try {
      expect(await first.lifecycle.claim(run.id, profile.id, owner)).not.toBeNull();
      await first.lifecycle.finish(profile.id, run.id, owner, 'completed', 'Done');
      // The executor may be paused with live MCP cleanup or effects still in progress.
      await first.store.db
        .update(runs)
        .set({
          executionUntil: sql`clock_timestamp() - interval '1 hour'`,
        })
        .where(eq(runs.id, run.id));
      await drain.request(deployment);
      expect(await drain.poll(deployment)).toBe(false);
    } finally {
      await first.lifecycle.releaseExecution(run.id, owner);
      await drain.release(deployment);
    }
  });
});
