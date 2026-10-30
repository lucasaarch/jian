import { createHash } from 'node:crypto';
import type { ChatCompletionRequest } from '@jian/contracts';
import { GatewayError } from '../../core/errors.js';

/** Who writes when a client names no `user`: one contact, approved once by the owner. */
const OPENAI_ACTOR = 'openai';

/** The most one message carries into a run, as ingress takes it. */
const TEXT_LIMIT = 8000;

type Message = ChatCompletionRequest['messages'][number];

/**
 * The text of a message. Image and audio parts are left out for now: through this door the
 * agent reads text, and a client that attached a picture still has its words answered.
 */
function textOf(message: Message): string {
  const { content } = message;

  if (typeof content === 'string') return content;

  return (content ?? [])
    .flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
    .join('\n');
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * One request as a turn of a Jian conversation. A client of this dialect resends the whole
 * conversation each time while Jian already holds it, so only the last user message is new.
 *
 * Without `metadata.chat_id`, the conversation is recognised by how it began: the same first
 * system and user messages, resent with a longer history, are the same conversation. The
 * request key counts the messages, so a retry of one turn is that turn again, never another.
 */
export function openAiTurn(channelId: string, request: ChatCompletionRequest) {
  const last = request.messages.findLast((message) => message.role === 'user');
  const text = last ? textOf(last).trim() : '';

  if (!text) throw new GatewayError(400, 'The last user message has no text');
  if (text.length > TEXT_LIMIT) {
    throw new GatewayError(400, `The last user message is longer than ${TEXT_LIMIT} characters`);
  }

  const system = request.messages.find(
    (message) => message.role === 'system' || message.role === 'developer',
  );
  const opening = request.messages.find((message) => message.role === 'user');
  const chatId =
    request.metadata?.chat_id ??
    `openai-${digest([channelId, system ? textOf(system) : '', opening ? textOf(opening) : ''])}`;

  return {
    chatId,
    actorId: request.user?.trim() || OPENAI_ACTOR,
    text,
    requestKey: digest([chatId, request.messages.length, text]),
  };
}
