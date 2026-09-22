import type { OAuthClientProvider } from '@ai-sdk/mcp';
import type { ModelConfig, Run } from '@jian/contracts';
import type { LanguageModel } from 'ai';
import type { CodexLogin } from '../providers/codex/login.js';
import type { GatewayVault } from '../security/gateway-vault.js';
import type { createSafeFetch } from '../security/outbound.js';
import type { Vault } from '../security/vault.js';

/** One provider per profile and server, built over whatever that sign-in already stored. */
export type McpOAuthProviders = (profileId: string, server: string) => OAuthClientProvider;

export type ModelResolver = (
  config: ModelConfig,
  env?: NodeJS.ProcessEnv,
  fetcher?: typeof globalThis.fetch,
  explicitKey?: string,
) => LanguageModel | Promise<LanguageModel>;

export interface RuntimeOptions {
  /** Per-profile secrets: an MCP token the owner typed for one agent. */
  vault?: Pick<Vault, 'read'>;
  /** What the installation shares: the vendor key behind the model this run uses. */
  gatewayVault?: Pick<GatewayVault, 'read'>;
  /** Hands one MCP server its stored sign-in, so the SDK can refresh and use it. */
  mcpOAuth?: McpOAuthProviders;
  codexLogin?: Pick<CodexLogin, 'accessToken'>;
  outbound?: ReturnType<typeof createSafeFetch>;
  storeArtifact?: (
    run: Run,
    toolName: string,
    output: unknown,
  ) => Promise<{ artifactId: string; bytes: number }>;
}
