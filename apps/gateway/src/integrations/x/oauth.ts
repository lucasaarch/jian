import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { isLoopbackAddress } from '../../security/outbound.js';
import { X_SCOPES } from './catalog/index.js';

// As read from https://api.x.com/.well-known/oauth-authorization-server.
const AUTHORIZE = 'https://x.com/i/oauth2/authorize';
export const X_API = 'https://api.x.com';
const TOKEN = `${X_API}/2/oauth2/token`;

/** How long the owner has to come back from X's page, in milliseconds. */
export const STATE_LIFETIME_MS = 10 * 60_000;
/** Bounded because a refresh runs with the account's lock held. */
const TOKEN_TIMEOUT_MS = 20_000;

export type XApp = { clientId: string; clientSecret: string };

export type XTokenSet = {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scopes: string[];
};

const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
});

/**
 * Where X sends the owner back, or nothing when this gateway has no address X would accept. X asks
 * for https, and for `http://127.0.0.1` in local development and not `localhost`, so plain http is
 * allowed for a loopback address alone: the desktop's own gateway, opened by a browser on the same
 * computer. Anything else on http would carry the code in the clear.
 */
export function xCallbackUrl(publicUrl: string | undefined): string | undefined {
  if (!publicUrl) return undefined;

  const { protocol, hostname } = new URL(publicUrl);
  const host = hostname.replace(/^\[|\]$/g, '');
  const accepted =
    protocol === 'https:' || (protocol === 'http:' && isIP(host) > 0 && isLoopbackAddress(host));

  return accepted ? new URL('/v1/integrations/x/callback', publicUrl).toString() : undefined;
}

export const stateHash = (state: string) => createHash('sha256').update(state).digest('hex');

/** A random state and PKCE verifier, with the S256 challenge of the verifier. */
export function newChallenge() {
  const verifier = randomBytes(48).toString('base64url');

  return {
    state: randomBytes(32).toString('base64url'),
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  };
}

export function authorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: X_SCOPES.join(' '),
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
  });

  // X's examples separate scopes with %20; URLSearchParams would write `+`.
  return `${AUTHORIZE}?${query.toString().replaceAll('+', '%20')}`;
}

/** Why a call to X's token endpoint did not give tokens. */
export type TokenOutcome =
  | { kind: 'ok'; tokens: XTokenSet }
  /** X answered and said no: the grant or the app's credentials are no good. */
  | { kind: 'refused'; status: number }
  /** No usable answer: nothing is known about the grant, so it is not given up on. */
  | { kind: 'unavailable' };

/** Exchanges a code or a refresh token, signing with the app's secret over HTTP Basic. */
export async function requestTokens(
  fetcher: typeof fetch,
  app: XApp,
  grant: Record<string, string>,
  now: number,
  /** Kept when X leaves `scope` out of a refresh, which the standard allows. */
  scopes: readonly string[] = X_SCOPES,
): Promise<TokenOutcome> {
  let response: Response;

  try {
    response = await fetcher(TOKEN, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(grant).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'unavailable' };
  }

  if (response.status === 400 || response.status === 401 || response.status === 403) {
    return { kind: 'refused', status: response.status };
  }
  if (!response.ok) {
    return { kind: 'unavailable' };
  }

  const parsed = tokenResponse.safeParse(await response.json().catch(() => undefined));

  if (!parsed.success) {
    return { kind: 'unavailable' };
  }

  return {
    kind: 'ok',
    tokens: {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      expiresAt: now + parsed.data.expires_in * 1000,
      scopes: parsed.data.scope?.split(' ').filter(Boolean) ?? [...scopes],
    },
  };
}
