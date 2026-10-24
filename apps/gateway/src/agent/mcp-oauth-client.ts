import type { McpOAuthClient } from './types.js';

/** Install-level GitHub OAuth App for Copilot MCP (and similar) when the AS has no DCR. */
export const JIAN_GITHUB_OAUTH_CLIENT_ID = 'JIAN_GITHUB_OAUTH_CLIENT_ID';
export const JIAN_GITHUB_OAUTH_CLIENT_SECRET = 'JIAN_GITHUB_OAUTH_CLIENT_SECRET';

/** Single callback for every MCP OAuth sign-in; the OAuth App registers this one URL. */
export const MCP_OAUTH_CALLBACK_PATH = '/v1/mcp/oauth/callback';

/** Remote GitHub Copilot MCP host — uses the install GitHub OAuth App when set. */
export function isGitHubCopilotMcpUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }

  try {
    return new URL(url).hostname === 'api.githubcopilot.com';
  } catch {
    return false;
  }
}

/**
 * Packs profile and server into the OAuth `state` so the fixed callback can finish the
 * right sign-in. The nonce alone is what the vault stores and verifies.
 */
export function mcpOauthCallbackState(profileId: string, server: string, nonce: string): string {
  return `${profileId}.${server}.${nonce}`;
}

/** Inverse of `mcpOauthCallbackState`. Rejects shapes that cannot be a Jian MCP login. */
export function parseMcpOauthCallbackState(
  state: string,
): { profileId: string; server: string; nonce: string } | undefined {
  const parts = state.split('.');

  if (parts.length !== 3) {
    return undefined;
  }

  const [profileId, server, nonce] = parts;

  if (
    !profileId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profileId) ||
    !server ||
    !/^[a-z0-9_]{1,30}$/.test(server) ||
    !nonce ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nonce)
  ) {
    return undefined;
  }

  return { profileId, server, nonce };
}

/**
 * Static client credentials for an MCP OAuth server.
 *
 * Prefer a client id typed on the server (advanced escape hatch). For GitHub Copilot MCP,
 * fall back to the install-level GitHub OAuth App in the environment so the panel never
 * asks for client id or secret.
 */
export const mcpOauthClient = (
  server: {
    url?: string;
    oauthClientId?: string;
    oauthClientSecret?: { fromEnv?: string };
  },
  env: NodeJS.ProcessEnv = process.env,
): McpOAuthClient | undefined => {
  if (server.oauthClientId) {
    return {
      clientId: server.oauthClientId,
      ...(server.oauthClientSecret?.fromEnv
        ? { secretFromEnv: server.oauthClientSecret.fromEnv }
        : {}),
    };
  }

  if (!isGitHubCopilotMcpUrl(server.url)) {
    return undefined;
  }

  const clientId = env[JIAN_GITHUB_OAUTH_CLIENT_ID]?.trim();

  if (!clientId) {
    return undefined;
  }

  return {
    clientId,
    secretFromEnv: JIAN_GITHUB_OAUTH_CLIENT_SECRET,
  };
};
