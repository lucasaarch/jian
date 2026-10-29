import type { ModelConfig } from '@jian/contracts';
import type { JSONValue } from 'ai';
import type { ProviderKind } from './catalog.js';

/**
 * Which models run faster for a premium, and how each vendor is asked to.
 *
 * Anthropic serves fast mode on Opus 5.5, Opus 5 and Opus 4.8 only (a research preview on its
 * own API; the SDK adds the beta header). OpenAI calls it the priority tier, which it also names
 * `fast`; its GPT models take it, through an API key or a ChatGPT login alike. Anything else is
 * never sent the option: a vendor that does not know it refuses the whole request.
 */
const ANTHROPIC_FAST = /^claude-opus-(?:5-5|5|4-8)(?:-\d{8})?$/;
const OPENAI_FAST = /^gpt-/;

export function takesFast(kind: ProviderKind | string, modelId: string): boolean {
  if (kind === 'anthropic') return ANTHROPIC_FAST.test(modelId);
  if (kind === 'openai') return OPENAI_FAST.test(modelId);
  return false;
}

/** The fast request in the dialect of the run's provider, when the owner asked for it. */
export function speedProviderOptions(
  config: ModelConfig,
): Record<string, Record<string, JSONValue>> | undefined {
  if (!config.fast) return undefined;

  switch (config.provider) {
    case 'anthropic':
      return { anthropic: { speed: 'fast' } };
    case 'openai':
    case 'openai-codex':
      return { openai: { serviceTier: 'priority' } };
    default:
      return undefined;
  }
}

/** Two sets of provider options as one, each vendor's keys kept side by side. */
export function mergeProviderOptions(
  ...sets: Array<Record<string, Record<string, JSONValue>> | undefined>
): Record<string, Record<string, JSONValue>> | undefined {
  const merged: Record<string, Record<string, JSONValue>> = {};

  for (const set of sets) {
    for (const [vendor, options] of Object.entries(set ?? {})) {
      merged[vendor] = { ...merged[vendor], ...options };
    }
  }

  return Object.keys(merged).length ? merged : undefined;
}
