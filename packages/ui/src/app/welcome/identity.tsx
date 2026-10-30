'use client';

import { Camera } from 'lucide-react';
import { useId, useState } from 'react';
import { Action, TextArea, TextField } from '../../kit';
import { AgentHero } from '../../kit/agent-hero';
import { AVATAR_TYPES, encodeAvatar } from '../../lib/avatar';
import { AgentStarters } from '../agent-starters';

export type IdentityDraft = {
  name: string;
  summary: string;
  instructions: string;
  avatar: string | null;
};

export function WelcomeIdentity({
  draft,
  change,
  busy,
  error,
  create,
}: {
  draft: IdentityDraft;
  change: (draft: IdentityDraft) => void;
  busy: boolean;
  error: string;
  create: () => void;
}) {
  const uploadId = useId();
  const [reading, setReading] = useState(false);
  const [imageError, setImageError] = useState('');
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setImageError('');
    if (!AVATAR_TYPES.includes(file.type))
      return setImageError('Choose a PNG, JPEG or WebP picture.');
    setReading(true);
    try {
      change({ ...draft, avatar: await encodeAvatar(file) });
    } catch (failure) {
      setImageError(failure instanceof Error ? failure.message : 'The picture could not be read.');
    } finally {
      setReading(false);
    }
  };

  return (
    <div className="grid items-center gap-8 md:grid-cols-[0.9fr_1.1fr] md:gap-16">
      <div className="grid min-w-0 justify-items-center gap-5 py-5 md:sticky md:top-8 md:self-start md:py-16">
        <AgentHero
          name={draft.name || 'Your agent'}
          avatar={draft.avatar}
          summary={draft.summary || 'A name. A purpose. A beginning.'}
        />
        <label
          htmlFor={uploadId}
          className="relative inline-flex cursor-pointer items-center gap-2 rounded-full border border-glass-edge bg-glass-hover px-4 py-2 text-xs text-muted focus-within:ring-2 focus-within:ring-ink"
        >
          <Camera size={14} aria-hidden="true" />
          {reading ? 'Preparing picture…' : 'Choose a picture'}
          <input
            id={uploadId}
            type="file"
            accept={AVATAR_TYPES.join(',')}
            disabled={busy || reading}
            className="absolute inset-0 w-full cursor-pointer opacity-0"
            onChange={(event) => {
              void upload(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </label>
        {imageError && (
          <p role="alert" className="text-sm text-bad">
            {imageError}
          </p>
        )}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
        className="glass-strong grid gap-5 rounded-3xl p-6 md:p-8"
      >
        <fieldset disabled={busy || reading} className="m-0 grid min-w-0 gap-5 border-0 p-0">
          <TextField
            label="Name"
            placeholder="Mira"
            autoComplete="off"
            required
            maxLength={100}
            value={draft.name}
            onChange={(event) => change({ ...draft, name: event.target.value })}
          />
          <TextField
            label="Summary"
            placeholder="What would you like a hand with?"
            maxLength={280}
            value={draft.summary}
            onChange={(event) => change({ ...draft, summary: event.target.value })}
          />
          <AgentStarters
            choose={({ summary, instructions }) => change({ ...draft, summary, instructions })}
          />
          <TextArea
            label="Instructions"
            hint="A starting point, in your words. You can change everything later."
            placeholder="How should your agent help?"
            required
            maxLength={8000}
            rows={5}
            value={draft.instructions}
            onChange={(event) => change({ ...draft, instructions: event.target.value })}
          />
        </fieldset>
        {error && (
          <p role="alert" className="text-sm text-bad">
            {error}
          </p>
        )}
        <Action
          tone="primary"
          type="submit"
          busy={busy}
          disabled={reading || !draft.name.trim() || !draft.instructions.trim()}
          className="justify-self-end"
        >
          Create agent
        </Action>
      </form>
    </div>
  );
}
