'use client';

import { DEFAULT_CHANNEL_MESSAGES } from '@jian/contracts';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type { Channel } from '@/lib/api';
import { Button, Field } from '../ui';

type Messages = typeof DEFAULT_CHANNEL_MESSAGES;

const words = (text: string) =>
  text
    .split(',')
    .map((word) => word.trim())
    .filter(Boolean);

/**
 * What this channel says when the agent needs a decision or an answer, and which replies count
 * as a yes or a no. Each chat app has its own manners, so each channel keeps its own wording;
 * the words are the people's replies, so they may be in any language.
 */
export function ChannelMessages({
  channel,
  busy,
  save,
}: {
  channel: Channel;
  busy: boolean;
  save: (messages: Messages) => Promise<boolean>;
}) {
  const saved = channel.messages ?? DEFAULT_CHANNEL_MESSAGES;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({
    approval: saved.approval,
    question: saved.question,
    approveWords: saved.approveWords.join(', '),
    rejectWords: saved.rejectWords.join(', '),
  });
  const [error, setError] = useState('');
  const change = (patch: Partial<typeof draft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  return (
    <section className="channel-messages" data-open={open || undefined}>
      <button
        type="button"
        className="channel-messages-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight size={16} aria-hidden="true" />
        <span>
          <strong>Messages</strong>
          <small>What the agent sends here to ask for approval or an answer</small>
        </span>
      </button>
      {open && (
        <form
          className="channel-messages-form"
          method="post"
          action="/"
          onSubmit={async (event) => {
            event.preventDefault();
            const approveWords = words(draft.approveWords);
            const rejectWords = words(draft.rejectWords);

            if (!approveWords.length || !rejectWords.length) {
              setError('Give at least one word for yes and one for no.');
              return;
            }
            if (approveWords.some((word) => rejectWords.includes(word))) {
              setError('A word cannot mean both yes and no.');
              return;
            }
            setError('');
            await save({
              approval: draft.approval.trim(),
              question: draft.question.trim(),
              approveWords,
              rejectWords,
            });
          }}
        >
          <Field
            label="Approval request"
            hint="Placeholders: {title} {detail} {confirm} {yes} {no}"
          >
            <textarea
              required
              rows={5}
              maxLength={1000}
              value={draft.approval}
              onChange={(event) => change({ approval: event.target.value })}
            />
          </Field>
          <Field label="Question" hint="Placeholders: {prompt} {options}">
            <textarea
              required
              rows={3}
              maxLength={1000}
              value={draft.question}
              onChange={(event) => change({ question: event.target.value })}
            />
          </Field>
          <Field label="Replies that approve" hint="Separated by commas.">
            <input
              value={draft.approveWords}
              onChange={(event) => change({ approveWords: event.target.value })}
            />
          </Field>
          <Field label="Replies that decline" hint="Separated by commas.">
            <input
              value={draft.rejectWords}
              onChange={(event) => change({ rejectWords: event.target.value })}
            />
          </Field>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="channel-messages-actions">
            <Button
              variant="quiet"
              disabled={busy}
              onClick={() =>
                setDraft({
                  approval: DEFAULT_CHANNEL_MESSAGES.approval,
                  question: DEFAULT_CHANNEL_MESSAGES.question,
                  approveWords: DEFAULT_CHANNEL_MESSAGES.approveWords.join(', '),
                  rejectWords: DEFAULT_CHANNEL_MESSAGES.rejectWords.join(', '),
                })
              }
            >
              Reset to defaults
            </Button>
            <Button type="submit" busy={busy}>
              Save messages
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
