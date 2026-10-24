import { randomUUID } from 'node:crypto';
import { professionPreviewSchema } from '@jian/contracts';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { previewProfession } from '../src/professions/classification.js';
import {
  channels,
  events,
  profiles,
  remoteMachines,
  remoteTasks,
  runs,
  schedules,
  sessions,
  subscriptions,
} from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

async function setup() {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Preview',
    instructions: 'Help.',
    mcpServers: [{ name: 'local', transport: 'stdio', command: 'never-executed' }],
    skills: [{ name: 'custom', description: 'Custom guidance', instructions: 'Help.' }],
  });
  const session = await services.sessions.gatewaySession(profile.id);
  return { services, profile, session };
}
const target = { professionId: 'attendant', expectedVersion: 1 };

describe('read-only classification impact preview', () => {
  it('reports configuration impact without changing profiles, revisions, events or authority', async () => {
    const { services, profile } = await setup();
    const before = {
      profile: await services.profiles.profile(profile.id),
      revisions: await services.profiles.revisions(profile.id),
      events: await services.store.db.select().from(events),
    };
    const result = professionPreviewSchema.parse(
      await previewProfession(services, profile.id, target),
    );
    expect(result).toMatchObject({
      profileId: profile.id,
      profileVersion: 1,
      professionId: 'attendant',
      assignable: false,
      blockers: ['unavailable'],
      incompatibleMcpServers: ['local'],
      affected: { customSkills: 1, queuedRuns: 0, runningRuns: 0, waitingRuns: 0 },
    });
    expect(result.configurationCapabilities).not.toContain('process.exec');
    expect(await services.profiles.profile(profile.id)).toEqual(before.profile);
    expect(await services.profiles.revisions(profile.id)).toEqual(before.revisions);
    expect(await services.store.db.select().from(events)).toEqual(before.events);
    expect(await services.store.db.select().from(runs)).toEqual([]);
  });

  it('counts unsettled work and retained automations only for the chosen profile', async () => {
    const { services, profile, session } = await setup();
    const other = await services.profiles.createProfile({ name: 'Other', instructions: 'Help.' });
    const otherSession = await services.sessions.gatewaySession(other.id);
    const db = services.store.db;
    for (const status of ['queued', 'running', 'waiting', 'interrupted'] as const) {
      await db.insert(runs).values({
        id: randomUUID(),
        profileId: profile.id,
        sessionId: session.id,
        profileVersion: 1,
        requestKey: status,
        input: 'Private task content',
        status,
      });
    }
    await db.insert(runs).values({
      id: randomUUID(),
      profileId: other.id,
      sessionId: otherSession.id,
      profileVersion: 1,
      requestKey: 'other',
      input: 'Other private content',
      status: 'running',
    });
    const machineId = randomUUID();
    await db.insert(remoteMachines).values({
      id: machineId,
      name: 'Private machine',
      platform: 'macos',
      tokenHash: 'secret-hash',
      allowedProfileIds: [profile.id],
    });
    await db.insert(remoteTasks).values({
      id: randomUUID(),
      profileId: profile.id,
      machineId,
      status: 'running',
      command: 'Private command',
      timeoutMs: 1000,
    });
    await db.insert(schedules).values({
      id: randomUUID(),
      profileId: profile.id,
      sessionId: session.id,
      name: 'Reminder',
      instruction: 'Private reminder',
      at: new Date(),
      timeZone: 'UTC',
      createdBy: 'owner',
    });
    await db.insert(subscriptions).values({
      id: randomUUID(),
      profileId: profile.id,
      sessionId: session.id,
      name: 'CI',
      instruction: 'Private listener',
      source: 'github',
      filter: {
        owner: 'test',
        repo: 'test',
        events: ['check_suite.completed'],
        pullNumber: 1,
        pollIntervalSeconds: 30,
      },
      createdBy: 'owner',
      secretHash: 'private-subscription-secret',
      expiresAt: new Date(),
    });
    await db.insert(channels).values({
      id: randomUUID(),
      profileId: profile.id,
      type: 'telegram',
      webhookTokenHash: 'private-webhook',
    });
    await db
      .update(sessions)
      .set({
        objective: {
          text: 'Private objective',
          status: 'blocked',
          updatedAt: new Date().toISOString(),
          continuations: 0,
        },
      })
      .where(eq(sessions.id, session.id));
    const result = await previewProfession(services, profile.id, target);
    expect(result.blockers).toEqual(['unavailable', 'unsettled_work']);
    expect(result.affected).toMatchObject({
      queuedRuns: 1,
      runningRuns: 1,
      waitingRuns: 1,
      historicalRunsWithoutAuthority: 1,
      pendingRemoteTasks: 1,
      enabledSchedules: 1,
      enabledSubscriptions: 1,
      liveChannels: 1,
      openObjectives: 1,
      remoteMachines: 1,
    });
    expect(JSON.stringify(result)).not.toMatch(/Private|private|secret-hash/);
    expect((await db.select().from(schedules))[0]?.enabled).toBe(true);
    expect((await db.select().from(subscriptions))[0]?.enabled).toBe(true);
    expect((await db.select().from(remoteTasks))[0]?.status).toBe('running');
    expect((await services.profiles.profile(profile.id)).professionId).toBeNull();
    expect((await db.select().from(runs)).every((run) => run.authority === null)).toBe(true);
  });

  it('rejects stale versions, unknown targets and authority injection', async () => {
    const { services, profile } = await setup();
    await expect(
      previewProfession(services, profile.id, { ...target, expectedVersion: 2 }),
    ).rejects.toMatchObject({ statusCode: 409 });
    for (const input of [
      { ...target, professionId: 'unknown' },
      { ...target, authority: { capabilities: ['process.exec'] } },
      { ...target, assignable: true },
    ])
      await expect(previewProfession(services, profile.id, input)).rejects.toThrow();
    await services.store.db
      .update(profiles)
      .set({ professionId: 'developer' })
      .where(eq(profiles.id, profile.id));
    expect((await previewProfession(services, profile.id, target)).blockers).toEqual([
      'unavailable',
      'already_classified',
    ]);
    expect((await services.profiles.profile(profile.id)).professionId).toBe('developer');
  });

  it('requires owner authentication over HTTP and exposes no classification write', async () => {
    const { services, profile } = await setup();
    const app = createApp({
      ...services,
      token: 'synthetic-preview-owner-token-at-least-32',
      logger: false,
    });
    const url = `/v1/profiles/${profile.id}/profession/preview`;
    try {
      expect((await app.inject({ method: 'POST', url, payload: target })).statusCode).toBe(401);
      const headers = { authorization: 'Bearer synthetic-preview-owner-token-at-least-32' };
      const response = await app.inject({ method: 'POST', url, headers, payload: target });
      expect(response.statusCode).toBe(200);
      expect(response.json().assignable).toBe(false);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/profiles/${profile.id}/profession`,
            headers,
            payload: target,
          })
        ).statusCode,
      ).toBe(404);
      expect((await services.profiles.profile(profile.id)).professionId).toBeNull();
    } finally {
      await app.close();
    }
  });
});
