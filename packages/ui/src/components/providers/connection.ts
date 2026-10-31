import type { NewProvider, Provider, ProviderModelList } from '../../lib/api';
import { date } from '../../lib/format';
import type { providers } from './catalog';

export type ProviderEntry = (typeof providers)[number];

/**
 * What the installation holds for one vendor: a credential of its own, and for OpenAI the
 * ChatGPT sign-in, which is a provider of the same kind beside it. Revoked ones are history.
 */
export function connectionOf(connected: Provider[], kind: string) {
  const live = connected.filter((provider) => provider.kind === kind && !provider.revokedAt);

  return {
    configured: live.find((provider) => provider.authMode !== 'codex'),
    codex: live.find((provider) => provider.authMode === 'codex'),
  };
}

/** What a row says about the credential in place, in one line. */
export function credentialLine(provider: {
  apiKeyEnv?: string;
  authMode?: string;
  credential?: string;
  createdAt: string;
}) {
  if (provider.apiKeyEnv) {
    return `From the environment · ${provider.apiKeyEnv}`;
  }

  if (provider.authMode === 'codex') {
    return 'ChatGPT login';
  }

  const kind = provider.credential === 'subscription' ? 'Subscription token' : 'Key';

  return `${kind} saved on ${date(provider.createdAt)}`;
}

/** Why a provider's model list may be out of date, or nothing while it is current. */
export function staleLine(list: ProviderModelList | undefined) {
  if (!list?.stale) return undefined;

  return `${list.models.length ? `List from ${date(list.fetchedAt)}. ` : ''}${list.reason ?? 'The model list could not be refreshed.'}`;
}

/** What the credential of a vendor is called where it is entered. */
export function secretLabel(entry: ProviderEntry) {
  if (entry.kind === 'openai-compatible') return 'API key (optional)';
  if (entry.kind === 'ollama') return 'Ollama API key (optional)';
  if (entry.kind === 'openai' || entry.kind === 'groq') return 'API key';

  return `${entry.name} credential`;
}

/** What becomes of what is entered: it replaces a key from the host, and is never shown again. */
export function secretHint(entry: ProviderEntry, configured: Provider | undefined) {
  if (configured?.apiKeyEnv) {
    return `Currently ${configured.apiKeyEnv}. What you save here replaces it.`;
  }
  if (entry.kind === 'openai-compatible') {
    return 'Only if your server asks for one. It is never shown again.';
  }
  if (entry.kind === 'ollama') {
    return 'Optional for local Ollama. Used for Ollama Cloud authentication.';
  }

  return 'What you save here is never shown again.';
}

export function addressHint(entry: ProviderEntry) {
  return entry.kind === 'ollama'
    ? 'The Ollama server root, usually http://localhost:11434. A private address must be allowed in JIAN_ALLOW_PRIVATE_ORIGINS.'
    : 'The server API root, through /v1. A private address must be allowed in JIAN_ALLOW_PRIVATE_ORIGINS.';
}

/**
 * The provider to register from what the owner entered, or what is missing. Registering
 * replaces the provider of this vendor, key included; a server of the owner's needs no key.
 */
export function providerRequest(
  entry: ProviderEntry,
  form: { secret: string; baseURL: string; credential: string },
): { error: string } | { input: NewProvider } {
  const secret = form.secret.trim();
  const baseURL = form.baseURL.trim();
  const server = entry.kind === 'openai-compatible' || entry.kind === 'ollama';
  if (!secret && !server) return { error: `Enter the ${entry.name} credential.` };

  return {
    input: {
      name: entry.name,
      kind: entry.kind,
      ...(secret ? { secret } : {}),
      ...(server ? { baseURL } : {}),
      ...(entry.kind === 'anthropic'
        ? { credential: form.credential as 'key' | 'subscription' }
        : {}),
    },
  };
}
