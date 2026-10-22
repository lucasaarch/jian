import type { McpOAuthClient } from './types.js';

/** Static client credentials from the MCP server config, when the owner typed them. */
export const mcpOauthClient = (server: {
  oauthClientId?: string;
  oauthClientSecret?: { fromEnv?: string };
}): McpOAuthClient | undefined =>
  server.oauthClientId
    ? {
        clientId: server.oauthClientId,
        ...(server.oauthClientSecret?.fromEnv
          ? { secretFromEnv: server.oauthClientSecret.fromEnv }
          : {}),
      }
    : undefined;
