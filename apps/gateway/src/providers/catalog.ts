import { createHash } from 'node:crypto';
import type { ProviderRecord } from '@jian/contracts';

/**
 * Names and environment variables only. The models an account can use are asked of the
 * provider (see `discovery.ts`); a list written here would be a guess presented as fact.
 */
export const providerCatalog = {
  anthropic: {
    name: 'Anthropic',
    env: ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_TOKEN'],
  },
  google: {
    name: 'Gemini',
    env: ['GEMINI_API_TOKEN'],
  },
  openai: {
    name: 'OpenAI',
    env: ['OPENAI_API_KEY'],
  },
  // One key for every model the router carries, and the only listing that reports a model's
  // window, output ceiling, modalities and whether it takes an effort — so nothing about an
  // OpenRouter model is guessed here.
  openrouter: {
    name: 'OpenRouter',
    env: ['OPENROUTER_API_KEY'],
  },
  // Fast Whisper transcription with a free tier, behind the OpenAI API at Groq's address.
  groq: {
    name: 'Groq',
    env: ['GROQ_API_KEY'],
  },
  // A server the owner points at — a local Whisper, for one. It has an address, not a vendor,
  // so the environment has no key to offer for it.
  'openai-compatible': {
    name: 'OpenAI-compatible server',
    env: [],
  },
} as const;

/** Where the OpenAI API of a vendor that speaks it lives. */
export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

export type ProviderKind = keyof typeof providerCatalog;

export const providerKinds = Object.keys(providerCatalog) as ProviderKind[];

export function providerEnvironment(kind: ProviderKind, env: NodeJS.ProcessEnv = process.env) {
  return providerCatalog[kind].env.find((name) => !!env[name]?.trim());
}

/**
 * A vendor the host environment already has a key for, offered as a provider nobody had to
 * configure. Its id is derived from the vendor, so it is the same across restarts and can be
 * stored as a model default like any other.
 */
export function environmentProvider(
  kind: ProviderKind,
  env: NodeJS.ProcessEnv = process.env,
): ProviderRecord | null {
  const apiKeyEnv = providerEnvironment(kind, env);
  if (!apiKeyEnv) return null;

  const hash = createHash('sha256').update(`gateway:${kind}`).digest('hex');
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;

  return {
    id,
    name: providerCatalog[kind].name,
    kind,
    apiKeyEnv,
    createdAt: new Date(0).toISOString(),
  };
}
