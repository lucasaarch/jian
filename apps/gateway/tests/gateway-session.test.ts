import { GATEWAY_SESSION_CHANNEL } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
import { projectRow } from './helpers/rows.js';
import { testServices } from './helpers/services.js';

async function setup() {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Zero Two',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });

  return { services, profile };
}

const gatewayOf = <T extends { channel: string }>(list: T[]) =>
  list.filter((session) => session.channel === GATEWAY_SESSION_CHANNEL);

describe('Gateway chats', () => {
  it('does not create a conversation when the session list is read', async () => {
    const { services, profile } = await setup();
    expect(gatewayOf(await services.sessions.overview(profile.id))).toHaveLength(0);
  });

  it('cannot be created through the public session input', async () => {
    const { services, profile } = await setup();

    await expect(
      services.sessions.createSession(profile.id, { channel: GATEWAY_SESSION_CHANNEL }),
    ).rejects.toThrow();
    expect(gatewayOf(await services.sessions.overview(profile.id))).toHaveLength(0);
  });

  it('creates distinct owner chats without a default conversation', async () => {
    const { services, profile } = await setup();
    const project = await projectRow(services.store, profile.id, 'git@github.com:example/jian.git');
    const first = await services.sessions.createGatewaySession(profile.id, {
      projectId: project.id,
    });
    const second = await services.sessions.createGatewaySession(profile.id, {
      projectId: project.id,
    });
    const conversations = gatewayOf(await services.sessions.overview(profile.id));

    expect(first.id).not.toBe(second.id);
    expect(first).toMatchObject({ projectId: project.id, channel: GATEWAY_SESSION_CHANNEL });
    expect(conversations).toHaveLength(2);
  });

  it('rejects linking a Gateway chat to another profile’s project', async () => {
    const { services, profile } = await setup();
    const other = await services.profiles.createProfile({
      name: 'Miku',
      instructions: 'Help.',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    });
    const project = await projectRow(
      services.store,
      other.id,
      'https://github.com/example/private.git',
    );

    await expect(
      services.sessions.createGatewaySession(profile.id, { projectId: project.id }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('deletes any idle Gateway chat', async () => {
    const { services, profile } = await setup();
    const primary = await services.sessions.createGatewaySession(profile.id, {});
    const extra = await services.sessions.createGatewaySession(profile.id, {});

    await expect(services.sessions.deleteSession(profile.id, primary.id)).resolves.toMatchObject({
      id: primary.id,
    });
    await expect(services.sessions.session(profile.id, primary.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(gatewayOf(await services.sessions.overview(profile.id)).map((item) => item.id)).toEqual([
      extra.id,
    ]);
  });

  it('keeps a conversation while it has an active run', async () => {
    const { services, profile } = await setup();
    const session = await services.sessions.createGatewaySession(profile.id, {});
    await services.runs.submit(profile.id, session.id, {
      text: 'Continue working.',
      requestKey: 'active-run',
    });

    await expect(services.sessions.deleteSession(profile.id, session.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(services.sessions.session(profile.id, session.id)).resolves.toMatchObject({
      id: session.id,
    });
  });

  it('gives a project chat its repository and its own checkout path in agent context', async () => {
    const { services, profile } = await setup();
    const project = await projectRow(
      services.store,
      profile.id,
      'https://github.com/example/jian.git',
    );
    const session = await services.sessions.createGatewaySession(profile.id, {
      projectId: project.id,
    });
    const run = await services.runs.submit(profile.id, session.id, {
      text: 'Inspect this project.',
      requestKey: 'project-context',
    });
    const context = await services.contexts.context(run, []);

    expect(context.system).toContain(project.repositoryUrl);
    expect(context.system).toContain(`/projects/${project.id}`);
    expect(context.system).toContain(`/sessions/${session.id}`);
    expect(context.system).toContain('clone this repository');
  });

  it('does not recreate a Gateway chat after a reset clears the conversations', async () => {
    const { services, profile } = await setup();
    await services.sessions.createGatewaySession(profile.id, {});

    await services.profiles.resetProfile(profile.id);
    expect(gatewayOf(await services.sessions.overview(profile.id))).toHaveLength(0);
  });

  it('keeps each chat within its own profile', async () => {
    const { services, profile } = await setup();
    const other = await services.profiles.createProfile({
      name: 'Miku',
      instructions: 'Help.',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    });

    const mine = await services.sessions.createGatewaySession(profile.id, {});
    const theirs = await services.sessions.createGatewaySession(other.id, {});

    expect(mine.id).not.toBe(theirs.id);
    await expect(services.sessions.session(other.id, mine.id)).rejects.toThrow();
  });
});
