'use client';

import type { ReactNode } from 'react';
import { AgentFace } from '../../../kit';
import type { Profile } from '../../../lib/api';

/** Live and stored messages keep the same author header and text origin. */
export function ChatSpeaker({ agent }: { agent?: Pick<Profile, 'name' | 'avatar'> }) {
  return (
    <span className="chat-speaker" data-author="assistant">
      <AgentFace name={agent?.name ?? 'Agent'} avatar={agent?.avatar} size={1.25} />
      {agent?.name ?? 'Agent'}
    </span>
  );
}

/**
 * What the agent says, as one element from the moment it starts writing to long after it is
 * stored. The turn at work and the answer it becomes draw this same component in the same
 * slots, so when the answer lands React keeps the element and only what is in the slots moves.
 */
export function AgentLine({
  agent,
  messageId,
  pending = false,
  actions,
  before,
  text,
  children,
  reactions,
}: {
  agent?: Pick<Profile, 'name' | 'avatar'>;
  /** The stored message's id, for the conversation map; none while it is being written. */
  messageId?: string;
  /** Still being written: read out as it changes. */
  pending?: boolean;
  /** Beside the speaker: copy, reply and react, for a stored answer. */
  actions?: ReactNode;
  /** Above the text: the tools used to write it, or the work under way, and agents spawned. */
  before?: ReactNode;
  text?: ReactNode;
  children?: ReactNode;
  reactions?: ReactNode;
}) {
  return (
    <article
      className={`chat-line theirs${pending ? ' pending' : ''}`}
      data-message-id={messageId}
      aria-live={pending ? 'polite' : undefined}
    >
      <div className="chat-author-row">
        <ChatSpeaker agent={agent} />
        {actions}
      </div>
      {before}
      {text}
      {children}
      {reactions}
    </article>
  );
}
