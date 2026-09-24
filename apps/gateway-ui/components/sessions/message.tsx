'use client';

import { AlarmClock, GraduationCap } from 'lucide-react';
import type { Message, Person } from '../../lib/api';
import { Face } from '../ui';
import { Markdown } from '../ui/markdown';

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
 * The quote the gateway writes above a reply, and the line it writes for a reaction, read back
 * out of the text so the panel can draw them as a messenger does.
 */
export function quoted(text: string) {
  const reaction =
    /^\[Reacted (.+?) to (your message|.+?'s message|a message)(?:: "([\s\S]*)")?\]$/.exec(text);

  if (reaction) {
    return { reaction: reaction[1], whose: reaction[2], quote: reaction[3], body: '' };
  }

  const reply = /^\[Replying to (your message|.+?'s message|a message)(?:: "([\s\S]*?)")?\]\n/.exec(
    text,
  );

  if (reply) {
    return { whose: reply[1], quote: reply[2], body: text.slice(reply[0].length) };
  }

  return { body: text };
}

/** What a person wrote, with the message they answered above it or the reaction they left. */
function PersonText({ text }: { text: string }) {
  const { reaction, whose, quote, body } = quoted(text);

  if (reaction) {
    return (
      <div className="chat-reaction">
        <span className="chat-reaction-emoji">{reaction}</span>
        <span>
          on {whose === 'your message' ? 'the agent’s message' : whose}
          {quote && <q>{quote}</q>}
        </span>
      </div>
    );
  }

  return (
    <div className="chat-text">
      {whose && (
        <blockquote className="chat-quote">
          <strong>{whose === 'your message' ? 'Agent' : whose.replace(/'s message$/, '')}</strong>
          {quote ?? 'A message'}
        </blockquote>
      )}
      {body}
    </div>
  );
}

/**
 * One message, as an AI chat shows it, in every conversation alike: whoever wrote to the agent
 * in a pill on the right, the agent that answers as plain text on the left with its tools above. In a group
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
  // Attachment markers and the gateway's notes about files are drawn as attachments below.
  const clean = (text: string) =>
    text
      .replace(/\[Attached media: [0-9a-f-]{36}\]/g, '')
      .replace(/\n?\[File not (opened|kept)[^\]]*\]/g, '')
      .trim();

  // In an agent conversation this profile started, it only carried the question: the other
  // agent is the one who works and answers, so it takes the agent's side, on the left.
  const mine = message.call ? message.role === 'assistant' : message.role === 'user';
  // Written by a schedule at its time, not by anyone in the conversation: shown as what it is.
  const scheduled =
    message.role === 'user' && !message.call
      ? /^\[Scheduled: ([^\]]+)\] ([\s\S]*)$/.exec(message.content)
      : null;

  // The brief of a look back is the gateway's, written for the agent: only its first line, which
  // says what is being looked back on, is for the owner.
  const learning = message.role === 'user' ? /^\[Learning\] ([^\n]*)/.exec(message.content) : null;

  if (learning) {
    return (
      <article className="chat-line scheduled">
        <span className="scheduled-label">
          <GraduationCap size={13} />
          {learning[1]}
        </span>
        {children}
      </article>
    );
  }

  if (scheduled) {
    return (
      <article className="chat-line scheduled">
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
      <article className={`chat-line ${mine ? 'mine' : 'theirs'}`}>
        {before}
        {clean(message.content) &&
          (mine ? (
            <PersonText text={clean(message.content)} />
          ) : (
            // The agent writes Markdown; what people send is shown as they typed it.
            <div className="chat-text markdown">
              <Markdown text={clean(message.content)} breaks />
            </div>
          ))}
        {children}
      </article>
    );
  }

  const author = authored(message);
  const person = author.id ? people.get(author.id) : undefined;
  const name = person?.name ?? author.name ?? (author.id ? handleOf(author.id) : 'Someone');

  return (
    <article className={`chat-line mine member ${opensRun ? 'opens' : ''}`}>
      {opensRun ? (
        <Face name={name} picture={person?.avatar} className="chat-face" />
      ) : (
        <span className="chat-face" aria-hidden="true" />
      )}
      <div className="chat-body">
        {opensRun && <strong className="chat-author">{name}</strong>}
        {clean(author.text) && <PersonText text={clean(author.text)} />}
        {children}
      </div>
    </article>
  );
}
