import {
  type JSONValue,
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
  streamText,
  type ToolSet,
} from 'ai';
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
export function withSummaryRequest(messages: ModelMessage[], instructions: string) {
  const ask: ModelMessage = { role: 'user', content: instructions };
  const last = messages.at(-1);
  return last && additionsOf(last) ? [...messages.slice(0, -1), ask, last] : [...messages, ask];
}

/**
 * A summary sent as the request a step sent, plus the instructions. Providers cache a request's
 * prefix (Anthropic in the order tools, system, messages; OpenAI and xAI on the leading bytes),
 * so the conversation is read back from the cache at a tenth of the price instead of again from
 * scratch. Everything else stays as the step had it, because each of these changes the cache key
 * on Anthropic: the tools and their order (the deferred form included), the system blocks, the
 * thinking and effort (a summary at the least effort invalidated the cached messages), and
 * `tool_choice`, which the SDK sets from the tools as it did for the step. `max_tokens` is
 * outside the cached prefix; it stays the step's as well, since the thinking at the owner's
 * effort draws on it before the summary is written. And it is streamed, as a step is: the
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
  signal: AbortSignal;
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
    messages: withSummaryRequest(request.messages, input.instructions),
    activeTools: request.activeTools,
    ...(request.toolOrder ? { toolOrder: request.toolOrder } : {}),
    maxOutputTokens: request.maxOutputTokens,
    ...(request.providerOptions ? { providerOptions: request.providerOptions } : {}),
    allowSystemInMessages: input.allowSystemInMessages,
    abortSignal: input.signal,
    maxRetries: 0,
  });
  // A failed request is reported on the stream; read there, its reason reaches the owner
  // instead of "no output generated".
  let failure: unknown;
  for await (const part of result.fullStream) {
    if (part.type === 'error') failure ??= part.error;
  }
  if (failure) throw failure;
  return {
    text: await result.text,
    finishReason: await result.finishReason,
    toolCalls: await result.toolCalls,
    usage: await result.usage,
  };
}
