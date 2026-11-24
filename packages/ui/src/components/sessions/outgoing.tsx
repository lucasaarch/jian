'use client';

import { Check, CheckCheck, FileText, RotateCcw, X } from 'lucide-react';
import { HoverTip } from '../../kit';
import type { Message } from '../../lib/api';
import type { Attachment } from '../../lib/stores/drafts';
import { discard, type Outgoing, resend } from '../../lib/stores/outbox';
import { AudioPlayer } from '../ui';
import { kindNames, size } from './media';

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

/**
 * The files of a message still in the outbox, from the copies the browser holds: the stored
 * message draws them from the gateway once it lands, and until then they may not even be up.
 */
export function OutgoingFiles({ files }: { files: Attachment[] }) {
  const pictures = files.filter((file) => file.kind === 'image' && file.preview);
  const others = files.filter((file) => !pictures.includes(file));

  return (
    <div className="message-media">
      {others.length > 0 && (
        <ul className="message-files" data-count={others.length} aria-label="Attachments">
          {others.map((file) => (
            <li key={file.key}>
              {file.kind === 'audio' && file.preview ? (
                <AudioPlayer src={file.preview} label={file.name} />
              ) : (
                <div className="file-card" title={file.name}>
                  <span className="file-icon" aria-hidden="true">
                    <FileText size={18} />
                  </span>
                  <span className="file-text">
                    <strong>{file.name}</strong>
                    <small>
                      {(file.mimeType && kindNames[file.mimeType]) ?? 'File'} · {size(file.bytes)}
                    </small>
                  </span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {pictures.length > 0 && (
        <div className="mosaic" data-count={Math.min(pictures.length, 4)}>
          {pictures.slice(0, 4).map((file) => (
            <div key={file.key} className="mosaic-tile">
              <img src={file.preview} alt={file.name} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** How far a message the owner wrote has got: stored by the gateway, or in the agent's context. */
export type Receipt = 'sent' | 'read';

/** Only what the agent is asked to answer: a message from the other side has no one to read it. */
export const receiptOf = (message: Message): Receipt | undefined =>
  message.role !== 'user' || message.call ? undefined : message.readAt ? 'read' : 'sent';

/** One check once the gateway has the message, two once the agent has read it, as in a chat app. */
export function MessageReceipt({ receipt }: { receipt: Receipt }) {
  const label = receipt === 'read' ? 'Read' : 'Sent';
  const Icon = receipt === 'read' ? CheckCheck : Check;

  return (
    <HoverTip tip={label} side="bottom" align="end">
      <span className="message-receipt" role="img" aria-label={label} data-receipt={receipt}>
        <Icon size={14} aria-hidden="true" />
      </span>
    </HoverTip>
  );
}
