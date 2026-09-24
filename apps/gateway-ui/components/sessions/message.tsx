'use client';

import { AlarmClock } from 'lucide-react';
import type { Message, Person } from '../../lib/api';
import { date } from '../../lib/format';
import { Face } from '../ui';

/**
 * How a member is known when they gave no name: their number on WhatsApp, their id elsewhere.
 * A WhatsApp member that arrives under an internal id (`@lid`) has no number to show.
 */
export const handleOf = (id: string) => {
  const phone = /^(\d+)@(c\.us|s\.whatsapp\.net)$/.exec(id);

  return phone ? `+${phone[1]}` : id.replace(/@lid$/, '');
};

/**
 * The author of a group message and the text they wrote. The gateway writes the author's name
 * first so the agent reads who spoke; here it moves out of the text and beside it. A message
 * from before authors were kept has only that prefix to go on.
 */
export function authored(message: Message) {
  const name = message.author?.name ?? message.author?.id;

  // A message that is only an attachment carries the name and nothing after it on that line.
  if (
    name &&
    new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\s|$)`).test(message.content)
  ) {
    return { ...message.author, text: message.content.slice(name.length + 1).trimStart() };
  }

  if (message.author) {
    return { ...message.author, text: message.content };
  }

  const legacy = /^([^:\n]{1,60}): /.exec(message.content);

  return legacy?.[1]
    ? { name: legacy[1], text: message.content.slice(legacy[0].length) }
    : { text: message.content };
}

/**
 * One message, as an AI chat shows it, in every conversation alike: whoever wrote to the agent
 * in a pill on the right, the agent as plain text on the left with its tools above. In a group
 * the right side is several people, so each run of messages from one of them opens with their
 * face and name.
 */
export function ChatMessage({
  message,
  group,
  people,
  opensRun,
  before,
  children,
}: {
  message: Message;
  group: boolean;
  people: Map<string, Person>;
  opensRun: boolean;
  /** Shown above the text, as the tools the agent used to write it. */
  before?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const clean = (text: string) => text.replace(/\[Attached media: [0-9a-f-]{36}\]/g, '').trim();

  const mine = message.role === 'user';
  // Written by a schedule at its time, not by anyone in the conversation: shown as what it is.
  const scheduled = mine ? /^\[Scheduled: ([^\]]+)\] ([\s\S]*)$/.exec(message.content) : null;

  if (scheduled) {
    return (
      <article className="chat-line scheduled" title={date(message.createdAt)}>
        <span className="scheduled-label">
          <AlarmClock size={13} />
          {scheduled[1]}
        </span>
        <div className="chat-text">{clean(scheduled[2] ?? '')}</div>
        {children}
      </article>
    );
  }

  if (!mine || !group) {
    return (
      <article className={`chat-line ${mine ? 'mine' : 'theirs'}`} title={date(message.createdAt)}>
        {before}
        {clean(message.content) && <div className="chat-text">{clean(message.content)}</div>}
        {children}
      </article>
    );
  }

  const author = authored(message);
  const person = author.id ? people.get(author.id) : undefined;
  const name = person?.name ?? author.name ?? (author.id ? handleOf(author.id) : 'Someone');

  return (
    <article
      className={`chat-line mine member ${opensRun ? 'opens' : ''}`}
      title={date(message.createdAt)}
    >
      {opensRun ? (
        <Face name={name} picture={person?.avatar} className="chat-face" />
      ) : (
        <span className="chat-face" aria-hidden="true" />
      )}
      <div className="chat-body">
        {opensRun && <strong className="chat-author">{name}</strong>}
        {clean(author.text) && <div className="chat-text">{clean(author.text)}</div>}
        {children}
      </div>
    </article>
  );
}
