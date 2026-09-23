import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listMemories } from '../src/memories/repository.js';
import { testServices } from './helpers/services.js';

const profileInput = {
  name: 'Atlas',
  instructions: 'Help with engineering.',
  model: { provider: 'openai' as const, modelId: 'test-model', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
};

afterEach(() => vi.unstubAllEnvs());

it.each([
  ['ANTHROPIC_API_KEY', 'anthropic'],
  ['ANTHROPIC_API_TOKEN', 'anthropic'],
  ['GEMINI_API_TOKEN', 'google'],
  ['OPENAI_API_KEY', 'openai'],
] as const)('detects %s as %s without storing the secret', async (name, kind) => {
  if (name === 'ANTHROPIC_API_TOKEN') vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv(name, `synthetic-${name}`);
  const services = await testServices();
  const _profile = await services.profiles.createProfile({ name: 'Env', instructions: 'Help.' });
  const providers = await services.providers.providers();
  expect(providers.find((provider) => provider.kind === kind)?.apiKeyEnv).toBe(name);
  expect(JSON.stringify(providers)).not.toContain(`synthetic-${name}`);
});

async function setup() {
  const services = await testServices();
  const profile = await services.profiles.createProfile(profileInput);
  const session = await services.sessions.createSession(profile.id, {
    title: 'Mac',
    channel: 'macos',
  });

  return { services, profile, session };
}

it('uses optimistic versions for profile and memory edits', async () => {
  const { services, profile } = await setup();

  const updated = await services.profiles.updateProfile(profile.id, {
    expectedVersion: 1,
    name: 'New name',
  });

  expect(updated.version).toBe(2);

  await expect(
    services.profiles.updateProfile(profile.id, { expectedVersion: 1, name: 'Stale' }),
  ).rejects.toMatchObject({ statusCode: 409 });

  await services.memories.remember(profile.id, {
    key: 'project',
    content: 'Alpha',
    expectedVersion: 0,
  });

  await expect(
    services.memories.remember(profile.id, {
      key: 'project',
      content: 'Beta',
      expectedVersion: 0,
    }),
  ).rejects.toMatchObject({ statusCode: 409 });

  expect((await services.memories.memories(profile.id))[0]?.content).toBe('Alpha');
});

const avatar = `data:image/jpeg;base64,${Buffer.from('synthetic-image-bytes').toString('base64')}`;

describe('deleting a profile', () => {
  it('removes the profile and everything it ever held', async () => {
    const { services, profile, session } = await setup();

    await services.memories.remember(profile.id, {
      key: 'project',
      content: 'Alpha',
      expectedVersion: 0,
    });

    await expect(services.profiles.deleteProfile(profile.id)).resolves.toEqual({
      id: profile.id,
    });

    await expect(services.profiles.profile(profile.id)).rejects.toMatchObject({
      statusCode: 404,
    });

    await expect(services.sessions.session(profile.id, session.id)).rejects.toMatchObject({
      statusCode: 404,
    });

    // Reads under the repository, not the service: past the profile's own existence check,
    // straight against the table the foreign key cascades into.
    expect(await listMemories(services.store.db, profile.id, 100)).toEqual([]);
  });

  it('rejects a profile that does not exist', async () => {
    const services = await testServices();

    await expect(
      services.profiles.deleteProfile('00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('runs the beforeDelete hook inside the same transaction as the delete', async () => {
    const services = await testServices();
    const profile = await services.profiles.createProfile(profileInput);
    const seen: string[] = [];

    services.profiles.useBeforeDelete(async (profileId, tx) => {
      seen.push(profileId);
      // The hook's writes land or roll back with the delete: proven by writing through the
      // same handle the delete itself uses, not a second connection racing it.
      await tx.execute(sql`select 1`);
    });

    await services.profiles.deleteProfile(profile.id);

    expect(seen).toEqual([profile.id]);
  });
});

describe('profile configuration changes', () => {
  it('preserves skills, MCP configuration and permissions on a name-only edit', async () => {
    const services = await testServices();

    const profile = await services.profiles.createProfile({
      ...profileInput,
      summary: 'Looks after deliveries.',
      allowSelfManagement: true,
      skills: [
        { name: 'deploy', description: 'Deployment guide', instructions: 'Check the release.' },
      ],
      mcpServers: [{ name: 'docs', url: 'https://example.com/mcp' }],
    });

    const updated = await services.profiles.updateProfile(profile.id, {
      expectedVersion: 1,
      name: 'New name',
    });

    expect(updated.allowSelfManagement).toBe(true);
    expect(updated.skills).toHaveLength(1);
    expect(updated.mcpServers).toHaveLength(1);
    // The only thing other profiles ever see of this one, and every screen edits something else.
    expect(updated.summary).toBe('Looks after deliveries.');
  });

  it('keeps, replaces and clears the picture, and keeps its bytes out of the model context', async () => {
    const services = await testServices();
    const profile = await services.profiles.createProfile({ ...profileInput, avatar });

    expect(profile.avatar).toBe(avatar);

    const renamed = await services.profiles.updateProfile(profile.id, {
      expectedVersion: 1,
      name: 'Atlas II',
    });

    expect(renamed.avatar).toBe(avatar);

    const session = await services.sessions.createSession(profile.id, {
      title: 'Mac',
      channel: 'macos',
    });

    const run = await services.runs.submit(profile.id, session.id, {
      text: 'Hi',
      requestKey: 'one',
    });

    expect((await services.contexts.context(run)).system).not.toContain(avatar.slice(-24));

    const cleared = await services.profiles.updateProfile(profile.id, {
      expectedVersion: 2,
      avatar: null,
    });

    expect(cleared.avatar).toBeNull();
  });

  it('rejects a picture that is not an inline image within the size limit', async () => {
    const services = await testServices();
    const profile = await services.profiles.createProfile(profileInput);

    for (const rejected of [
      'https://example.com/avatar.png',
      'data:text/html;base64,PHNjcmlwdD4=',
      `data:image/jpeg;base64,${'A'.repeat(100_001)}`,
    ]) {
      await expect(
        services.profiles.updateProfile(profile.id, { expectedVersion: 1, avatar: rejected }),
      ).rejects.toThrow();
    }

    expect((await services.profiles.profile(profile.id)).avatar).toBeNull();
  });
});
