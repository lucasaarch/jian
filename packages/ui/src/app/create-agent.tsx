'use client';

import { type FormEvent, useState } from 'react';
import { Action, Overlay, TextArea, TextField } from '../kit';
import { useCreateProfile } from '../lib/create-profile';
import { useAdoptProfile } from '../lib/workspace';
import { AgentStarters } from './agent-starters';

/** A new agent: its name and what it is for. It opens on its chats once it exists. */
export function CreateAgent({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Overlay open={open} onOpenChange={onOpenChange} title="Create an agent" size="form">
      <CreateAgentForm close={() => onOpenChange(false)} />
    </Overlay>
  );
}

function CreateAgentForm({ close }: { close: () => void }) {
  const [summary, setSummary] = useState('');
  const [instructions, setInstructions] = useState('');
  const adopt = useAdoptProfile();
  const { create, busy, error } = useCreateProfile((profile) => {
    adopt(profile, 'sessions');
    close();
  });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await create({
      name: String(form.get('name') ?? ''),
      summary,
      instructions,
    });
  };

  return (
    <form onSubmit={submit} className="grid w-full gap-5 p-7">
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
      <TextField
        label="Summary"
        name="summary"
        placeholder="What is this agent for?"
        maxLength={280}
        value={summary}
        onChange={(event) => setSummary(event.target.value)}
      />
      <AgentStarters
        choose={(starter) => {
          setSummary(starter.summary);
          setInstructions(starter.instructions);
        }}
      />
      <TextArea
        label="Instructions"
        name="instructions"
        value={instructions}
        onChange={(event) => setInstructions(event.target.value)}
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
        <Action tone="quiet" onClick={close}>
          Cancel
        </Action>
        <Action tone="primary" type="submit" busy={busy}>
          Create agent
        </Action>
      </div>
    </form>
  );
}
