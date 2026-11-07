'use client';

import { RotateCcw, X } from 'lucide-react';
import type { Message } from '../../lib/api';
import { discard, type Outgoing, resend } from '../../lib/stores/outbox';

/**
 * A message the owner sent, as the stored one will hold it: the words, a marker for each file
 * sent with them, and the quote of what it replies to. Drawn at once in the owner's line, under
 * the outbox key, which the stored message keeps once it lands.
 */
export function sentMessage(item: Outgoing, profileId: string): Message {
  const quote = item.replyTo
    ? `[Replying to your message: "${item.replyTo.content.replace(/\s+/g, ' ').trim().slice(0, 300)}"]\n`
    : '';
  const content =
    quote +
    [item.text, ...item.mediaIds.map((id) => `[Attached media: ${id}]`)].filter(Boolean).join('\n');

  return {
    id: item.key,
    profileId,
    sessionId: item.sessionId,
    role: 'user',
    content,
    createdAt: item.at,
  } as Message;
}

/**
 * Under a message that did not go: why, in the bad ink, and the way to send it again or let it
 * go. Nothing while it goes, which its line already says quietly.
 */
export function OutgoingState({ item }: { item: Outgoing }) {
  if (item.state !== 'failed') return null;

  return (
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
  );
}
