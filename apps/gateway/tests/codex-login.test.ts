import { afterEach, expect, it, vi } from 'vitest';
import { CodexLogin } from '../src/providers/codex/login.js';
import { providerSecret } from '../src/providers/service.js';
import { testServices } from './helpers/services.js';

afterEach(() => vi.useRealTimers());

it('connects ChatGPT through device login without exposing tokens', async () => {
  vi.useFakeTimers();
  const services = await testServices();
  const profile = await services.profiles.createProfile({ name: 'OAuth', instructions: 'Help.' });
  const token = `a.${Buffer.from(JSON.stringify({ exp: 4_000_000_000 })).toString('base64url')}.b`;
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith('/deviceauth/usercode')) {
      return Response.json({ user_code: 'ABCD-1234', device_auth_id: 'device-1', interval: 3 });
    }
    if (url.endsWith('/deviceauth/token')) {
      return Response.json({ authorization_code: 'code', code_verifier: 'verifier' });
    }
    return Response.json({ access_token: token, refresh_token: 'synthetic-refresh' });
  });
  const login = new CodexLogin(services, services.gatewayVault, fetcher);

  const [first, second] = await Promise.all([login.start(), login.start()]);
  expect(first).toMatchObject({ status: 'pending', userCode: 'ABCD-1234' });
  expect(second).toEqual(first);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3000);
  expect(await login.status()).toEqual({ status: 'connected' });
  const provider = (await services.providers.providers()).find((item) => item.authMode === 'codex');
  expect(provider?.id).toBeDefined();
  expect(JSON.stringify(provider)).not.toContain('synthetic-refresh');
  expect(await login.accessToken(provider?.id ?? '')).toBe(token);
  const session = await services.sessions.createSession(profile.id, { title: 'ChatGPT' });
  await services.providers.setModelDefaults({
    conversation: { providerId: provider?.id ?? '', modelId: 'gpt-5.1-codex' },
  });

  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Hello',
    requestKey: 'oauth',
  });
  expect(run.model?.provider).toBe('openai-codex');
});

it('renews a rotating OAuth token once for concurrent runs', async () => {
  const services = await testServices();
  const _profile = await services.profiles.createProfile({
    name: 'Refresh',
    instructions: 'Help.',
  });
  const expired = `a.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.b`;
  const fresh = `a.${Buffer.from(JSON.stringify({ exp: 4_000_000_000 })).toString('base64url')}.b`;
  const provider = await services.providers.configureCodexProvider(
    JSON.stringify({ access_token: expired, refresh_token: 'first-refresh' }),
  );
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ access_token: fresh, refresh_token: 'second-refresh' }),
  );
  const login = new CodexLogin(services, services.gatewayVault, fetcher);

  expect(
    await Promise.all([login.accessToken(provider.id), login.accessToken(provider.id)]),
  ).toEqual([fresh, fresh]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await services.gatewayVault.read(providerSecret(provider.id))).toContain('second-refresh');
});
