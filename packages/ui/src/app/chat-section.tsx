'use client';

import { Plus } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { GitHubLogo } from '../components/ui';
import { Fold, FoldChevron } from '../kit';
import { useLayout } from '../lib/stores/layout';

/** How many chats a list shows before the rest wait behind "Show more". */
const FIRST = 8;

/** Whether a section or folder is folded, kept with the layout. */
function useFolded(id: string) {
  const closed = useLayout((state) => state.closedSections.includes(id));
  const toggle = useLayout((state) => state.toggleSection);
  return [closed, () => toggle(id)] as const;
}

/**
 * A heading and what it lists. The heading is quiet, never lit under the pointer as a row is;
 * under the pointer a chevron beside its name says whether it is open, and folding it is kept.
 * A section with a way to start a chat in it shows that at its end.
 */
export function ChatSection({
  id,
  name,
  children,
  empty,
  newChat,
}: {
  id: string;
  name: string;
  children: ReactNode[];
  /** Said in a section with nothing in it yet; absent, an empty section says nothing. */
  empty?: string;
  newChat?: { label: string; start: () => void };
}) {
  const [closed, toggle] = useFolded(id);
  const list = useId();

  return (
    <section className="flex min-w-0 flex-col">
      <div className="group relative">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!closed}
          aria-controls={list}
          className="flex h-7 w-full min-w-0 items-center gap-1 pr-8 pl-2.5 text-left text-xs font-medium text-muted transition-colors hover:text-ink"
        >
          <span className="min-w-0 truncate">{name}</span>
          <FoldChevron
            open={!closed}
            className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
          />
        </button>
        {newChat && (
          <span className="absolute inset-y-0 right-1 flex items-center">
            <NewChatButton {...newChat} />
          </span>
        )}
      </div>
      <Fold open={!closed} id={list}>
        <ul className="flex min-w-0 flex-col gap-px pt-px">
          <Rows rows={children} />
          {children.length === 0 && empty && (
            <li className="px-2.5 py-1 text-xs text-muted/70">{empty}</li>
          )}
        </ul>
      </Fold>
    </section>
  );
}

/**
 * A project in the Projects section: its repository's name with GitHub's mark, opening onto its
 * chats beneath it on a guide, as a tree. Folded or not, the choice is kept.
 */
export function ProjectFolder({
  id,
  name,
  rows,
  newChat,
}: {
  id: string;
  name: string;
  rows: ReactNode[];
  newChat: { label: string; start: () => void };
}) {
  const [closed, toggle] = useFolded(`project:${id}`);
  const list = useId();

  return (
    <li className="flex min-w-0 flex-col">
      <div className="group flex h-8 items-center rounded-lg pr-1 transition-colors hover:bg-glass-hover">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!closed}
          aria-controls={list}
          className="flex h-full min-w-0 flex-1 items-center gap-2 px-2.5 text-left text-[13px] text-ink"
        >
          <span className="grid size-4 shrink-0 place-items-center text-muted" aria-hidden="true">
            <GitHubLogo size={13} />
          </span>
          <span className="truncate">{name}</span>
          <FoldChevron
            open={!closed}
            className="text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
          />
        </button>
        <NewChatButton {...newChat} />
      </div>
      <Fold open={!closed} id={list}>
        {/* A guide down from the project's mark, and the chats beside it, their names under
            the project's own. */}
        <ul className="ml-4.5 flex min-w-0 flex-col gap-px border-l border-glass-edge pt-px pl-0.75 [&>li>button:first-child]:pl-3">
          <Rows rows={rows} />
        </ul>
      </Fold>
    </li>
  );
}

function NewChatButton({ label, start }: { label: string; start: () => void }) {
  return (
    <button
      type="button"
      onClick={start}
      aria-label={label}
      title={label}
      className="grid size-6 place-items-center rounded-md text-muted opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-glass-press hover:text-ink focus-visible:opacity-100"
    >
      <Plus size={13} />
    </button>
  );
}

/** The first few rows, and a way to the rest. */
function Rows({ rows }: { rows: ReactNode[] }) {
  const [all, setAll] = useState(false);
  return (
    <>
      {all ? rows : rows.slice(0, FIRST)}
      {rows.length > FIRST && (
        <li>
          <button
            type="button"
            onClick={() => setAll(!all)}
            className="h-7 w-full rounded-lg px-2.5 text-left text-xs text-muted hover:bg-glass-hover hover:text-ink"
          >
            {all ? 'Show less' : `Show ${rows.length - FIRST} more`}
          </button>
        </li>
      )}
    </>
  );
}
