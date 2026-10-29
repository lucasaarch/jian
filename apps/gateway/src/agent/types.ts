import type { OAuthClientProvider } from '@ai-sdk/mcp';
import type { ModelConfig, Run } from '@jian/contracts';
import type { LanguageModel } from 'ai';
import type { GitHubIntegrations } from '../integrations/github.js';
import type { CodexLogin } from '../providers/codex/login.js';
import type { GatewayVault } from '../security/gateway-vault.js';
import type { createSafeFetch } from '../security/outbound.js';

/** Pre-registered OAuth client when the authorization server has no registration endpoint. */
export type McpOAuthClient = {
  clientId: string;
  /** Host env var that holds the client secret, when the owner did not type one into the vault. */
  secretFromEnv?: string;
};

/**
 * One provider per server: a sign-in belongs to the installation, as the server does. A static
 * `oauth` client is used when the authorization server has no dynamic registration endpoint; a
 * typed secret is read from the vault by the provider itself.
 */
export type McpOAuthProviders = (server: string, oauth?: McpOAuthClient) => OAuthClientProvider;

export type ModelResolver = (
  config: ModelConfig,
  env?: NodeJS.ProcessEnv,
  fetcher?: typeof globalThis.fetch,
  explicitKey?: string,
) => LanguageModel | Promise<LanguageModel>;

export interface RuntimeOptions {
  /**
   * What the installation shares: the vendor key behind the model this run uses, and every
   * value typed for an MCP server.
   */
  gatewayVault?: Pick<GatewayVault, 'read'>;
  /** Hands one MCP server its stored sign-in, so the SDK can refresh and use it. */
  mcpOAuth?: McpOAuthProviders;
  /** Issues project-repository-scoped GitHub App tokens for the official MCP server. */
  github?: Pick<GitHubIntegrations, 'mcpAccess'>;
  codexLogin?: Pick<CodexLogin, 'accessToken'>;
  outbound?: ReturnType<typeof createSafeFetch>;
  storeArtifact?: (
    run: Run,
    toolName: string,
    output: unknown,
  ) => Promise<{ artifactId: string; bytes: number }>;
}
