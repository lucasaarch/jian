import { createHash } from 'node:crypto';
import type { JSONValue, ModelMessage, SystemModelMessage } from 'ai';
import { XAI_BASE_URL } from '../providers/catalog.js';
import { CLAUDE_CODE_IDENTITY } from '../providers/claude-subscription.js';

/** OpenAI uses this key to keep unrelated profiles from sharing a prompt-cache partition. */
function openAiPromptCacheOptions(
  profileId: string,
  provider: string,
  modelId: string,
): { openai: { promptCacheKey: string } } | undefined {
  if (provider !== 'openai' && provider !== 'openai-codex') return undefined;

  const promptCacheKey = createHash('sha256')
    .update(`jian:${profileId}:${provider}:${modelId}`)
    .digest('hex')
    .slice(0, 48);

  return { openai: { promptCacheKey } };
}

/**
 * xAI caches a repeated prefix only on the server that saw it, and routes by this header. Without
 * it each step lands anywhere: Grok conversations read back about 1% of their input from cache.
 */
export function withConversationAffinity(
  fetcher: typeof globalThis.fetch,
  baseURL: string | undefined,
  conversationId: string,
): typeof globalThis.fetch {
  if (baseURL !== XAI_BASE_URL) return fetcher;

  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('x-grok-conv-id', conversationId);
    return fetcher(input, { ...init, headers });
  };
}

/** Merge provider options without replacing reasoning settings already selected for the turn. */
export function withOpenAiPromptCache(
  options: Record<string, Record<string, JSONValue>> | undefined,
  profileId: string,
  provider: string,
  modelId: string,
): Record<string, Record<string, JSONValue>> | undefined {
  const cache = openAiPromptCacheOptions(profileId, provider, modelId);
  if (!cache) return options;

  return { ...options, openai: { ...options?.openai, ...cache.openai } };
}

/** What Anthropic accepts per request. Anything past it is refused and silently not cached. */
const BREAKPOINTS = 4;

/**
 * How long a cached prefix is kept. A conversation a person types into pauses for minutes
 * between turns, so the five-minute tier has usually expired by the time they answer and every
 * turn pays for the whole prompt again; the hour tier costs more to write once and is read
 * back for the rest of the conversation. Agents answer each other in seconds and never collect
 * that retention, so they stay on the cheaper write.
 */
export type CacheTtl = '5m' | '1h';

/**
 * The instructions as one cached block. They hold nothing that changes from turn to turn — the
 * time, the memories and the rest go in the turn context — so the mark at their end is read back
 * for the whole conversation.
 */
export function cacheableInstructions(system: string, ttl: CacheTtl): SystemModelMessage[] {
  const messages: SystemModelMessage[] = [];
  if (system.startsWith(CLAUDE_CODE_IDENTITY)) {
    messages.push({ role: 'system', content: CLAUDE_CODE_IDENTITY });
    system = system.slice(CLAUDE_CODE_IDENTITY.length).trim();
  }
  messages.push({
    role: 'system',
    content: system,
    providerOptions: {
      anthropic: {
        cacheControl: ttl === '1h' ? { type: 'ephemeral', ttl } : { type: 'ephemeral' },
      },
    },
  });
  return messages;
}

/** A message can carry a mark only if it has content for the mark to sit on. */
function markable(message: ModelMessage): boolean {
  const content = message.content;

  return Array.isArray(content)
    ? content.length > 0
    : typeof content === 'string' && content !== '';
}

/**
 * Anthropic reuses a prompt only up to a point the request marks, and re-reading that prefix
 * costs a tenth of sending it. The marks go where the prompt stops changing:
 *
 * - on the last message of the history, before the turn context (`turnStart`): the prefix
 *   that is the same next turn, so the next turn reads the whole history back. Without
 *   `turnStart`, on the first message, behind which are the tools and the instructions;
 * - on the last two messages, so the steps of this turn are read back by the next step instead
 *   of re-sent. What is reused is the prefix that ends at a mark.
 *
 * Marks are stripped before being placed: the loop hands its own messages back on every step,
 * and leaving the old ones would add a breakpoint per step until Anthropic refused them. A
 * prefix below the model's minimum is simply not cached, so marking a short prompt costs
 * nothing.
 */
export function cacheable(
  messages: ModelMessage[],
  ttl: CacheTtl = '5m',
  breakpoints = BREAKPOINTS,
  turnStart?: number,
): ModelMessage[] {
  const eligible = messages.flatMap((message, index) => (markable(message) ? [index] : []));

  if (eligible.length === 0) {
    return messages;
  }

  const history =
    turnStart === undefined ? undefined : eligible.filter((index) => index < turnStart).at(-1);
  const head = history ?? (eligible[0] as number);
  const marks = new Set([head, ...eligible.slice(-(breakpoints - 1))]);

  return messages.map((message, index) => {
    const anthropic = { ...message.providerOptions?.anthropic } as Record<string, JSONValue>;

    delete anthropic.cacheControl;

    if (marks.has(index)) {
      anthropic.cacheControl = ttl === '1h' ? { type: 'ephemeral', ttl } : { type: 'ephemeral' };
    }

    if (!message.providerOptions && !marks.has(index)) {
      return message;
    }

    return {
      ...message,
      providerOptions: { ...message.providerOptions, anthropic },
    } as ModelMessage;
  });
}

/**
 * The messages with no cache mark of their own: for a request whose cached messages nothing will
 * ever read again, where a write to the cache, at up to twice the price of reading the input
 * fresh, buys nothing. The system's and the tools' marks are elsewhere, and stay.
 */
export function uncached(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    const anthropic = message.providerOptions?.anthropic;
    if (!anthropic || !('cacheControl' in anthropic)) return message;
    const { cacheControl: _, ...rest } = anthropic as Record<string, JSONValue>;
    return {
      ...message,
      providerOptions: { ...message.providerOptions, anthropic: rest },
    } as ModelMessage;
  });
}
