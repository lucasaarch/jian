import { pageText } from '../../core/html-text.js';

/** The longest subject line written from the agent's text, as RFC 5322 recommends for a line. */
const SUBJECT_CHARS = 78;
/** How many message ids a `References` header keeps: the oldest and the newest matter most. */
const REFERENCES_KEPT = 20;

/** The thread a reply continues, as the gateway kept it from the sender's last message. */
export type EmailThread = { subject: string; messageId: string; references: string };

/** What an outgoing email says and which thread it belongs to. */
export type Envelope = {
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string;
};

const ADDRESS = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

/** `Name <ada@example.com>` or `ada@example.com`, as the bare address, lowercased. */
export function bareAddress(value: string | undefined): string | undefined {
  const inner = value?.match(/<([^<>]+)>\s*$/)?.[1] ?? value;
  const address = inner?.trim().toLowerCase();
  return address && ADDRESS.test(address) ? address : undefined;
}

/** The display name of a `From` header, without quotes; none when it is only an address. */
export function displayNameOf(value: string | undefined): string | undefined {
  const name = value
    ?.match(/^(.*?)<[^<>]+>\s*$/)?.[1]
    ?.trim()
    .replace(/^"(.*)"$/, '$1')
    .replace(/\\(.)/g, '$1')
    .trim();
  return name ? name.slice(0, 100) : undefined;
}

/** One header line: a subject from a stranger must not carry a line break into ours. */
export const oneLine = (value: string) => value.replace(/[\r\n\t]+/g, ' ').trim();

/** Message ids as `<id@host>` tokens only, so nothing else rides into a threading header. */
export function messageIds(value: string | undefined): string[] {
  return value?.match(/<[^<>\s]{1,250}>/g) ?? [];
}

/**
 * The words of a reply without the history the mail client quoted under it: the `>` lines at
 * the end and the `On … wrote:` line that introduces them. Only a quote at the end is cut, so
 * an answer written between quoted lines keeps everything.
 */
export function withoutQuote(text: string): string {
  const lines = text.split('\n');
  let end = lines.length;
  while (end > 0 && (/^\s*>/.test(lines[end - 1] ?? '') || !lines[end - 1]?.trim())) end--;
  if (end === lines.length) return text.trim();
  const last = lines[end - 1]?.trim() ?? '';
  if (/wrote:$/i.test(last)) {
    end--;
    // Gmail wraps a long attribution, leaving `wrote:` alone on the second line.
    if (/^wrote:$/i.test(last) && /^On\s/i.test(lines[end - 1]?.trim() ?? '')) end--;
  }
  const kept = lines.slice(0, end).join('\n').trim();
  return kept || text.trim();
}

/** What a received email says: its plain text, or its HTML read as text, without the quote. */
export function mailBody(text: string | null | undefined, html: string | null | undefined) {
  const body = text?.trim() ? text : html ? pageText(html).text : '';
  return withoutQuote(body.replace(/\r\n?/g, '\n'));
}

/**
 * Subject and threading of an outgoing email. A first line `Subject: …` starts a new thread
 * under that subject and is not part of the body. Otherwise the reply continues the sender's
 * thread, or, with none, takes its first line as the subject.
 */
export function envelope(text: string, thread?: EmailThread, file?: string): Envelope {
  const opened = /^\s*subject:[ \t]*([^\n]+)(?:\n+|$)/i.exec(text);
  if (opened?.[1]?.trim()) {
    return { subject: oneLine(opened[1]), text: text.slice(opened[0].length).trim() };
  }

  if (thread) {
    const subject = oneLine(thread.subject);
    const references = [...messageIds(thread.references)].slice(-REFERENCES_KEPT).join(' ');
    return {
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`.trim(),
      text: text.trim(),
      inReplyTo: thread.messageId,
      ...(references ? { references } : {}),
    };
  }

  const first = oneLine(text.trim().split('\n')[0] ?? '') || file || 'A message';
  return {
    subject: first.length > SUBJECT_CHARS ? `${first.slice(0, SUBJECT_CHARS - 1)}…` : first,
    text: text.trim(),
  };
}

/** The chain a reply carries: what the sender's message referenced, then the message itself. */
export function referencesOf(references: string | undefined, messageId: string): string {
  return [...messageIds(references), messageId].slice(-REFERENCES_KEPT).join(' ');
}
