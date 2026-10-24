import { randomUUID } from 'node:crypto';
import { submitSchema } from '@jian/contracts';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import { currentRunAuthority } from '../src/professions/effective.js';
import { profiles, runs, sessions } from '../src/storage/schema.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

async function setup(classify = true) {
  const services = await testServices();
  let profile = await services.profiles.createProfile({
    name: 'Durable',
    instructions: 'Help.',
    allowWebSearch: true,
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  if (classify) {
    await services.store.db
      .update(profiles)
      .set({ professionId: 'developer' })
      .where(eq(profiles.id, profile.id));
    // A real new revision freezes the classified identity; old revisions remain legacy.
    profile = await services.profiles.updateProfile(profile.id, {
      expectedVersion: profile.version,
      name: 'Classified',
    });
  }
  const session = await services.sessions.gatewaySession(profile.id);
  return { services, profile, session };
}

const message = (requestKey: string) => ({ text: 'Work', requestKey });

describe('durable profession authority', () => {
  it('persists only server-derived authority and rejects public authority inputs', async () => {
    const { services, profile, session } = await setup();
    expect(
      submitSchema.safeParse({
        ...message('forged'),
        authority: { capabilities: ['process.exec'] },
      }).success,
    ).toBe(false);
    const run = await services.runs.submit(profile.id, session.id, message('owner'), {
      ownerMessage: true,
    });
    expect(run.authority?.professionId).toBe('developer');
    expect((await services.runs.run(profile.id, run.id)).authority).toEqual(run.authority);
    const [row] = await services.store.db
      .select({ authority: runs.authority })
      .from(runs)
      .where(eq(runs.id, run.id));
    expect(row?.authority).toEqual(run.authority);
  });

  it('preserves legacy null behavior, blocks arbitrary background work, and accepts channel messages', async () => {
    const legacySetup = await setup(false);
    const legacy = await legacySetup.services.runs.submit(
      legacySetup.profile.id,
      legacySetup.session.id,
      message('legacy'),
    );
    expect(legacy.authority).toBeUndefined();

    const { services, profile, session } = await setup();
    await expect(services.runs.submit(profile.id, session.id, message('job'))).rejects.toThrow(
      'owner review',
    );
    const channelRun = await services.runs.submit(profile.id, session.id, message('external'), {
      ownerMessage: true,
      activity: 'channel',
    });
    expect(channelRun.authority?.professionId).toBe('developer');
  });

  it('intersects delegated authority with original, frozen and current configuration', async () => {
    const { services, profile, session } = await setup();
    const parent = await services.runs.submit(profile.id, session.id, message('parent'), {
      ownerMessage: true,
    });
    expect(parent.authority?.capabilities).toContain('web.browse');
    await services.profiles.updateProfile(profile.id, {
      expectedVersion: profile.version,
      allowWebSearch: false,
    });
    const target = await services.sessions.createSession(profile.id, { title: 'Child' });
    const child = await services.runs.submit(profile.id, target.id, message('child'), {
      authorityFrom: { profileId: profile.id, runId: parent.id },
    });
    expect(child.authority?.capabilities).toContain('web.browse');
    const current = await services.profiles.profile(profile.id);
    await services.profiles.updateProfile(profile.id, {
      expectedVersion: current.version,
      allowWebSearch: true,
    });
    const live = await services.profiles.profile(profile.id);
    expect(currentRunAuthority(child.profile, live, child.authority)?.capabilities).toContain(
      'web.browse',
    );
  });

  it('fails closed for old classified runs and unsafe durable job creation', async () => {
    const { services, profile, session } = await setup();
    const parent = await services.runs.submit(profile.id, session.id, message('parent'), {
      ownerMessage: true,
    });
    await services.store.db.update(runs).set({ authority: null }).where(eq(runs.id, parent.id));
    const target = await services.sessions.createSession(profile.id, { title: 'Child' });
    await expect(
      services.runs.submit(profile.id, target.id, message('child'), {
        authorityFrom: { profileId: profile.id, runId: parent.id },
      }),
    ).rejects.toThrow('owner review');
    await expect(
      services.schedules.create(
        profile.id,
        {
          name: 'Later',
          instruction: 'Work',
          sessionId: session.id,
          at: '2099-01-01T00:00:00Z',
          timeZone: 'UTC',
        },
        'owner',
      ),
    ).resolves.toMatchObject({ name: 'Later', profileId: profile.id });
    await expect(
      services.subscriptions.create(
        profile.id,
        {
          name: 'CI',
          instruction: 'Work',
          sessionId: session.id,
          source: 'github',
          filter: { owner: 'org', repo: 'repo', events: ['check_suite.completed'] },
        },
        'owner',
      ),
    ).rejects.toThrow('durable origin authority');
  });

  it('continues stopped runs without gaining newly enabled capabilities', async () => {
    const { services, profile, session } = await setup();
    await services.profiles.updateProfile(profile.id, {
      expectedVersion: profile.version,
      allowWebSearch: false,
    });
    const parent = await services.runs.submit(profile.id, session.id, message('parent'), {
      ownerMessage: true,
    });
    await services.store.db
      .update(runs)
      .set({ status: 'interrupted' })
      .where(eq(runs.id, parent.id));
    const current = await services.profiles.profile(profile.id);
    await services.profiles.updateProfile(profile.id, {
      expectedVersion: current.version,
      allowWebSearch: true,
    });
    const child = await services.runs.submit(profile.id, session.id, message('continue'), {
      continuationOf: parent.id,
    });
    expect(child.authority?.capabilities).toContain('web.browse');
    await services.store.db
      .update(runs)
      .set({ status: 'interrupted', authority: null })
      .where(eq(runs.id, child.id));
    await expect(
      services.runs.submit(profile.id, session.id, message('old'), { continuationOf: child.id }),
    ).rejects.toThrow('owner review');
  });

  it.each(['queued', 'running', 'waiting'] as const)(
    'rejects explicit continuation of a narrower run while another run is %s',
    async (status) => {
      const { services, profile, session } = await setup();
      await services.profiles.updateProfile(profile.id, {
        expectedVersion: profile.version,
        allowWebSearch: false,
      });
      const parent = await services.runs.submit(profile.id, session.id, message('parent'), {
        ownerMessage: true,
      });
      expect(parent.authority?.capabilities).toContain('web.browse');
      await services.store.db
        .update(runs)
        .set({ status: 'interrupted' })
        .where(eq(runs.id, parent.id));
      const current = await services.profiles.profile(profile.id);
      await services.profiles.updateProfile(profile.id, {
        expectedVersion: current.version,
        allowWebSearch: true,
      });
      const other = await services.runs.submit(profile.id, session.id, message('other'), {
        ownerMessage: true,
      });
      expect(other.authority?.capabilities).toContain('web.browse');
      await services.store.db
        .update(runs)
        .set({
          status,
          ...(status === 'waiting'
            ? { question: { id: randomUUID(), prompt: 'Proceed?', askedAt: other.createdAt } }
            : {}),
        })
        .where(eq(runs.id, other.id));
      const before = await services.store.db.select().from(runs);
      const messagesBefore = await services.sessions.messages(profile.id, session.id);

      await expect(
        services.runs.continueRun(profile.id, parent.id, {
          text: 'Continue the narrower work',
          requestKey: 'continue',
          reconciliation: 'No external effects completed.',
        }),
      ).rejects.toMatchObject({ statusCode: 409 });

      // No queued continuation, steer, answer, or status/authority mutation of either run.
      expect(await services.store.db.select().from(runs)).toEqual(before);
      expect(await services.sessions.messages(profile.id, session.id)).toEqual(messagesBefore);
    },
  );

  it.each(['api', 'whatsapp'])(
    'keeps the ask/answer authority ceiling for %s sessions',
    async (channel) => {
      const { services, profile } = await setup();
      await services.profiles.updateProfile(profile.id, {
        expectedVersion: profile.version,
        allowWebSearch: false,
      });
      const session = await services.sessions.createSession(profile.id, { channel: 'api' });
      const parent = await services.runs.submit(profile.id, session.id, message('ask'), {
        ownerMessage: true,
      });
      await new AgentRuntime(services, () =>
        mockModel({
          doGenerate: async () => ({
            content: [
              {
                type: 'tool-call',
                toolCallId: 'ask',
                toolName: 'ask_user',
                input: JSON.stringify({ prompt: 'Proceed?' }),
              },
            ],
            finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
            usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 10, text: 10, reasoning: 0 },
            },
            warnings: [],
          }),
        }),
      ).execute(profile.id, parent.id);
      const parked = await services.runs.run(profile.id, parent.id);
      expect(parked.status).toBe('waiting');
      expect(parked.question?.prompt).toBe('Proceed?');
      expect(parked.authority?.capabilities).toContain('web.browse');
      const current = await services.profiles.profile(profile.id);
      await services.profiles.updateProfile(profile.id, {
        expectedVersion: current.version,
        allowWebSearch: true,
      });
      if (channel !== 'api') {
        await services.store.db
          .update(sessions)
          .set({ channel })
          .where(eq(sessions.id, session.id));
      }
      const resume = await services.runs.answerRun(profile.id, parent.id, { text: 'Yes' });
      expect(resume.status).toBe('queued');
      expect(resume.continuationOf).toBe(parent.id);
      expect(resume.input).toContain('Proceed?');
      expect(resume.input).toContain('Yes');
      expect(resume.authority?.professionId).toBe('developer');
      expect(resume.authority?.capabilities).toContain('web.browse');
      expect((await services.runs.run(profile.id, resume.id)).authority).toEqual(resume.authority);
      expect((await services.runs.run(profile.id, parent.id)).status).toBe('completed');
    },
  );

  it('blocks automatic objectives and skips cross-session learning for classified work', async () => {
    const { services, profile, session } = await setup();
    const run = await services.runs.submit(profile.id, session.id, message('parent'), {
      ownerMessage: true,
    });
    await services.sessions.setObjective(profile.id, session.id, {
      text: 'Finish the approved work',
      status: 'open',
    });
    expect(await services.objectives.continueAfter(run)).toBeNull();
    expect((await services.sessions.session(profile.id, session.id)).objective).toMatchObject({
      status: 'blocked',
      note: expect.stringContaining('owner review'),
    });
    expect(
      await services.learning.consider(run, {
        tools: Array.from({ length: 12 }, () => ({ name: 'read_file' })),
        answer: 'Done.',
      }),
    ).toBeUndefined();
  });

  it('requires a shared team and preserves classified authority across peer runs', async () => {
    const { services, profile, session } = await setup();
    const parent = await services.runs.submit(profile.id, session.id, message('parent'), {
      ownerMessage: true,
    });
    let target = await services.profiles.createProfile({
      name: 'Classified peer',
      instructions: 'Help.',
      model: profile.model,
    });
    await services.store.db
      .update(profiles)
      .set({ professionId: 'developer' })
      .where(eq(profiles.id, target.id));
    target = await services.profiles.updateProfile(target.id, {
      expectedVersion: target.version,
      name: 'Classified peer',
    });
    const thread = await services.sessions.createSession(target.id, {});

    await expect(
      services.runs.submit(target.id, thread.id, message('no-team'), {
        authorityFrom: { profileId: profile.id, runId: parent.id },
      }),
    ).rejects.toThrow('share a team');

    await services.teams.create({
      name: 'Shared',
      description: '',
      profileIds: [profile.id, target.id],
    });
    const delegated = await services.runs.submit(target.id, thread.id, message('shared-team'), {
      authorityFrom: { profileId: profile.id, runId: parent.id },
    });
    expect(delegated.authority?.professionId).toBe('developer');
    expect(delegated.authority?.capabilities).toEqual(
      expect.arrayContaining(['peers.call', 'tasks.delegate']),
    );
  });
});
