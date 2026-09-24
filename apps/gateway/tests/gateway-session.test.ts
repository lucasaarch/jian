import { GATEWAY_SESSION_CHANNEL } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
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

describe('the gateway conversation', () => {
  it('exists exactly once per profile, however many readers race to open it', async () => {
    const { services, profile } = await setup();

    const opened = await Promise.all([
      services.sessions.gatewaySession(profile.id),
      services.sessions.gatewaySession(profile.id),
      services.sessions.overview(profile.id),
    ]);
    const list = await services.sessions.overview(profile.id);

    expect(gatewayOf(list)).toHaveLength(1);
    expect(opened[0].id).toBe(opened[1].id);
    expect(gatewayOf(list)[0]?.id).toBe(opened[0].id);
  });

  it('cannot be created through the public session input', async () => {
    const { services, profile } = await setup();

    await expect(
      services.sessions.createSession(profile.id, { channel: GATEWAY_SESSION_CHANNEL }),
    ).rejects.toThrow();
    expect(gatewayOf(await services.sessions.overview(profile.id))).toHaveLength(1);
  });

  it('opens again after a reset clears the conversations', async () => {
    const { services, profile } = await setup();
    const before = await services.sessions.gatewaySession(profile.id);

    await services.profiles.resetProfile(profile.id);
    const [after] = gatewayOf(await services.sessions.overview(profile.id));

    expect(after).toBeDefined();
    expect(after?.id).not.toBe(before.id);
  });

  it('is the conversation of its own profile only', async () => {
    const { services, profile } = await setup();
    const other = await services.profiles.createProfile({
      name: 'Miku',
      instructions: 'Help.',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    });

    const mine = await services.sessions.gatewaySession(profile.id);
    const theirs = await services.sessions.gatewaySession(other.id);

    expect(mine.id).not.toBe(theirs.id);
    await expect(services.sessions.session(other.id, mine.id)).rejects.toThrow();
  });
});
