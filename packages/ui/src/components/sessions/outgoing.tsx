'use client';

import { RotateCcw, X } from 'lucide-react';
import type { GatewayApi, Message, Person } from '../../lib/api';
import { discard, type Outgoing, resend } from '../../lib/stores/outbox';
import { MessageMedia } from './media';
import { ChatMessage } from './message';

/**
 * A message the owner sent that the gateway has not taken yet, drawn as theirs at once: quietly
 * marked while it goes, and in the bad ink with why, to send again or let go, when it did not.
 */
export function OutgoingMessage({
  item,
  profileId,
  people,
  api,
}: {
  item: Outgoing;
  profileId: string;
  people: Map<string, Person>;
  api: Partial<Pick<GatewayApi, 'media'>>;
}) {
  // What the stored message will hold: the words, and a marker for each file sent with them.
  const quote = item.replyTo
    ? `[Replying to your message: "${item.replyTo.content.replace(/\s+/g, ' ').trim().slice(0, 300)}"]\n`
    : '';
  const content =
    quote +
    [item.text, ...item.mediaIds.map((id) => `[Attached media: ${id}]`)].filter(Boolean).join('\n');
  const message = {
    id: item.key,
    profileId,
    sessionId: item.sessionId,
    role: 'user',
    content,
    createdAt: item.at,
  } as Message;

  return (
    <div className="outgoing" data-state={item.state}>
      <ChatMessage message={message} group={false} people={people} opensRun={false}>
        {api.media && item.mediaIds.length > 0 && (
          <MessageMedia api={{ media: api.media }} profileId={profileId} content={content} />
        )}
        {item.state === 'failed' ? (
          <div className="outgoing-state" role="alert">
            <span className="min-w-0 truncate" title={item.error}>
              Not sent{item.error ? `: ${item.error}` : ''}
            </span>
            <button type="button" onClick={() => resend(item.key)}>
              <RotateCcw size={12} aria-hidden="true" /> Retry
            </button>
            <button type="button" onClick={() => discard(item.key)}>
              <X size={12} aria-hidden="true" /> Discard
            </button>
          </div>
        ) : null}
      </ChatMessage>
    </div>
  );
}
