'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { Action, MultiSelectField, Overlay, OverlayActions, TextArea, TextField } from '../../kit';
import type { NewSecret, Secret, SecretPatch } from '../../lib/api';
import { useProfiles } from '../../lib/query/profile';
import { SecretFields } from './secret-fields';
import {
  draftOf,
  fieldProblems,
  keepsValue,
  newSecretOf,
  patchOf,
  ready,
  type SecretDraft,
  sharesOf,
  siteChecks,
} from './secret-form';
import { SecretSites } from './secret-sites';

/**
 * Adds a Secret, or edits one: what it is, its fields, the sites it is for and which other agents
 * may use it. A sensitive value is typed here and never shown again, by this screen or any other,
 * so its field starts empty every time and is kept unless another is typed.
 */
export function SecretDialog({
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
  /** The Secret edited; none to add one. */
  editing?: Secret;
  busy: boolean;
  add: (body: NewSecret) => Promise<boolean>;
  change: (secretId: string, body: SecretPatch) => Promise<boolean>;
}) {
  const agents = useProfiles().data ?? [];
  const [draft, setDraft] = useState<SecretDraft>(() => draftOf(editing, profileId));
  const set = (patch: Partial<SecretDraft>) => setDraft((current) => ({ ...current, ...patch }));

  // Each opening starts from the Secret as it is, with no sensitive value typed.
  useEffect(() => {
    if (open) setDraft(draftOf(editing, profileId));
  }, [open, editing, profileId]);

  const canSave = ready(draft, editing);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave) return;
    const done = editing
      ? await change(editing.id, patchOf(draft, editing, profileId))
      : await add(newSecretOf(draft));
    if (done) onOpenChange(false);
  };

  const title = editing ? editing.title : 'Add a Secret';
  const options = agents
    .filter((agent) => agent.id !== profileId)
    .map((agent) => ({ value: agent.id, label: agent.name }));
  const shares = sharesOf(editing, agents);

  return (
    <Overlay open={open} onOpenChange={onOpenChange} title={title} size="form">
      <form onSubmit={submit} className="grid w-full gap-5 p-7">
        <header className="grid gap-1 pr-10">
          <h2 className="truncate text-xl font-semibold tracking-tight">{title}</h2>
          <p className="text-sm text-muted">
            A command the agent runs gets each field as an environment variable, only when it asks
            for it, and only after you approve where the conversation asks first. The agent never
            sees a sensitive value.
          </p>
        </header>
        <TextField
          label="Title"
          value={draft.title}
          onChange={(event) => set({ title: event.target.value })}
          maxLength={80}
          placeholder="Support inbox"
          required
          autoComplete="off"
        />
        <TextArea
          label="What it is for"
          hint="The agent reads this to know when to use it."
          value={draft.description}
          onChange={(event) => set({ description: event.target.value })}
          maxLength={300}
          placeholder="The support inbox, to read and answer customer mail"
        />
        <SecretFields
          fields={draft.fields}
          problems={fieldProblems(draft.fields)}
          keeps={(field) => keepsValue(field, editing)}
          busy={busy}
          onChange={(fields) => set({ fields })}
        />
        <SecretSites
          sites={draft.sites}
          problems={siteChecks(draft.sites).map((check) => check.problem)}
          busy={busy}
          onChange={(sites) => set({ sites })}
        />
        {options.length > 0 && (
          <MultiSelectField
            label="Other agents that may use it"
            hint="This agent always may."
            values={draft.others}
            options={options}
            onValuesChange={(others) => set({ others })}
            placeholder="Only this agent"
          />
        )}
        {shares.length > 0 && (
          <ul className="grid gap-0.5 text-xs leading-snug text-muted">
            {shares.map((share) => (
              <li key={share}>{share}</li>
            ))}
          </ul>
        )}
        <OverlayActions>
          <Action tone="quiet" onClick={() => onOpenChange(false)}>
            Cancel
          </Action>
          <Action tone="primary" type="submit" busy={busy} disabled={!canSave}>
            {editing ? 'Save' : 'Add secret'}
          </Action>
        </OverlayActions>
      </form>
    </Overlay>
  );
}
