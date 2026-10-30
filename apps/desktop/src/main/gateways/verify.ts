import { createJianClient } from '@jian/sdk';
import { timedFetch } from './fetch';
import { compatible } from './rules';

/**
 * Before a gateway is saved: it answers, its release works with this app, and the token opens it.
 * Each failure says what the owner can do about it.
 */
export async function verify(
  url: string,
  token: string,
  appVersion: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = createJianClient({ baseUrl: url, token, fetch: timedFetch(10_000) });
  try {
    const health = await client.GET('/health');
    if (!health.data) return { ok: false, error: `${url} answered, but not as a Jian gateway.` };
    if (!compatible(appVersion, health.data.version)) {
      return {
        ok: false,
        error: `This gateway runs ${health.data.version} and the app ${appVersion}; they work together only on the same major.minor release.`,
      };
    }
    const profiles = await client.GET('/v1/profiles');
    if (profiles.response.status === 401)
      return { ok: false, error: 'The gateway refused this token.' };
    if (!profiles.response.ok)
      return { ok: false, error: `The gateway answered ${profiles.response.status}.` };
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: `${url} did not answer. Check the address and that the gateway is running.`,
    };
  }
}
