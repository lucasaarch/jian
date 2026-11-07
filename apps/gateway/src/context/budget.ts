import type { ModelMessage, ToolSet } from 'ai';
import {
  getEncoding,
  getEncodingNameForModel,
  type TiktokenEncoding,
  type TiktokenModel,
} from 'js-tiktoken';
import { z } from 'zod';
import { CHECKPOINT } from './markers.js';
import { type Kept, withKept } from './survivors.js';

type Counter = (text: string) => number;

const encoders = new Map<TiktokenEncoding, Counter>();
const byteCounter: Counter = (text) => Buffer.byteLength(text, 'utf8');

/** Unknown model tokenizers use one token per UTF-8 byte, a deliberately conservative bound. */
export function tokenCounter(provider: string, modelId: string): Counter {
  if (provider === 'openai' || provider === 'openai-codex') {
    try {
      const name = getEncodingNameForModel(modelId as TiktokenModel);
      let counter = encoders.get(name);

      if (!counter) {
        // Encodings are a finite set. Share their large rank maps across profiles and steps.
        const encoding = getEncoding(name);

        counter = (text) => Math.ceil(encoding.encode(text, [], []).length * 1.15);
        encoders.set(name, counter);
      }

      return counter;
    } catch {
      // An unknown OpenAI model uses the same conservative fallback as other providers.
    }
  }

  return byteCounter;
}

/**
 * Pixels have a model cost, not the token count of their base64 transport. That holds for an
 * attachment inside a tool result too (`image-data`, `file-data`): counted as text, one 600 KB
 * screenshot from analyze_media read as 800k tokens and failed a run that used 30k.
 */
export function promptText(value: unknown, onImage?: () => void): string {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== 'object') return item;
    const image =
      item.type === 'image' ||
      item.type === 'image-data' ||
      ((item.type === 'file' || item.type === 'file-data') &&
        typeof item.mediaType === 'string' &&
        (item.mediaType === 'image' || item.mediaType.startsWith('image/')));
    if (image) {
      onImage?.();
      return { type: 'text', text: '[Image attachment]' };
    }
    if (item.type === 'file' || item.type === 'file-data')
      return { type: 'text', text: '[File attachment]' };
    return item;
  });
}

function messageCost(message: ModelMessage, count: Counter): number {
  let images = 0;
  const text = promptText(message, () => {
    images++;
  });
  return count(text) + images * 8192 + 16;
}

function schemaText(tools: ToolSet): string {
  const definitions = Object.entries(tools).map(([name, definition]) => {
    let inputSchema: unknown;

    try {
      inputSchema = z.toJSONSchema(definition.inputSchema as z.ZodType);
    } catch {
      inputSchema = definition.inputSchema;
    }

    return { name, description: definition.description, inputSchema };
  });

  try {
    return JSON.stringify(definitions);
  } catch {
    throw new Error('Context budget exceeded');
  }
}

/** A tool result must stay beside its assistant call when older history is removed. */
export function blocksOf(messages: readonly ModelMessage[]): ModelMessage[][] {
  const blocks: ModelMessage[][] = [];

  for (const message of messages) {
    if (message.role === 'tool' && blocks.at(-1)?.[0]?.role === 'assistant') {
      blocks.at(-1)?.push(message);
    } else {
      blocks.push([message]);
    }
  }

  return blocks;
}

/**
 * An estimate in the provider's tokens. `scale` is what a step measured them to be per token of
 * the estimate (see `scale.ts`); left out, the estimate stands as counted.
 */
const scaled = (tokens: number, scale = 1) => Math.ceil(tokens * scale);

export function promptTokens(input: {
  provider: string;
  modelId: string;
  instructions: string;
  messages: readonly ModelMessage[];
  tools: ToolSet;
  scale?: number;
}): number {
  const count = tokenCounter(input.provider, input.modelId);
  return scaled(
    count(input.instructions) +
      count(schemaText(input.tools)) +
      32 * Object.keys(input.tools).length +
      32 +
      input.messages.reduce((sum, message) => sum + messageCost(message, count), 0),
    input.scale,
  );
}

export function fitPrompt(input: {
  provider: string;
  modelId: string;
  policy: { inputTokens: number; outputTokens: number };
  instructions: string;
  messages: readonly ModelMessage[];
  tools: ToolSet;
  scale?: number;
}): {
  instructions: string;
  messages: ModelMessage[];
  /** The prompt in the provider's tokens: the estimate times `scale`. */
  tokens: number;
  /** The gateway's own count, unscaled, which a step's reported input is measured against. */
  estimatedTokens: number;
  /** Unscaled, in the same units as `estimatedTokens`. */
  breakdown: { system: number; tools: number; messages: number };
} {
  const count = tokenCounter(input.provider, input.modelId);
  const limit = input.policy.inputTokens - input.policy.outputTokens;

  if (limit <= 0) {
    throw new Error('Context budget exceeded');
  }

  const schema = schemaText(input.tools);

  const systemTokens = count(input.instructions) + 32;
  const toolTokens = count(schema) + 32 * Object.keys(input.tools).length;
  const fixedTokens = systemTokens + toolTokens;

  const estimatedTokens =
    fixedTokens + input.messages.reduce((sum, message) => sum + messageCost(message, count), 0);
  const tokens = scaled(estimatedTokens, input.scale);

  // Naming the parts is the whole value of this failure: the fixed cost is what the owner can
  // act on, and it is almost always the tool schemas rather than anything they wrote.
  if (tokens > limit) {
    throw new Error(
      `Context budget exceeded: ${tokens} tokens against a limit of ${limit}. ` +
        `Tool definitions cost ${scaled(count(schema), input.scale)} and the system prompt ` +
        `${scaled(count(input.instructions), input.scale)}; ` +
        'compact the conversation or connect fewer MCP tools.',
    );
  }

  return {
    instructions: input.instructions,
    messages: [...input.messages],
    tokens,
    estimatedTokens,
    breakdown: { system: systemTokens, tools: toolTokens, messages: estimatedTokens - fixedTokens },
  };
}

/** A tool result put aside to fit the window; its step checkpoint keeps it for read_artifact. */
function shedResults(block: ModelMessage[]): { block: ModelMessage[]; shed: number } {
  let shed = 0;
  const next = block.map((message) => {
    if (message.role !== 'tool') return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== 'tool-result') return part;
        shed++;
        const note = `[Result removed to fit the context window; read_artifact with toolCallId "${part.toolCallId}" returns it.]`;
        // A Claude tool reference stays: it is what keeps a loaded tool in the context, and
        // losing it would change the tools sent, the front of the cached prompt (see
        // agent/deferred-tools.ts). It costs a few bytes; no other provider has one.
        const references =
          part.output.type === 'content'
            ? part.output.value.filter(
                (item) =>
                  item.type === 'custom' &&
                  (item.providerOptions?.anthropic as { type?: unknown } | undefined)?.type ===
                    'tool-reference',
              )
            : [];
        return {
          ...part,
          output: references.length
            ? {
                type: 'content' as const,
                value: [{ type: 'text' as const, text: note }, ...references],
              }
            : { type: 'text' as const, value: note },
        };
      }),
    };
  });
  return { block: next, shed };
}

/**
 * Last resort when compaction cannot shrink the request: drop the oldest turn blocks until the
 * prompt fits, keeping the latest user turn. The dropped turns remain in the database and the
 * panel. When the current turn alone outgrew the window, step by step, the results of its
 * oldest tool calls are put aside, never the latest step's, rather than failing the run.
 */
export function truncatePrompt(input: {
  provider: string;
  modelId: string;
  policy: { inputTokens: number; outputTokens: number };
  instructions: string;
  messages: readonly ModelMessage[];
  tools: ToolSet;
  currentStartIndex?: number;
  scale?: number;
  /**
   * The checkpoint this run's compaction left as the first message, as data: it is known by
   * being exactly what these render to, and lightened from them, never by reading its text.
   */
  checkpoint?: { record: string; kept: Kept };
}):
  | {
      instructions: string;
      messages: ModelMessage[];
      tokens: number;
      estimatedTokens: number;
      breakdown: { system: number; tools: number; messages: number };
      droppedBlocks: number;
      shedResults: number;
      /** What was let go of beside the checkpoint's record, files before people's words. */
      droppedSurvivors?: ('files' | 'words')[];
    }
  | undefined {
  const blocks = blocksOf(input.messages);
  if (blocks.length <= 1) return undefined;

  // The checkpoint is the record of everything before it: never dropped as an old turn. What
  // was kept beside its record goes only once this turn's results have been put aside.
  const rendered = (kept: Kept) =>
    input.checkpoint ? `${CHECKPOINT}\n${withKept(input.checkpoint.record, kept)}` : undefined;
  const opening = blocks[0]?.[0];
  const checkpoint =
    input.checkpoint &&
    blocks[0]?.length === 1 &&
    opening?.role === 'user' &&
    opening.content === rendered(input.checkpoint.kept)
      ? opening
      : undefined;
  const head = (content = checkpoint?.content): ModelMessage[] =>
    checkpoint && typeof content === 'string' ? [{ ...checkpoint, content }] : [];
  const first = checkpoint ? 1 : 0;

  let keepFrom = first;
  const currentStart = input.currentStartIndex;
  const currentBlock =
    currentStart === undefined
      ? blocks.length - 1
      : (() => {
          let seen = 0;
          const index = blocks.findIndex((block) => {
            const contains = seen + block.length > currentStart;
            seen += block.length;
            return contains;
          });
          return index < 0 ? blocks.length - 1 : index;
        })();

  while (keepFrom < Math.max(currentBlock, first)) {
    keepFrom++;
    try {
      const fitted = fitPrompt({
        ...input,
        messages: [...head(), ...blocks.slice(keepFrom).flat()],
      });
      return { ...fitted, droppedBlocks: keepFrom - first, shedResults: 0 };
    } catch {
      // Keep dropping older blocks until the current turn fits or nothing remains to drop.
    }
  }

  const start = Math.max(currentBlock, first);
  const current = blocks.slice(start);
  const dropped = start - first;
  let shed = 0;
  for (let index = 0; ; index++) {
    try {
      const fitted = fitPrompt({ ...input, messages: [...head(), ...current.flat()] });
      return { ...fitted, droppedBlocks: dropped, shedResults: shed };
    } catch {
      // The latest step's results are what the model is answering now: never shed those.
      if (index >= current.length - 1) break;
      const next = shedResults(current[index] as ModelMessage[]);
      current[index] = next.block;
      shed += next.shed;
    }
  }

  // Then what was kept beside the record: the files, which can be read again, then the words.
  // The record itself stays; when it alone does not fit, nothing here can help.
  const kept = input.checkpoint?.kept;
  if (!checkpoint || !kept) return undefined;
  const lighter: { content: string; survivors: ('files' | 'words')[] }[] = [];
  if (kept.files?.files.length) {
    lighter.push({
      content: rendered(kept.words ? { words: kept.words } : {}) as string,
      survivors: ['files'],
    });
  }
  if (kept.words?.length) {
    lighter.push({
      content: rendered({}) as string,
      survivors: [...(kept.files?.files.length ? ['files' as const] : []), 'words'],
    });
  }
  for (const { content: next, survivors } of lighter) {
    try {
      const fitted = fitPrompt({ ...input, messages: [...head(next), ...current.flat()] });
      return { ...fitted, droppedBlocks: dropped, shedResults: shed, droppedSurvivors: survivors };
    } catch {
      // Lighter still, or the record alone does not fit.
    }
  }
  return undefined;
}
