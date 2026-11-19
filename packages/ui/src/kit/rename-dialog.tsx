'use client';

import { useEffect, useRef, useState } from 'react';
import { Action } from './action';
import { Overlay, OverlayActions } from './overlay';
import { TextField } from './text-field';

/**
 * How something is renamed: a chat by its title, a person by their name, an Artifact or a
 * folder of them by its own, a provider's account by what the owner calls it.
 */
export type Renaming = {
  what: 'chat' | 'contact' | 'Artifact' | 'folder' | 'account';
  /** The dialog's heading where it names something new rather than renames it. */
  heading?: string;
  /** The longest name the gateway keeps for it. */
  maxLength: number;
  /** Whether the name was saved. */
  rename: (title: string) => Promise<boolean>;
};

/**
 * A name in a dialog, chosen whole to be typed over: Enter keeps it, Escape leaves it as
 * it was. A dialog, as a field in the row lost its focus to the row the moment the menu closed,
 * and ended before anything could be typed. It stays open when the name could not be saved.
 */
export function RenameDialog({
  open,
  onOpenChange,
  name,
  renaming,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  renaming: Renaming;
}) {
  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      title={renaming.heading ?? `Rename ${renaming.what}`}
      size="form"
    >
      {open && <RenameForm name={name} renaming={renaming} close={() => onOpenChange(false)} />}
    </Overlay>
  );
}

function RenameForm({
  name,
  renaming: { what, heading = `Rename ${what}`, maxLength, rename },
  close,
}: {
  name: string;
  renaming: Renaming;
  close: () => void;
}) {
  const [title, setTitle] = useState(name);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => form.current?.querySelector('input')?.select(), []);

  return (
    <form
      ref={form}
      className="grid w-full gap-5 p-7"
      onSubmit={async (event) => {
        event.preventDefault();
        const next = title.trim();
        if (!next || next === name) return close();
        setBusy(true);
        const saved = await rename(next);
        setBusy(false);
        if (saved) close();
      }}
    >
      <h2 className="pr-10 text-lg font-semibold tracking-tight">{heading}</h2>
      <TextField
        label="Name"
        value={title}
        maxLength={maxLength}
        autoComplete="off"
        onChange={(event) => setTitle(event.target.value)}
      />
      <OverlayActions>
        <Action tone="quiet" onClick={close}>
          Cancel
        </Action>
        <Action tone="primary" type="submit" busy={busy} disabled={!title.trim()}>
          Save
        </Action>
      </OverlayActions>
    </form>
  );
}
