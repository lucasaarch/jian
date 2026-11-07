import type { ModelConfig, ReasoningEffort } from '@jian/contracts';
import type { JSONValue } from 'ai';

/**
 * How much of the run's output allowance each effort level may spend on thinking. Anthropic
 * and Gemini take a token budget rather than a word, and that budget is drawn from the same
 * output ceiling as the answer: a fixed number would either starve the reply or exceed
 * `max_tokens` and be rejected by the provider.
 */
const share: Record<Exclude<ReasoningEffort, 'none'>, number> = {
  minimal: 0.15,
  low: 0.3,
  medium: 0.5,
  high: 0.8,
  xhigh: 0.9,
  max: 0.95,
};

/** Anthropic rejects a thinking budget below 1024, and it must stay under `max_tokens`. */
const minimumBudget = 1024;

function budget(effort: ReasoningEffort, maxOutputTokens: number): number | null {
  if (effort === 'none') return 0;

  const ceiling = maxOutputTokens - 256;

  if (ceiling < minimumBudget) return null;

  return Math.min(ceiling, Math.max(minimumBudget, Math.floor(maxOutputTokens * share[effort])));
}

/**
 * From Claude 4.6 the model decides how long to think and a request carrying a token budget is
 * refused outright. The version is read from the id because no listing reports it: a one or
 * two digit part after the major is the minor, and a longer one is a release date.
 */
export function takesAdaptiveThinking(modelId: string): boolean {
  const match = /claude-(?:opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(modelId);

  if (!match) {
    return false;
  }

  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);

  return major > 4 || (major === 4 && minor >= 6);
}

/**
 * The Claude models that take an effort for one reply from a mid-conversation system message:
 * Opus 5 and newer, Fable and Mythos 5.1 and newer, Sonnet and Haiku 5.5 and newer. Not Opus
 * 4.8, Sonnet 5 or anything 4.x. Read from the id as `takesAdaptiveThinking` does.
 */
export function takesMessageEffort(provider: string, modelId: string): boolean {
  if (provider !== 'anthropic') return false;
  const match = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(modelId);
  if (!match) return false;
  const version = Number(match[2]) + Number(match[3] ?? 0) / 10;
  const from: Record<string, number> = {
    opus: 5,
    fable: 5.1,
    mythos: 5.1,
    sonnet: 5.5,
    haiku: 5.5,
  };
  return version >= (from[match[1] as string] ?? Number.POSITIVE_INFINITY);
}

/**
 * The effort for a turn judged light: `low` in place of anything above it, never higher than
 * the owner's pick and never switched off — a model the owner set to think still thinks, and
 * `low` is a level every provider that offers `medium` or `high` also offers.
 */
export function lightEffort(config: ModelConfig): ModelConfig {
  return config.reasoningEffort === 'medium' ||
    config.reasoningEffort === 'high' ||
    config.reasoningEffort === 'xhigh' ||
    config.reasoningEffort === 'max'
    ? { ...config, reasoningEffort: 'low' }
    : config;
}

/**
 * The least thinking the run's model takes, for side work that only writes: an approval card,
 * a guardrail verdict, a compaction summary. A model that thinks by default and cannot be told
 * not to (Claude Opus 5.5 among them) otherwise spends the small output allowance of that work
 * on thinking and is cut off before it writes the answer.
 */
export function leastReasoningOptions(
  config: ModelConfig,
): Record<string, Record<string, JSONValue>> | undefined {
  if (config.provider === 'anthropic' && takesAdaptiveThinking(config.modelId)) {
    return { anthropic: { effort: 'low' } };
  }
  if (
    (config.provider === 'openai' || config.provider === 'openai-codex') &&
    config.reasoningEffort
  ) {
    return { openai: { reasoningEffort: 'low' } };
  }

  return undefined;
}

/**
 * Translates the stored effort into each provider's own dialect. Returns undefined when there
 * is nothing to say, so a model without reasoning is called exactly as before.
 */
export function reasoningProviderOptions(
  config: ModelConfig,
  maxOutputTokens: number,
): Record<string, Record<string, JSONValue>> | undefined {
  const effort = config.reasoningEffort;

  if (!effort) return undefined;

  switch (config.provider) {
    case 'openai':
    case 'openai-codex':
      return { openai: { reasoningEffort: effort } };
    case 'anthropic': {
      if (takesAdaptiveThinking(config.modelId)) {
        // The model picks how long to think, and `effort` is what bounds it. Sending only
        // `adaptive` left every level at the model's default, so Low and Medium spent as High.
        // Anthropic has no `minimal`; `low` is its least.
        return effort === 'none'
          ? { anthropic: { thinking: { type: 'disabled' } } }
          : {
              anthropic: {
                thinking: { type: 'adaptive' },
                effort: effort === 'minimal' ? 'low' : effort,
              },
            };
      }

      const tokens = budget(effort, maxOutputTokens);

      if (tokens === null) return undefined;

      return {
        anthropic: {
          thinking: tokens === 0 ? { type: 'disabled' } : { type: 'enabled', budgetTokens: tokens },
        },
      };
    }
    case 'google': {
      const tokens = budget(effort, maxOutputTokens);

      if (tokens === null) return undefined;

      return { google: { thinkingConfig: { thinkingBudget: tokens, includeThoughts: false } } };
    }
    default:
      // A compatible endpoint is whatever the owner pointed it at; guessing its dialect would
      // turn a supported model into a rejected request.
      return undefined;
  }
}
