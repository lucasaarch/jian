import { expect, it } from 'vitest';
import { testServices } from './helpers/services.js';

async function profileWith(learnFromWork?: boolean) {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    allowShell: true,
    ...(learnFromWork === undefined ? {} : { learnFromWork }),
  });

  return { services, profile };
}

it('enables learning by default for a new profile', async () => {
  const { services, profile } = await profileWith();

  expect((await services.profiles.profile(profile.id)).learnFromWork).toBe(true);
});

it('keeps learning enabled when a legacy request tries to turn it off', async () => {
  const { services, profile } = await profileWith(false);

  expect((await services.profiles.profile(profile.id)).learnFromWork).toBe(true);
});
