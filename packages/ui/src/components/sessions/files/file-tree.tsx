'use client';

import { File, Folder } from 'lucide-react';
import { FoldChevron } from '../../../kit';
import {
  type ChangeMark,
  type ChangeStatus,
  markOf,
  type TreeFile,
  type TreeFolder,
  type TreeRow,
} from './tree';

export const markTone: Record<ChangeMark['tone'], string> = {
  good: 'text-good',
  warn: 'text-warn',
  bad: 'text-bad',
  merged: 'text-merged',
};

const row =
  'flex h-7 w-full min-w-0 items-center gap-1.5 rounded-lg pr-2 text-left text-[13px] transition-colors hover:bg-glass-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-ink/30 aria-[current=true]:bg-glass-press disabled:pointer-events-none disabled:opacity-60';
/** Each level steps in by this much, in px, from the row's own inset. */
const indent = (depth: number) => ({ paddingLeft: 6 + depth * 14 });

/** The letter of a change, named in words for whoever cannot tell it by its colour. */
export function ChangeLetter({ status }: { status: ChangeStatus }) {
  const mark = markOf(status);
  return (
    <span
      role="img"
      title={mark.label}
      aria-label={mark.label}
      className={`w-4 shrink-0 text-center font-mono text-[11px] font-semibold ${markTone[mark.tone]}`}
    >
      {mark.letter}
    </span>
  );
}

type Opening = {
  /** The viewer's file, by the tree's id, so its row shows as the one open. */
  current?: string;
  /** Deleted files open their diff; where Changes cannot read the root, there is nothing to open. */
  diffable: (root: string) => boolean;
  onOpen: (file: TreeFile, opener: HTMLElement) => void;
};

function FolderRow({
  folder,
  depth,
  open,
  onToggle,
}: {
  folder: TreeFolder;
  depth: number;
  open: boolean;
  onToggle: (folder: TreeFolder) => void;
}) {
  return (
    <button
      type="button"
      className={row}
      style={indent(depth)}
      aria-expanded={open}
      onClick={() => onToggle(folder)}
    >
      <FoldChevron open={open} className="text-muted" />
      <Folder size={13} aria-hidden="true" className="shrink-0 text-muted" />
      <span className="min-w-0 flex-1 truncate text-ink">{folder.name}</span>
      {folder.changed > 0 && (
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-muted">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-warn" />
          {folder.changed}
          <span className="sr-only">{folder.changed === 1 ? 'changed file' : 'changed files'}</span>
        </span>
      )}
    </button>
  );
}

function FileRow({
  file,
  depth,
  detail,
  current,
  diffable,
  onOpen,
}: { file: TreeFile; depth: number; detail?: string } & Opening) {
  const tone = file.status ? markTone[markOf(file.status).tone] : 'text-ink';
  const deleted = file.status === 'deleted';

  return (
    <button
      type="button"
      className={row}
      style={indent(depth)}
      aria-current={current === file.id || undefined}
      disabled={deleted && !diffable(file.root)}
      onClick={(event) => onOpen(file, event.currentTarget)}
    >
      {/* The room of the chevron a folder has, so names line up under one another. */}
      <span aria-hidden="true" className="w-[13px] shrink-0" />
      <File size={13} aria-hidden="true" className="shrink-0 text-muted" />
      <span className={`min-w-0 truncate ${detail ? 'shrink-0 max-w-[60%]' : 'flex-1'} ${tone}`}>
        <span className={deleted ? 'line-through' : ''}>{file.name}</span>
      </span>
      {detail !== undefined && (
        <span className="min-w-0 flex-1 truncate text-xs text-muted">{detail}</span>
      )}
      {file.status && <ChangeLetter status={file.status} />}
    </button>
  );
}

/** The open folders and what they hold. Folded ones cost nothing: their rows are not made. */
export function FileTree({
  rows,
  isOpen,
  onToggle,
  ...opening
}: {
  rows: TreeRow[];
  /** Whether a folder is open, as the conversation left it. */
  isOpen: (folder: TreeFolder) => boolean;
  onToggle: (folder: TreeFolder) => void;
} & Opening) {
  return (
    <ul className="grid gap-px">
      {rows.map((item) =>
        item.kind === 'note' ? (
          <li key={item.id} className="py-1 pr-2 text-xs text-muted" style={indent(item.depth)}>
            {item.text}
          </li>
        ) : (
          <li key={item.node.id}>
            {item.node.kind === 'folder' ? (
              <FolderRow
                folder={item.node}
                depth={item.depth}
                open={isOpen(item.node)}
                onToggle={onToggle}
              />
            ) : (
              <FileRow file={item.node} depth={item.depth} {...opening} />
            )}
          </li>
        ),
      )}
    </ul>
  );
}

/** What a filter leaves, one row a file: its name, then where it is. */
export function FileList({
  files,
  rootName,
  ...opening
}: {
  files: TreeFile[];
  /** A root's name to say before the folder, where there are several roots; else undefined. */
  rootName: (root: string) => string | undefined;
} & Opening) {
  return (
    <ul className="grid gap-px">
      {files.map((file) => {
        const cut = file.path.lastIndexOf('/');
        const folder = cut < 0 ? '' : file.path.slice(0, cut);
        const root = rootName(file.root);
        return (
          <li key={file.id}>
            <FileRow
              file={file}
              depth={0}
              detail={[root, folder].filter(Boolean).join('/')}
              {...opening}
            />
          </li>
        );
      })}
    </ul>
  );
}
