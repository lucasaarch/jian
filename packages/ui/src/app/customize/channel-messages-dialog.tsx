'use client';

import { useState } from 'react';
import {
  defaultDraft,
  type MessagesDraft,
  messagesOf,
  savedDraft,
} from '../../components/channels/message-draft';
import type { SectionActions } from '../../components/props';
import { Action, Overlay, TextArea, TextField } from '../../kit';
import type { Channel } from '../../lib/api';
import { useAgent } from '../../lib/query/agent';

/**
 * What a chat channel says when the agent needs a decision or an answer, and which replies count
 * as a yes or a no. Each chat app has its own manners, so each channel keeps its own wording.
 * The form is drawn again on each opening, so nothing typed outlives a cancel.
 */
export function ChannelMessagesDialog({
  open,
  onOpenChange,
  round,
  channel,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Changes on every opening, so each starts from what the channel says now. */
  round: number;
  channel: Channel;
  actions: SectionActions;
}) {
  return (
    <Overlay open={open} onOpenChange={onOpenChange} title="Messages" size="form">
      <MessagesForm
        key={round}
        channel={channel}
        actions={actions}
        close={() => onOpenChange(false)}
      />
    </Overlay>
  );
}

function MessagesForm({
  channel,
  actions: { api, mutate, busy },
  close,
}: {
  channel: Channel;
  actions: SectionActions;
  close: () => void;
}) {
  const profile = useAgent();
  const [draft, setDraft] = useState<MessagesDraft>(() => savedDraft(channel));
  const [error, setError] = useState('');
  const field = (key: keyof MessagesDraft) => ({
    value: draft[key],
    onChange: (event: { target: { value: string } }) =>
      setDraft((current) => ({ ...current, [key]: event.target.value })),
  });

  return (
    <form
      className="grid w-full gap-5 p-7"
      onSubmit={async (event) => {
        event.preventDefault();
        const result = messagesOf(draft);
        if ('error' in result) {
          setError(result.error);
          return;
        }
        setError('');
        const saved = await mutate(
          () => api.updateChannel(profile.id, channel.id, { messages: result.messages }),
          'Messages saved.',
        );
        if (saved) close();
      }}
    >
      <header className="grid gap-1.5 pr-6">
        <h2 className="text-lg font-semibold tracking-tight">Messages</h2>
        <p className="text-sm leading-relaxed text-muted">
          What the agent sends here to ask for approval or an answer.
        </p>
      </header>
      <TextArea
        label="Approval request"
        hint="Placeholders: {title} {detail} {confirm} {yes} {no}"
        required
        rows={5}
        maxLength={1000}
        {...field('approval')}
      />
      <TextArea
        label="Question"
        hint="Placeholders: {prompt} {options}"
        required
        rows={3}
        maxLength={1000}
        {...field('question')}
      />
      <TextField
        label="Replies that approve"
        hint="Separated by commas, in any language."
        {...field('approveWords')}
      />
      <TextField
        label="Replies that decline"
        hint="Separated by commas."
        {...field('rejectWords')}
      />
      {error && (
        <p role="alert" className="text-[13px] text-bad">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Action tone="outline" disabled={busy} onClick={() => setDraft(defaultDraft())}>
          Reset to defaults
        </Action>
        <span className="flex-1" />
        <Action tone="quiet" onClick={close}>
          Cancel
        </Action>
        <Action tone="primary" type="submit" busy={busy}>
          Save
        </Action>
      </div>
    </form>
  );
}
