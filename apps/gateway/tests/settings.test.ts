import { expect, it } from 'vitest';
import { Settings } from '../src/settings/service.js';
import { testServices } from './helpers/services.js';

it('prefers the configured zone without discarding a saved zone needed for rollback', async () => {
  const services = await testServices(undefined, undefined, 'Asia/Tokyo');
  await services.settings.update({ timeZone: 'America/Sao_Paulo' });

  expect(await services.settings.read()).toEqual({
    timeZone: 'Asia/Tokyo',
    timeZoneSource: 'setting',
  });
  expect(await new Settings(services.store).timeZone()).toBe('America/Sao_Paulo');
});

it('keeps the protection the last new chat started with, apart from the time zone', async () => {
  const services = await testServices();
  const zone = (await services.settings.read()).timeZone;
  expect((await services.settings.read()).newChatProtection).toBeUndefined();

  await services.settings.update({ newChatProtection: 'full' });

  expect(await services.settings.read()).toMatchObject({
    newChatProtection: 'full',
    timeZone: zone,
  });
  await expect(services.settings.update({ newChatProtection: 'anything' })).rejects.toThrow();
  await services.settings.update({ timeZone: 'America/Sao_Paulo' });
  expect(await services.settings.read()).toMatchObject({
    newChatProtection: 'full',
    timeZone: 'America/Sao_Paulo',
  });
});
