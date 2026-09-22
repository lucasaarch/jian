import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProviderCredential } from '@jian/contracts';

/**
 * A Claude subscription credential, issued by `claude setup-token`. It is not an API key: sent
 * as one it answers 401, and sent as a bare bearer it answers 429. Anthropic accepts it only
 * from something presenting itself as Claude Code, which is what the headers below do.
 */
const OAUTH_PREFIX = 'sk-ant-oat';

export const isSubscriptionToken = (secret: string | undefined): boolean =>
  typeof secret === 'string' && secret.startsWith(OAUTH_PREFIX);

const KEY_PREFIX = 'sk-ant-api';

/**
 * Which of the two Anthropic credentials this is, in the order the answers can be trusted:
 * what the owner declared when saving it, then the prefix the credential itself carries, then
 * the name of the variable it came from — `ANTHROPIC_API_TOKEN` exists to hold the bearer one.
 * Guessing wrong costs a 401 on every run, so nothing further is inferred.
 */
export function anthropicCredential(
  declared: ProviderCredential | undefined,
  apiKeyEnv: string | undefined,
  secret: string | undefined,
): ProviderCredential {
  if (declared) {
    return declared;
  }

  if (isSubscriptionToken(secret)) {
    return 'subscription';
  }

  if (secret?.startsWith(KEY_PREFIX)) {
    return 'key';
  }

  return apiKeyEnv === 'ANTHROPIC_API_TOKEN' ? 'subscription' : 'key';
}

/** Claude Code's own betas. Without them the request is refused however valid the token is. */
const BETAS = 'claude-code-20250219,oauth-2025-04-20';

/**
 * Anthropic refuses a subscription request whose client version is far behind the release, so
 * the installed CLI is asked once and this is only the answer for a host without it — a
 * container, most of the time. Raise it when refusals start mentioning the version.
 */
const FALLBACK_VERSION = '2.1.278';

const run = promisify(execFile);

let detected: Promise<string> | undefined;

async function claudeCodeVersion(): Promise<string> {
  detected ??= run('claude', ['--version'], { timeout: 5000 })
    .then(({ stdout }) => {
      const version = stdout.trim().split(/\s+/)[0];

      return version && /^\d/.test(version) ? version : FALLBACK_VERSION;
    })
    .catch(() => FALLBACK_VERSION);

  return detected;
}

export const subscriptionHeaders = (): Record<string, string> => ({ 'anthropic-beta': BETAS });

/**
 * Two things Anthropic checks that neither the provider options nor the prompt can express,
 * so they are applied to the request itself:
 *
 * The model SDK writes its own user-agent over whatever the provider was configured with, and
 * Anthropic reads that header to decide the caller is Claude Code.
 *
 * And the first system block has to be the identity line *alone*. Measured: identity by itself
 * answers 200, the same text with the profile's instructions appended to that one block
 * answers 429, and identity plus instructions as two blocks answers 200. The SDK sends one
 * block, so the split happens here.
 */
export async function subscriptionFetch(
  fetcher: typeof globalThis.fetch,
): Promise<typeof globalThis.fetch> {
  const agent = `claude-cli/${await claudeCodeVersion()} (external, cli)`;

  return async (input, init) => {
    const headers = new Headers(init?.headers);

    headers.set('user-agent', agent);

    return fetcher(input, { ...init, headers, body: splitSystem(init?.body) });
  };
}

function splitSystem(body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (typeof body !== 'string') {
    return body;
  }

  try {
    const payload = JSON.parse(body) as { system?: unknown };
    const system = payload.system;
    const text =
      typeof system === 'string'
        ? system
        : Array.isArray(system) && system.length === 1
          ? ((system[0] as { text?: unknown }).text as string | undefined)
          : undefined;

    if (typeof text !== 'string' || !text.startsWith(CLAUDE_CODE_IDENTITY)) {
      return body;
    }

    const rest = text.slice(CLAUDE_CODE_IDENTITY.length).trim();

    return JSON.stringify({
      ...payload,
      system: [
        { type: 'text', text: CLAUDE_CODE_IDENTITY },
        ...(rest ? [{ type: 'text', text: rest }] : []),
      ],
    });
  } catch {
    return body;
  }
}

/**
 * Anthropic checks that the caller is Claude Code, and the system prompt is part of that check.
 * It is prepended, never substituted: the profile's own instructions follow it untouched.
 */
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

export function withClaudeCodeIdentity(system: string): string {
  return system.startsWith(CLAUDE_CODE_IDENTITY) ? system : `${CLAUDE_CODE_IDENTITY}\n\n${system}`;
}
