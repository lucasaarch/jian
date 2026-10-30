import { z } from 'zod';
import { protectionModeSchema } from './profile.js';
import { reasoningEffortSchema } from './providers.js';

/**
 * Messages a client may resend in one request. Clients of this dialect resend the whole
 * conversation on every turn, so the bound is generous; only the last user message is read.
 */
export const OPENAI_MESSAGE_LIMIT = 2000;

/**
 * One part of a message's content. Only text parts are read; an image part is accepted and
 * left out, so a client that attaches one still gets its text answered.
 */
const contentPartSchema = z.looseObject({
  type: z.string().max(40),
  text: z.string().optional(),
});

const chatMessageSchema = z.looseObject({
  // `developer` is the newer name OpenAI gives the system message; `function` its oldest tool.
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool', 'function']),
  content: z.union([z.string(), z.array(contentPartSchema).max(100)]).nullish(),
});

/**
 * OpenAI's Chat Completions request, as an API channel takes it. Loose on purpose: a client
 * written for OpenAI sends `temperature`, `tools`, `n` and more, and refusing what Jian does
 * not use would refuse the client. The agent's own settings decide those things here.
 */
export const chatCompletionRequestSchema = z.looseObject({
  model: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .describe('A model id from GET /models, or `default` for the gateway Model defaults.'),
  messages: z.array(chatMessageSchema).min(1).max(OPENAI_MESSAGE_LIMIT),
  stream: z
    .boolean()
    .nullish()
    .describe(
      'When true, the answer arrives as text/event-stream `chat.completion.chunk` events, ending with `data: [DONE]`.',
    ),
  reasoning_effort: reasoningEffortSchema.nullish(),
  user: z.string().max(100).nullish().describe('Who is writing; one Jian contact per user.'),
  metadata: z
    .looseObject({
      chat_id: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .optional()
        .describe('The conversation; without it, one is recognised from its first messages.'),
    })
    .nullish(),
  protection: protectionModeSchema
    .optional()
    .describe('Jian extension: `ask` or `auto`; `full` is refused on an API channel.'),
});

export const openAiModelListSchema = z.strictObject({
  object: z.literal('list'),
  data: z.array(
    z.strictObject({
      id: z.string(),
      object: z.literal('model'),
      created: z.number().int(),
      owned_by: z.string(),
    }),
  ),
});

const usageSchema = z.strictObject({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});

export const chatCompletionSchema = z.strictObject({
  id: z.string(),
  object: z.literal('chat.completion'),
  created: z.number().int(),
  model: z.string(),
  choices: z.array(
    z.strictObject({
      index: z.number().int(),
      message: z.strictObject({ role: z.literal('assistant'), content: z.string() }),
      finish_reason: z.literal('stop'),
    }),
  ),
  usage: usageSchema,
});

/** One event of a streamed answer: the role first, then the text as it grows, then the stop. */
export const chatCompletionChunkSchema = z.strictObject({
  id: z.string(),
  object: z.literal('chat.completion.chunk'),
  created: z.number().int(),
  model: z.string(),
  choices: z.array(
    z.strictObject({
      index: z.number().int(),
      delta: z.strictObject({
        role: z.literal('assistant').optional(),
        content: z.string().optional(),
      }),
      finish_reason: z.literal('stop').nullable(),
    }),
  ),
});

/** Every refusal of the OpenAI-compatible routes, in the shape OpenAI's clients read. */
export const openAiErrorSchema = z.strictObject({
  error: z.strictObject({
    message: z.string(),
    type: z.string(),
    code: z.string().nullable(),
  }),
});

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
export type ChatCompletion = z.infer<typeof chatCompletionSchema>;
export type ChatCompletionChunk = z.infer<typeof chatCompletionChunkSchema>;
export type OpenAiError = z.infer<typeof openAiErrorSchema>;
