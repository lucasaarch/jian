'use client';

import { type FormEvent, useState } from 'react';
import { Action, Overlay, TextArea, TextField } from '../kit';
import { panelApi } from '../lib/query/client';
import { useAdoptProfile } from '../lib/workspace';

/** A new agent: its name and what it is for. It opens on its chats once it exists. */
export function CreateAgent({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const adopt = useAdoptProfile();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const created = await panelApi().createProfile({
        name: String(form.get('name') ?? ''),
        instructions: String(form.get('instructions') ?? ''),
      });
      adopt(created, 'sessions');
      onOpenChange(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The agent could not be created.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay open={open} onOpenChange={onOpenChange} title="Create an agent">
      <form onSubmit={submit} className="m-auto grid w-full max-w-md gap-5 p-8">
        <header className="grid gap-1">
          <h2 className="text-xl font-semibold tracking-tight">Create an agent</h2>
          <p className="text-sm text-muted">
            Who it is and what it is for; everything else can wait.
          </p>
        </header>
        <TextField
          label="Name"
          name="name"
          placeholder="Personal assistant"
          required
          maxLength={100}
          autoComplete="off"
        />
        <TextArea
          label="Instructions"
          name="instructions"
          placeholder="Help me organise my tasks and keep track of decisions."
          required
          maxLength={8000}
        />
        {error && (
          <p role="alert" className="text-sm text-bad">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Action tone="quiet" onClick={() => onOpenChange(false)}>
            Cancel
          </Action>
          <Action tone="primary" type="submit" busy={busy}>
            Create agent
          </Action>
        </div>
      </form>
    </Overlay>
  );
}
