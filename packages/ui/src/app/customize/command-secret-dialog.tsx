'use client';

import { commandSecretNameSchema } from '@jian/contracts';
import { type FormEvent, useEffect, useState } from 'react';
import { Action, MultiSelectField, Overlay, OverlayActions, TextArea, TextField } from '../../kit';
import type { CommandSecret, CommandSecretPatch, NewCommandSecret } from '../../lib/api';
import { useProfiles } from '../../lib/query/profile';

/**
 * Adds a secret, or edits one: what it is for, which other agents may use it, and a new value in
 * place of the one kept. A value is typed here and never shown again, by this screen or any other,
 * so the field for it starts empty every time.
 */
export function CommandSecretDialog({
  open,
  onOpenChange,
  profileId,
  editing,
  busy,
  add,
  change,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profileId: string;
  /** The secret edited; none to add one. */
  editing?: CommandSecret;
  busy: boolean;
  add: (body: NewCommandSecret) => Promise<boolean>;
  change: (name: string, body: CommandSecretPatch) => Promise<boolean>;
}) {
  const agents = useProfiles().data ?? [];
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const [others, setOthers] = useState<string[]>([]);

  // Each opening starts from the secret as it is, and with no value typed.
  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setValue('');
    setDescription(editing?.description ?? '');
    setOthers(editing?.profileIds.filter((id) => id !== profileId) ?? []);
  }, [open, editing, profileId]);

  const named = commandSecretNameSchema.safeParse(name);
  const nameProblem =
    !editing && name && !named.success ? named.error.issues[0]?.message : undefined;
  // What the gateway would refuse anyway, said before it is sent; it trims nothing of a value.
  const typed = value.trim();
  const valueProblem =
    typed && typed.length < 8 ? 'A secret has at least 8 characters.' : undefined;
  const ready = editing ? !valueProblem : named.success && typed.length >= 8;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ready) return;
    const done = editing
      ? await change(editing.name, {
          description: description.trim() || null,
          profileIds: [profileId, ...others],
          ...(typed ? { value: typed } : {}),
        })
      : await add({
          name,
          value: typed,
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(others.length ? { profileIds: others } : {}),
        });
    if (done) onOpenChange(false);
  };

  const title = editing ? editing.name : 'Add a command secret';
  const options = agents
    .filter((agent) => agent.id !== profileId)
    .map((agent) => ({ value: agent.id, label: agent.name }));

  return (
    <Overlay open={open} onOpenChange={onOpenChange} title={title} size="form">
      <form onSubmit={submit} className="grid w-full gap-5 p-7">
        <header className="grid gap-1 pr-10">
          <h2 className="truncate text-xl font-semibold tracking-tight">{title}</h2>
          <p className="text-sm text-muted">
            A command the agent runs gets it as an environment variable of this name, only when it
            asks for it, and only after you approve where the conversation asks first. The agent
            never sees the value.
          </p>
        </header>
        {!editing && (
          <TextField
            label="Name"
            hint={nameProblem ?? 'As the command reads it, such as ASSEMBLYAI_API_KEY.'}
            value={name}
            onChange={(event) => setName(event.target.value.toUpperCase().replace(/[\s-]/g, '_'))}
            placeholder="ASSEMBLYAI_API_KEY"
            aria-invalid={Boolean(nameProblem)}
            required
            autoComplete="off"
            spellCheck={false}
          />
        )}
        <TextField
          label={editing ? 'Replace value' : 'Value'}
          hint={
            valueProblem ??
            (editing
              ? 'Leave it empty to keep the value you saved. Nobody can read it back.'
              : 'Saved encrypted. Nobody can read it back, you included.')
          }
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-invalid={Boolean(valueProblem)}
          required={!editing}
          autoComplete="new-password"
          spellCheck={false}
        />
        <TextArea
          label="What it is for"
          hint="The agent reads this to know when to use it."
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={300}
          placeholder="AssemblyAI, for word timings of a recording"
        />
        {options.length > 0 && (
          <MultiSelectField
            label="Other agents that may use it"
            hint="This agent always may."
            values={others}
            options={options}
            onValuesChange={setOthers}
            placeholder="Only this agent"
          />
        )}
        <OverlayActions>
          <Action tone="quiet" onClick={() => onOpenChange(false)}>
            Cancel
          </Action>
          <Action tone="primary" type="submit" busy={busy} disabled={!ready}>
            {editing ? 'Save' : 'Add secret'}
          </Action>
        </OverlayActions>
      </form>
    </Overlay>
  );
}
