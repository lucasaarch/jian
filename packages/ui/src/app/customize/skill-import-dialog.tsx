'use client';

import { type FormEvent, useState } from 'react';
import { skillImportHint, skillImportPlaceholder } from '../../components/skills/skill-fields';
import { Action, Overlay, TextField } from '../../kit';

/**
 * Copies a skill, or a folder of them, from GitHub into the agent's own. The address is
 * forgotten once it is imported, so the next opening starts empty.
 */
export function SkillImportDialog({
  open,
  onOpenChange,
  busy,
  importFrom,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  importFrom: (url: string) => Promise<boolean>;
}) {
  const [url, setUrl] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!url.trim()) return;
    if (await importFrom(url)) {
      setUrl('');
      onOpenChange(false);
    }
  };

  return (
    <Overlay open={open} onOpenChange={onOpenChange} title="Import from GitHub" size="form">
      <form className="grid w-full gap-5 p-7" onSubmit={submit}>
        <header className="grid gap-1.5 pr-6">
          <h2 className="text-lg font-semibold tracking-tight">Import from GitHub</h2>
          <p className="text-sm text-muted">Each agent keeps its own copy.</p>
        </header>
        <TextField
          label="Address"
          hint={skillImportHint}
          type="url"
          inputMode="url"
          required
          placeholder={skillImportPlaceholder}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="flex items-center gap-2">
          <span className="flex-1" />
          <Action tone="quiet" onClick={() => onOpenChange(false)}>
            Cancel
          </Action>
          <Action tone="primary" type="submit" busy={busy} disabled={!url.trim()}>
            Import
          </Action>
        </div>
      </form>
    </Overlay>
  );
}
