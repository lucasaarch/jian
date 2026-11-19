'use client';

import { ContextMenu } from '@base-ui/react/context-menu';
import { Cloud, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Spinner } from '../components/ui/spinner';
import { ConfirmDialog, RenameDialog, type Renaming } from '../kit';
import { MenuEntry, menuPopup } from '../kit/menu';
import { ago } from '../lib/format';

export type ChatRowProps = {
  name: string;
  /** Where it takes place: the app's own chat, or a channel's mark. A project's own chats leave
   * it out: their folder already says what they are. */
  icon?: ReactNode;
  /** Under a folder: its name lines up with the folder's, and the place of the folder's mark
   * stays empty until the chat has something to tell. */
  nested?: boolean;
  /** When it was last spoken in, as an ISO date. */
  at: string;
  selected: boolean;
  unread: boolean;
  /** The agent is at work in it. */
  working: boolean;
  /** The agent stopped for the owner here: an approval to give, a question to answer. */
  waiting?: boolean;
  /** Worked on somewhere other than this computer. */
  remote?: boolean;
  open: () => void;
  /** Absent where the name is not the conversation's to change: a group's, another agent's. */
  renaming?: Renaming | undefined;
  pinned?: boolean;
  pin?: () => void;
  /** Whether it was deleted. Only ever called once the owner has said yes. */
  remove: () => Promise<boolean>;
  /** What else deleting it costs, read when the owner is asked. */
  loss?: ReactNode;
};

/**
 * A conversation in the sidebar: before its name how it stands, when there is something to
 * tell, and at the end how long ago it was spoken in. Its actions open with a right click, or
 * the keyboard's menu key, which the system sends as the same.
 */
export function ChatRow(props: ChatRowProps) {
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const standing = standingOf(props);

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
      {props.renaming && (
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
                {!standing && props.icon}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">{props.name}</span>
          </button>
          {/* Where the row's icon is, or a folder's mark above a nested row: the same box. */}
          {standing && (
            <span className="pointer-events-none absolute top-1/2 left-2.5 grid size-4 -translate-y-1/2 place-items-center">
              <Standing is={standing} />
            </span>
          )}
          <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[11px] text-muted tabular-nums">
            {props.remote && (
              <Cloud size={13} className="mr-1.5 text-muted" role="img" aria-label="Remote" />
            )}
            <time dateTime={props.at}>{ago(props.at)}</time>
          </span>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="z-50">
            <ContextMenu.Popup className={menuPopup}>{actions}</ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {props.renaming && (
        <RenameDialog
          open={renaming}
          onOpenChange={setRenaming}
          name={props.name}
          renaming={props.renaming}
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

type Standing = 'waiting' | 'working' | 'unread';

/**
 * What a chat has to tell, the most pressing first. Waiting on the owner comes before work
 * still going on beside it, as it goes no further without them, and holds whether the chat is
 * open or read: only the answer ends it. An unread answer is told until the chat is opened.
 */
function standingOf({ waiting, working, unread, selected }: ChatRowProps): Standing | undefined {
  if (waiting) return 'waiting';
  if (working) return 'working';
  return unread && !selected ? 'unread' : undefined;
}

/** At work, it turns; otherwise a dot whose colour says which news it is. */
function Standing({ is }: { is: Standing }) {
  if (is === 'working') {
    return (
      <span role="status" aria-label="Working" className="grid size-4 place-items-center">
        <Spinner size={14} />
      </span>
    );
  }
  return is === 'waiting' ? (
    <span role="img" aria-label="Waiting for you" className="size-1.5 rounded-full bg-warn" />
  ) : (
    <span role="img" aria-label="Unread" className="size-1.5 rounded-full bg-accent" />
  );
}
