'use client';

import { ContextMenu } from '@base-ui/react/context-menu';
import { Cloud, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Spinner } from '../components/ui/spinner';
import { Action, ConfirmDialog, Overlay, OverlayActions, TextField } from '../kit';
import { MenuEntry, menuPopup } from '../kit/menu';
import { ago } from '../lib/format';

export type ChatRowProps = {
  name: string;
  /** Where it takes place: the app's own chat, or a channel's mark. A project's own chats leave
   * it out: their folder already says what they are. */
  icon?: ReactNode;
  /** Under a folder: its name lines up with the folder's, and where the folder's mark is, a dot
   * says how it stands while it is open or the pointer is on it. */
  nested?: boolean;
  /** When it was last spoken in, as an ISO date. */
  at: string;
  selected: boolean;
  unread: boolean;
  /** The agent is at work in it. */
  working: boolean;
  /** Worked on somewhere other than this computer. */
  remote?: boolean;
  open: () => void;
  /** Absent where the name is not the chat's own: a contact's, another agent's. */
  /** Whether the name was saved. */
  rename?: (title: string) => Promise<boolean>;
  pinned?: boolean;
  pin?: () => void;
  /** Whether it was deleted. Only ever called once the owner has said yes. */
  remove: () => Promise<boolean>;
  /** What else deleting it costs, read when the owner is asked. */
  loss?: ReactNode;
};

/**
 * A conversation in the sidebar: its name, and at the end what it is doing, whether it is unread
 * or how long ago it was spoken in. Its actions open with a right click, or the keyboard's menu
 * key, which the system sends as the same.
 */
export function ChatRow(props: ChatRowProps) {
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
      <MenuEntry icon={<Trash2 size={14} />} onClick={() => setDeleting(true)} danger>
        Delete
      </MenuEntry>
    </>
  );

  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger
          render={<li />}
          className="group/row relative rounded-lg data-popup-open:bg-glass-hover"
        >
          <button
            type="button"
            onClick={props.open}
            aria-current={props.selected ? 'page' : undefined}
            className={`flex h-8 w-full items-center gap-2 rounded-lg ${props.remote ? 'pr-17' : 'pr-12'} ${props.nested ? 'pl-8.5' : 'pl-2.5'} text-left text-[13px] text-ink transition-colors hover:bg-glass-hover aria-[current=page]:bg-glass-press phone:h-10 phone:text-sm`}
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
          {props.nested && (
            <span
              aria-hidden="true"
              className={`pointer-events-none absolute top-1/2 left-3.75 size-1.5 -translate-y-1/2 rounded-full transition-opacity ${props.selected ? '' : 'opacity-0 group-hover/row:opacity-100'} ${dot(props)}`}
            />
          )}
          <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[11px] text-muted tabular-nums">
            {props.remote && (
              <Cloud size={13} className="mr-1.5 text-muted" role="img" aria-label="Remote" />
            )}
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
      <DeleteChatDialog
        open={deleting}
        onOpenChange={setDeleting}
        name={props.name}
        remove={props.remove}
        {...(props.loss ? { loss: props.loss } : {})}
      />
    </>
  );
}

/** Asks before a chat is deleted. It stays open when the chat could not be deleted. */
export function DeleteChatDialog({
  open,
  onOpenChange,
  name,
  remove,
  loss,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  remove: () => Promise<boolean>;
  /** Rendered only while the question is open, so what it reads is asked for then. */
  loss?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete ${name}?`}
      action="Delete chat"
      busy={busy}
      run={async () => {
        setBusy(true);
        const deleted = await remove();
        setBusy(false);
        if (deleted) onOpenChange(false);
      }}
    >
      The chat and everything said in it are gone for good. {loss}
    </ConfirmDialog>
  );
}

/** At work, unread, or how long ago: the one that says the most. */
/** How a chat stands, as the colour of its dot: the end of the row says the same in words. */
function dot({ unread, working, selected }: ChatRowProps): string {
  if (working) return 'bg-good';
  return unread && !selected ? 'bg-accent' : 'bg-muted';
}

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
      <h2 className="pr-10 text-lg font-semibold tracking-tight">Rename chat</h2>
      <TextField
        label="Name"
        value={title}
        maxLength={160}
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
