'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useId, useRef } from 'react';
import { Action, iconButton, SwitchControl, surfaceCard, TextField } from '../../kit';
import {
  blankField,
  envNameOf,
  type FieldDraft,
  type FieldProblems,
  MAX_FIELDS,
} from './secret-form';

/**
 * A Secret's fields, each an environment variable a command gets: what it is, the variable's name
 * and its value. A sensitive value is typed into a password field and never shown again; editing,
 * it starts empty and is kept unless another is typed. A plain one, such as a login, shows.
 */
export function SecretFields({
  fields,
  problems,
  keeps,
  busy,
  onChange,
}: {
  fields: FieldDraft[];
  problems: FieldProblems[];
  /** Whether the gateway holds a value this field keeps when it is left empty. */
  keeps: (field: FieldDraft) => boolean;
  busy: boolean;
  onChange: (fields: FieldDraft[]) => void;
}) {
  const ids = useId();
  const update = (index: number, patch: Partial<FieldDraft>) =>
    onChange(fields.map((field, at) => (at === index ? { ...field, ...patch } : field)));
  // A field has no identity of its own while its variable is typed: each row gets a key when it
  // is added and gives it up when it is removed, so the rows after it keep theirs.
  const made = useRef(0);
  const keys = useRef<number[]>([]);
  while (keys.current.length < fields.length) keys.current.push(made.current++);
  keys.current.length = fields.length;
  const remove = (index: number) => {
    keys.current.splice(index, 1);
    onChange(fields.filter((_, at) => at !== index));
  };

  return (
    <div className="grid gap-2">
      <span className="text-[13px] font-medium text-ink">Fields</span>
      <ul className="grid gap-2">
        {fields.map((field, index) => {
          const problem = problems[index] ?? {};
          const sensitiveId = `${ids}-${keys.current[index]}-sensitive`;
          const kept = keeps(field);
          return (
            <li key={keys.current[index]} className={`${surfaceCard} grid gap-3 p-4`}>
              <div className="grid grid-cols-2 gap-3 phone:grid-cols-1">
                <TextField
                  label="Label"
                  value={field.label}
                  onChange={(event) => update(index, { label: event.target.value })}
                  placeholder={field.sensitive ? 'Password' : 'Login'}
                  maxLength={60}
                  autoComplete="off"
                />
                <TextField
                  label="Variable"
                  hint={problem.envName}
                  value={field.envName}
                  onChange={(event) => update(index, { envName: envNameOf(event.target.value) })}
                  placeholder="MAIL_PASSWORD"
                  aria-invalid={Boolean(problem.envName)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <TextField
                label="Value"
                hint={
                  problem.value ??
                  (!field.sensitive
                    ? 'Not sensitive: the agent can read it. For a login, never a password.'
                    : kept
                      ? 'Leave it empty to keep the value you saved. Nobody can read it back.'
                      : 'Saved encrypted and masked in every output. Nobody can read it back.')
                }
                type={field.sensitive ? 'password' : 'text'}
                value={field.value}
                onChange={(event) => update(index, { value: event.target.value })}
                placeholder={kept && !field.value ? 'Saved' : ''}
                aria-invalid={Boolean(problem.value)}
                autoComplete={field.sensitive ? 'new-password' : 'off'}
                spellCheck={false}
              />
              <div className="flex items-center gap-2">
                <SwitchControl
                  checked={field.sensitive}
                  onCheckedChange={(sensitive) => update(index, { sensitive })}
                  labelledBy={sensitiveId}
                  disabled={busy}
                />
                <span id={sensitiveId} className="text-[13px] text-ink">
                  Sensitive
                </span>
                <span className="flex-1" />
                {fields.length > 1 && (
                  <button
                    type="button"
                    className={iconButton}
                    aria-label={`Remove ${field.label.trim() || 'this field'}`}
                    disabled={busy}
                    onClick={() => remove(index)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex items-start justify-between gap-4">
        <small className="min-w-0 text-xs leading-snug text-muted">
          A command that asks for one variable gets every field of the Secret.
        </small>
        <Action
          tone="outline"
          size="small"
          className="shrink-0"
          disabled={busy || fields.length >= MAX_FIELDS}
          onClick={() => onChange([...fields, blankField()])}
        >
          <Plus size={13} />
          Add a field
        </Action>
      </div>
    </div>
  );
}
