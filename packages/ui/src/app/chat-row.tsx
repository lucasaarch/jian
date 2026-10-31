'use client';

import { ContextMenu } from '@base-ui/react/context-menu';
import { Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Spinner } from '../components/ui/spinner';
import { Action, Overlay, TextField } from '../kit';
import { MenuEntry, menuPopup } from '../kit/menu';
import { ago } from '../lib/format';

export type ChatRowProps = {
  name: string;
  /** Where it takes place: the app's own chat, or a channel's mark. A project's own chats leave
   * it out: their folder already says what they are. */
  icon?: ReactNode;
  /** When it was last spoken in, as an ISO date. */
  at: string;
  selected: boolean;
  unread: boolean;
  /** The agent is at work in it. */
  working: boolean;
  open: () => void;
  /** Absent where the name is not the chat's own: a contact's, another agent's. */
  /** Whether the name was saved. */
  rename?: (title: string) => Promise<boolean>;
  pinned?: boolean;
  pin?: () => void;
  remove: () => void;
};

/**
 * A conversation in the sidebar: its name, and at the end what it is doing, whether it is unread
 * or how long ago it was spoken in. Its actions open with a right click, or the keyboard's menu
 * key, which the system sends as the same.
 */
export function ChatRow(props: ChatRowProps) {
  const [renaming, setRenaming] = useState(false);

  const actions = (
    <>
      {props.pin && (
        <MenuEntry
          icon={props.pinned ? <PinOff size={14} /> : <Pin size={14} />}
          onClick={props.pin}
        >
          {props.pinned ? 'Unpin' : 'Pin'}
        </MenuEntry>
      )}
      {props.rename && (
        <MenuEntry icon={<Pencil size={14} />} onClick={() => setRenaming(true)}>
          Rename
        </MenuEntry>
      )}
      <MenuEntry icon={<Trash2 size={14} />} onClick={props.remove} danger>
        Delete
      </MenuEntry>
    </>
  );

  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger
          render={<li />}
          className="relative rounded-lg data-popup-open:bg-glass-hover"
        >
          <button
            type="button"
            onClick={props.open}
            aria-current={props.selected ? 'page' : undefined}
            className="flex h-8 w-full items-center gap-2 rounded-lg pr-12 pl-2.5 text-left text-[13px] text-ink transition-colors hover:bg-glass-hover aria-[current=page]:bg-glass-press phone:h-10 phone:text-sm"
          >
            {props.icon && (
              <span
                className="grid size-4 shrink-0 place-items-center text-muted"
                aria-hidden="true"
              >
                {props.icon}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">{props.name}</span>
          </button>
          <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[11px] text-muted tabular-nums">
            <Status {...props} />
          </span>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="z-50">
            <ContextMenu.Popup className={menuPopup}>{actions}</ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {props.rename && (
        <RenameDialog
          open={renaming}
          onOpenChange={setRenaming}
          name={props.name}
          rename={props.rename}
        />
      )}
    </>
  );
}

/** At work, unread, or how long ago: the one that says the most. */
function Status({ at, unread, working, selected }: ChatRowProps) {
  if (working) {
    return (
      <span role="status" aria-label="Working" className="grid size-4 place-items-center">
        <Spinner size={13} />
      </span>
    );
  }
  if (unread && !selected) {
    return <span role="img" aria-label="Unread" className="size-2 rounded-full bg-accent" />;
  }
  return <time dateTime={at}>{ago(at)}</time>;
}

/**
 * The chat's name in a dialog, chosen whole to be typed over: Enter keeps it, Escape leaves it as
 * it was. A dialog, as a field in the row lost its focus to the row the moment the menu closed,
 * and ended before anything could be typed. It stays open when the name could not be saved.
 */
export function RenameDialog({
  open,
  onOpenChange,
  name,
  rename,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  rename: (title: string) => Promise<boolean>;
}) {
  return (
    <Overlay open={open} onOpenChange={onOpenChange} title="Rename chat" size="form">
      {open && <RenameForm name={name} rename={rename} close={() => onOpenChange(false)} />}
    </Overlay>
  );
}

function RenameForm({
  name,
  rename,
  close,
}: {
  name: string;
  rename: (title: string) => Promise<boolean>;
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
      <h2 className="pr-6 text-lg font-semibold tracking-tight">Rename chat</h2>
      <TextField
        label="Name"
        value={title}
        maxLength={160}
        autoComplete="off"
        onChange={(event) => setTitle(event.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Action tone="quiet" onClick={close}>
          Cancel
        </Action>
        <Action tone="primary" type="submit" busy={busy} disabled={!title.trim()}>
          Save
        </Action>
      </div>
    </form>
  );
}
