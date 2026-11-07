import {
  type JSONValue,
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
  streamText,
  type ToolSet,
} from 'ai';
import { streamedAnswer } from '../context/compaction.js';
import { additionsOf } from './deferred-tools.js';

/** What a step hands the SDK, kept so a summary can be sent as the same request. */
export interface StepRequest {
  instructions: string | SystemModelMessage[];
  messages: ModelMessage[];
  activeTools: string[];
  toolOrder?: string[];
  maxOutputTokens: number;
  providerOptions?: Record<string, Record<string, JSONValue>>;
}

/**
 * The messages with the summary instructions as one more user message. Before the carried
 * tools' system message when that ends them: Anthropic takes it only at the end or right before
 * a reply (see `toolAdditions`). Unmarked, so the cache marks stay where the step put them.
 */
export function withSummaryRequest(
  messages: ModelMessage[],
  instructions: string,
  /** An effort for this one reply, on the models that take one per message. */
  effort?: 'low',
): ModelMessage[] {
  const ask: ModelMessage = { role: 'user', content: instructions };
  const last = messages.at(-1);
  const additions = last && additionsOf(last) ? last : undefined;
  const before = additions ? messages.slice(0, -1) : messages;
  if (!effort) return additions ? [...before, ask, additions] : [...before, ask];
  // A system message with no text and only an effort sets the effort of the reply that follows
  // (Anthropic's mid-conversation effort). It comes after the ask, past every byte the cache
  // holds; carried additions, which must end the messages, take the effort on themselves.
  const anthropic = { ...(additions?.providerOptions?.anthropic ?? {}), effort };
  return [
    ...before,
    ask,
    {
      role: 'system',
      content: '',
      providerOptions: { ...additions?.providerOptions, anthropic },
    } as ModelMessage,
  ];
}

/**
 * A summary sent as the request a step sent, plus the instructions. Providers cache a request's
 * prefix (Anthropic in the order tools, system, messages; OpenAI and xAI on the leading bytes),
 * so the conversation is read back from the cache at a tenth of the price instead of again from
 * scratch. Everything else stays as the step had it, because each of these changes the cache key
 * on Anthropic: the tools and their order (the deferred form included), the system blocks, the
 * thinking and effort (a summary at the least effort invalidated the cached messages), and
 * `tool_choice`, which the SDK sets from the tools as it did for the step. Where the model takes
 * an effort per message, a lower one for the summary goes in a message after the prefix
 * (`effort`), never in the request's own options. `max_tokens` is outside the cached prefix; it
 * stays the step's as well, since thinking draws on it before the summary is written, and the
 * record's length is asked for in the instructions. And it is streamed, as a step is: the
 * Anthropic provider marks each tool `eager_input_streaming` only on a streamed request, so a
 * generated one sent tool definitions that differ from the step's.
 *
 * The tools are sent without their `execute`: their definitions are the front of the prefix, but
 * a call the model makes here runs nothing, and the caller treats it as a failed summary.
 */
export async function summaryCall(input: {
  /** The run's own model, without the deferral fallback: a refusal here fails the summary. */
  model: LanguageModel;
  tools: ToolSet;
  request: StepRequest;
  instructions: string;
  allowSystemInMessages: boolean;
  /** Set where the model takes an effort per message: the record is asked for at `low`. */
  effort?: 'low';
  signal: AbortSignal;
  /** Fed on every part: a long record streams for minutes and is not a stalled call. */
  alive?: () => void;
}) {
  const tools = Object.fromEntries(
    Object.entries(input.tools).map(([name, definition]) => [
      name,
      { ...definition, execute: undefined },
    ]),
  ) as ToolSet;
  const { request } = input;

  const result = streamText({
    model: input.model,
    tools,
    instructions: request.instructions,
    messages: withSummaryRequest(request.messages, input.instructions, input.effort),
    // The effort message is a system message after the ask, whatever the conversation allows.
    allowSystemInMessages: input.allowSystemInMessages || input.effort !== undefined,
    activeTools: request.activeTools,
    ...(request.toolOrder ? { toolOrder: request.toolOrder } : {}),
    maxOutputTokens: request.maxOutputTokens,
    ...(request.providerOptions ? { providerOptions: request.providerOptions } : {}),
    abortSignal: input.signal,
    maxRetries: 0,
  });
  return streamedAnswer(result, input.alive);
}
