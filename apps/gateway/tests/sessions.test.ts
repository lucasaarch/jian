import { describe, expect, it } from 'vitest';
import { testServices } from './helpers/services.js';

const profileInput = {
  name: 'Atlas',
  instructions: 'Help with engineering.',
  model: { provider: 'openai' as const, modelId: 'test-model', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
};

async function setup() {
  const services = await testServices();
  const profile = await services.profiles.createProfile(profileInput);
  const session = await services.sessions.createSession(profile.id, {
    title: 'Mac',
    channel: 'macos',
  });

  return { services, profile, session };
}

it('makes one session’s memory visible to another while isolating other profiles', async () => {
  const { services, profile, session } = await setup();

  const otherSession = await services.sessions.createSession(profile.id, {
    title: 'Telegram',
    channel: 'telegram',
  });

  const otherProfile = await services.profiles.createProfile({ ...profileInput, name: 'Private' });

  await services.memories.remember(
    profile.id,
    { key: 'deployment', content: 'Deploy release at 21:00.', expectedVersion: 0 },
    session.id,
  );

  const run = await services.runs.submit(profile.id, otherSession.id, {
    text: 'What time is deployment?',
    requestKey: 'req-1',
  });

  const context = await services.contexts.context(run);

  expect(context.system).toContain('Deploy release at 21:00.');
  expect(await services.memories.memories(otherProfile.id)).toEqual([]);

  await expect(services.sessions.messages(otherProfile.id, session.id)).rejects.toMatchObject({
    statusCode: 404,
  });
});

it('allows parallel sessions and exposes their actual activity', async () => {
  const { services, profile, session } = await setup();
  const other = await services.sessions.createSession(profile.id, {
    title: 'Other',
    channel: 'api',
  });

  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Deploy version 2',
    requestKey: 'a',
  });

  await services.lifecycle.claim(run.id, profile.id, 'worker-a');

  const otherRun = await services.runs.submit(profile.id, other.id, {
    text: 'What is happening?',
    requestKey: 'b',
  });

  expect((await services.contexts.context(otherRun)).system).toContain('Deploy version 2');

  expect((await services.runs.activities(profile.id)).map((r) => r.status)).toEqual(
    expect.arrayContaining(['running', 'queued']),
  );
});

describe('naming a conversation', () => {
  it('opens without a name, takes the one the agent writes, and keeps a rename', async () => {
    const services = await testServices();
    const profile = await services.profiles.createProfile({ name: 'Atlas', instructions: 'Help.' });

    const session = await services.sessions.createSession(profile.id, { channel: 'web' });

    expect(session.title).toBeNull();

    await services.sessions.nameIfUnnamed(profile.id, session.id, 'Plano de migração');

    expect((await services.sessions.session(profile.id, session.id)).title).toBe(
      'Plano de migração',
    );

    // The agent names once; a second answer never renames what is already named.
    await services.sessions.nameIfUnnamed(profile.id, session.id, 'Outro assunto');

    expect((await services.sessions.session(profile.id, session.id)).title).toBe(
      'Plano de migração',
    );

    const renamed = await services.sessions.renameSession(profile.id, session.id, {
      title: 'Migração do banco',
    });

    expect(renamed.title).toBe('Migração do banco');
  });

  it('refuses to rename a session of another profile', async () => {
    const services = await testServices();
    const mine = await services.profiles.createProfile({ name: 'Mine', instructions: 'Help.' });
    const other = await services.profiles.createProfile({ name: 'Other', instructions: 'Help.' });
    const session = await services.sessions.createSession(mine.id, { channel: 'web' });

    await expect(
      services.sessions.renameSession(other.id, session.id, { title: 'Roubada' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the conversation list', () => {
  it('shows each session with its last message on one line, most recent first', async () => {
    const services = await testServices();
    const profile = await services.profiles.createProfile({
      name: 'Zero Two',
      instructions: 'Help.',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    });
    const older = await services.sessions.createSession(profile.id, { title: 'Older' });
    const newer = await services.sessions.createSession(profile.id, { title: 'Newer' });
    const quiet = await services.sessions.createSession(profile.id, { title: 'Quiet' });
    const say = async (sessionId: string, text: string, key: string) => {
      const run = await services.runs.submit(profile.id, sessionId, { text, requestKey: key });

      await services.lifecycle.claim(run.id, profile.id, 'worker');
      await services.lifecycle.finish(profile.id, run.id, 'worker', 'completed', 'Ok.');
    };

    await say(newer.id, 'first', 'a');
    await say(older.id, 'Line one\nline two', 'b');

    const list = await services.sessions.overview(profile.id);

    expect(list.map((session) => session.title)).toEqual(['Older', 'Newer', 'Quiet']);
    expect(list[0]).toMatchObject({ lastMessage: { role: 'assistant', text: 'Ok.' } });
    expect(list.find((session) => session.id === quiet.id)).not.toHaveProperty('lastMessage');
  });
});
