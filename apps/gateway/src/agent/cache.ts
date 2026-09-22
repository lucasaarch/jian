import type { ModelMessage } from 'ai';

/**
 * Anthropic reuses a prompt only up to a point the request marks, and re-reading that prefix
 * costs a tenth of sending it. Everything before the first message — the tool definitions and
 * the instructions — is identical on every step of a run and on every turn of a session, which
 * is what the first mark buys. The second sits on the turn before the newest, so the steps a
 * run has already taken are read back rather than re-sent.
 *
 * Anthropic accepts four marks per request; a prefix shorter than the model's minimum is simply
 * not cached, so marking a short prompt costs nothing.
 */
export function cacheable(messages: ModelMessage[]): ModelMessage[] {
  const marks = new Set([0, messages.length - 2].filter((index) => index >= 0));

  return messages.map((message, index) =>
    marks.has(index)
      ? {
          ...message,
          providerOptions: {
            ...message.providerOptions,
            anthropic: {
              ...message.providerOptions?.anthropic,
              cacheControl: { type: 'ephemeral' },
            },
          },
        }
      : message,
  );
}
