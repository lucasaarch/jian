'use client';

import { ContextMenu } from '@base-ui/react/context-menu';
import { Pencil, Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
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
  rename?: (title: string) => Promise<void>;
  remove: () => void;
};

/**
 * A conversation in the sidebar: its name, and at the end what it is doing, whether it is unread
 * or how long ago it was spoken in. Its actions open with a right click, or the keyboard's menu
 * key, which the system sends as the same.
 */
export function ChatRow(props: ChatRowProps) {
  const [renaming, setRenaming] = useState(false);

  if (renaming && props.rename) {
    return <RenameRow name={props.name} rename={props.rename} done={() => setRenaming(false)} />;
  }

  const actions = (
    <>
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
            <span className="grid size-4 shrink-0 place-items-center text-muted" aria-hidden="true">
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
  );
}

/** At work, unread, or how long ago: the one that says the most. */
function Status({ at, unread, working, selected }: ChatRowProps) {
  if (working) {
    return (
      <span
        role="img"
        aria-label="Working"
        className="size-2 animate-pulse rounded-full bg-ink/70"
      />
    );
  }
  if (unread && !selected) {
    return <span role="img" aria-label="Unread" className="size-2 rounded-full bg-accent" />;
  }
  return <time dateTime={at}>{ago(at)}</time>;
}

/** The row as a field: Enter or leaving it keeps the name, Escape leaves it as it was. */
function RenameRow({
  name,
  rename,
  done,
}: {
  name: string;
  rename: (title: string) => Promise<void>;
  done: () => void;
}) {
  const [title, setTitle] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  // Settled once: Escape, then the blur of the field going away, must not save after all.
  const settled = useRef(false);
  const finish = (keep: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const next = title.trim();
    done();
    if (keep && next && next !== name) void rename(next);
  };

  useEffect(() => input.current?.select(), []);

  return (
    <li>
      <input
        aria-label="Chat name"
        value={title}
        maxLength={160}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') finish(true);
          if (event.key === 'Escape') finish(false);
        }}
        ref={input}
        className="h-8 w-full rounded-lg border border-glass-edge bg-glass-press px-2.5 py-0 text-[13px] text-ink"
      />
    </li>
  );
}
