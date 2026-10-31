'use client';

import { AlarmClock, GraduationCap, Reply } from 'lucide-react';
import type { ReactNode } from 'react';
import { AgentFace } from '../../kit';
import type { Message, Person, Profile } from '../../lib/api';
import { Face } from '../ui';
import { Markdown, MarkdownLink } from '../ui/markdown';
import { MessageActions, MessageReactions } from './message-actions';

const GITHUB_LINK =
  /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/(?:pull|issues)\/\d+(?:[^\s<>()]*[^\s<>().,;:!?'"])?/g;

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
 * What a person typed, as typed, except that a pull request or an issue they link to is shown
 * as the agent's would be: their words are never read as Markdown.
 */
function withGitHubLinks(text: string) {
  const parts: ReactNode[] = [];
  let last = 0;

  for (const match of text.matchAll(GITHUB_LINK)) {
    const at = match.index ?? 0;

    if (at > last) parts.push(text.slice(last, at));
    parts.push(<MarkdownLink key={at} href={match[0]} label={match[0]} />);
    last = at + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/**
 * How a member is known when they gave no name: their number on WhatsApp, their id elsewhere.
 * A WhatsApp member that arrives under an internal id (`@lid`) has no number to show.
 */
const handleOf = (id: string) => {
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
function quoted(text: string) {
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
/** What a channel writes for a message that is only a file, which the file itself shows. */
const STANDS_FOR_FILE =
  /^\[(Voice message|Audio|Photo|Video|Sticker|Media attachment|File(: [^\]]*)?)\]$/;

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
        // One quiet line over the reply: whose message it answers and how that began; the
        // whole of it under the pointer.
        <blockquote className="chat-quote" title={quote}>
          <Reply size={13} aria-hidden="true" />
          <strong>{whose === 'your message' ? 'Agent' : whose.replace(/'s message$/, '')}</strong>
          <span>{quote ?? 'A message'}</span>
        </blockquote>
      )}
      {withGitHubLinks(body)}
    </div>
  );
}

/**
 * One message, as an AI chat shows it, in every conversation alike: whoever wrote to the agent
 * on the same text column, the agent that answers as plain text under it with its tools
 * above. In a group the writers are several people, on the right, so each run of messages from
 * one of them opens with their face and name.
 */
export function ChatMessage({
  message,
  group,
  people,
  opensRun,
  before,
  children,
  agent,
  entered = false,
  onReply,
  onReact,
}: {
  message: Message;
  group: boolean;
  people: Map<string, Person>;
  opensRun: boolean;
  /** Shown above the text, as the tools the agent used to write it. */
  before?: React.ReactNode;
  children?: React.ReactNode;
  agent?: Pick<Profile, 'name' | 'avatar'>;
  /** A streamed answer already entered; storing it must not play that entrance again. */
  entered?: boolean;
  onReply?: () => void;
  onReact?: (emoji: string | null) => Promise<unknown>;
}) {
  // Attachment markers and the gateway's notes about files are drawn as attachments below. A
  // channel writes "[Voice message]" or "[Photo]" for a message that is only a file: with the
  // file drawn, those words would only say it again.
  const clean = (text: string) => {
    const words = text
      .replace(/\[Attached media: [0-9a-f-]{36}\]/g, '')
      .replace(/^\[Voice call · [^\]]+\]\n/, '')
      .replace(/\n?\[File not (opened|kept)[^\]]*\]/g, '')
      .trim();
    return /\[Attached media: /.test(text) && STANDS_FOR_FILE.test(words) ? '' : words;
  };

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
      <article
        className={`chat-line ${mine ? 'mine' : 'theirs'}`}
        data-message-id={message.id}
        data-entered={entered || undefined}
      >
        {(!mine || message.call) && (
          <div className="chat-author-row">
            <ChatSpeaker agent={agent} />
            {message.role === 'assistant' && !message.call && (
              <MessageActions message={message} onReply={onReply} onReact={onReact} />
            )}
          </div>
        )}
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
        <MessageReactions message={message} agentName={agent?.name} />
      </article>
    );
  }

  const author = authored(message);
  const person = author.id ? people.get(author.id) : undefined;
  const name = person?.name ?? author.name ?? (author.id ? handleOf(author.id) : 'Someone');

  return (
    <article
      className={`chat-line mine member ${opensRun ? 'opens' : ''}`}
      data-message-id={message.id}
    >
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
      <MessageReactions message={message} agentName={agent?.name} />
    </article>
  );
}
