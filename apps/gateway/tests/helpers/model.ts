import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { CHECKPOINT_TASK } from '../../src/context/compaction.js';

// Derived from the mock itself so the helper follows the SDK without importing its provider
// package, which this workspace does not depend on directly.
type Options = Parameters<MockLanguageModelV4['doGenerate']>[0];
type Answer = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
type Stream = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'];
type Part = Stream extends ReadableStream<infer P> ? P : never;

/**
 * A mock that answers both calls from one description. The runtime streams, so a model that
 * only knows how to generate fails every test for a reason that has nothing to do with the
 * test. Text arrives as a single delta: what is exercised here is the loop, not a tokenizer.
 */
export function mockModel({ doGenerate }: { doGenerate: (options: Options) => Promise<Answer> }) {
  return new MockLanguageModelV4({
    doGenerate,
    doStream: async (options) => {
      const answer = await doGenerate(options);
      const parts: Part[] = [{ type: 'stream-start', warnings: [] } as Part];

      for (const [index, part] of (answer.content ?? []).entries()) {
        const id = `part-${index}`;

        if (part.type === 'text' || part.type === 'reasoning') {
          const kind = part.type === 'text' ? 'text' : 'reasoning';

          parts.push(
            { type: `${kind}-start`, id } as Part,
            { type: `${kind}-delta`, id, delta: part.text } as Part,
            { type: `${kind}-end`, id } as Part,
          );
        } else {
          parts.push(part as Part);
        }
      }

      parts.push({
        type: 'finish',
        finishReason: answer.finishReason,
        usage: answer.usage,
      } as Part);

      return { stream: simulateReadableStream({ chunks: parts }) as Stream };
    },
  });
}

/**
 * Whether the mock is asked for a summary: in place, the conversation's own request with the
 * summary instructions last, tools and all; in segments, a request of its own without tools.
 */
export const isSummary = (options: Options) => {
  const last = options.prompt.findLast((message) => message.role !== 'system');
  return (
    JSON.stringify(last ?? '').includes(CHECKPOINT_TASK) ||
    options.prompt.some(
      (message) => message.role === 'system' && message.content.includes(CHECKPOINT_TASK),
    )
  );
};
