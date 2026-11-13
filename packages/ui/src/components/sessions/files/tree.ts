import type { SessionChange, SessionFileRoot } from '../../../lib/api';

export type ChangeStatus = SessionChange['status'];

export type TreeFile = {
  kind: 'file';
  id: string;
  root: string;
  path: string;
  name: string;
  status?: ChangeStatus;
  previousPath?: string;
};
export type TreeFolder = {
  kind: 'folder';
  id: string;
  root: string;
  /** Relative to its root; empty for the root itself. */
  path: string;
  name: string;
  /** Folders first, then files, each by name. */
  children: TreeNode[];
  /** How many changed files it holds, however deep. */
  changed: number;
};
export type TreeNode = TreeFile | TreeFolder;
export type TreeRoot = TreeFolder & {
  /** The gateway cut the list: the checkout has more files than these. */
  truncated: boolean;
  /** Why this root has nothing to show. */
  unavailable?: string;
};

/** A row of the open tree: a file or folder at its depth, or something said about a root. */
export type TreeRow =
  | { kind: 'node'; node: TreeNode; depth: number }
  | { kind: 'note'; id: string; text: string; depth: number };

/** How a change is marked: a letter beside the name, and the kit's tone for both. */
export type ChangeMark = {
  letter: string;
  label: string;
  tone: 'good' | 'warn' | 'bad' | 'merged';
};

const MARKS: Record<ChangeStatus, ChangeMark> = {
  modified: { letter: 'M', label: 'Modified', tone: 'warn' },
  typechanged: { letter: 'T', label: 'Type changed', tone: 'warn' },
  added: { letter: 'A', label: 'Added', tone: 'good' },
  untracked: { letter: 'U', label: 'Untracked', tone: 'good' },
  copied: { letter: 'C', label: 'Copied', tone: 'good' },
  renamed: { letter: 'R', label: 'Renamed', tone: 'merged' },
  deleted: { letter: 'D', label: 'Deleted', tone: 'bad' },
  conflicted: { letter: '!', label: 'Conflicted', tone: 'bad' },
};

export const markOf = (status: ChangeStatus): ChangeMark => MARKS[status];

/** A file and a folder can share a path over time (one replaced the other), so a folder's ends in `/`. */
export const fileId = (root: string, path: string) => `${root}\n${path}`;
const folderId = (root: string, path: string) => `${root}\n${path}/`;

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Each root's files as folders. A changed path the listing lacks (a deletion git has staged) gets
 * its row too: it is the only place the tree can say the file is gone.
 */
export function buildTree(roots: SessionFileRoot[]): TreeRoot[] {
  return roots.map((root) => {
    const top: TreeRoot = {
      kind: 'folder',
      id: folderId(root.id, ''),
      root: root.id,
      path: '',
      name: root.name,
      children: [],
      changed: 0,
      truncated: root.truncated,
      ...(root.unavailable ? { unavailable: root.unavailable } : {}),
    };
    const folders = new Map<string, TreeFolder>([['', top]]);
    const folderAt = (path: string): TreeFolder => {
      const known = folders.get(path);
      if (known) return known;
      const cut = path.lastIndexOf('/');
      const made: TreeFolder = {
        kind: 'folder',
        id: folderId(root.id, path),
        root: root.id,
        path,
        name: path.slice(cut + 1),
        children: [],
        changed: 0,
      };
      folderAt(cut < 0 ? '' : path.slice(0, cut)).children.push(made);
      folders.set(path, made);
      return made;
    };

    const changes = new Map(root.changes.map((change) => [change.path, change]));
    for (const path of new Set([...root.files, ...changes.keys()])) {
      const cut = path.lastIndexOf('/');
      const change = changes.get(path);
      folderAt(cut < 0 ? '' : path.slice(0, cut)).children.push({
        kind: 'file',
        id: fileId(root.id, path),
        root: root.id,
        path,
        name: path.slice(cut + 1),
        ...(change ? { status: change.status } : {}),
        ...(change?.previousPath ? { previousPath: change.previousPath } : {}),
      });
    }

    const settle = (folder: TreeFolder): number => {
      folder.children.sort(
        (a, b) =>
          Number(a.kind === 'file') - Number(b.kind === 'file') || byName.compare(a.name, b.name),
      );
      folder.changed = folder.children.reduce(
        (sum, child) => sum + (child.kind === 'folder' ? settle(child) : Number(!!child.status)),
        0,
      );
      return folder.changed;
    };
    settle(top);
    return top;
  });
}

/** A root starts open and every other folder folded; `toggled` holds the ones the owner turned. */
export const folderOpen = (folder: TreeFolder, toggled: ReadonlySet<string>) =>
  (folder.path === '') !== toggled.has(folder.id);

const notesOf = (root: TreeRoot, depth: number): TreeRow[] => [
  ...(root.unavailable
    ? [{ kind: 'note' as const, id: `${root.id}unavailable`, text: root.unavailable, depth }]
    : []),
  ...(root.truncated
    ? [
        {
          kind: 'note' as const,
          id: `${root.id}truncated`,
          text: 'This list is cut short: the checkout has more files than are shown.',
          depth,
        },
      ]
    : []),
  ...(!root.unavailable && !root.children.length
    ? [{ kind: 'note' as const, id: `${root.id}empty`, text: 'No files here.', depth }]
    : []),
];

/**
 * The rows on screen: only what open folders hold, so a large checkout costs what is looked at.
 * One root shows its content directly; several are each a folder named after their project.
 */
export function visibleRows(roots: TreeRoot[], toggled: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (folder: TreeFolder, depth: number) => {
    for (const node of folder.children) {
      rows.push({ kind: 'node', node, depth });
      if (node.kind === 'folder' && folderOpen(node, toggled)) walk(node, depth + 1);
    }
  };
  const [only] = roots;

  if (roots.length === 1 && only) {
    rows.push(...notesOf(only, 0));
    walk(only, 0);
    return rows;
  }
  for (const root of roots) {
    rows.push({ kind: 'node', node: root, depth: 0 });
    if (!folderOpen(root, toggled)) continue;
    rows.push(...notesOf(root, 1));
    walk(root, 1);
  }
  return rows;
}

/** How many files all roots hold, and how many of them changed. */
export function countFiles(roots: TreeRoot[]): { files: number; changed: number } {
  const count = (folder: TreeFolder): number =>
    folder.children.reduce((sum, child) => sum + (child.kind === 'folder' ? count(child) : 1), 0);
  return {
    files: roots.reduce((sum, root) => sum + count(root), 0),
    changed: roots.reduce((sum, root) => sum + root.changed, 0),
  };
}

/** The most rows a filtered list draws; the rest are counted, not drawn. */
const FILTER_ROWS = 300;

/**
 * The files a filter leaves, flat, in the tree's order: any part of the path or of the one it was
 * renamed from, whatever its case. `more` counts those past `limit`.
 */
export function filterFiles(
  roots: TreeRoot[],
  typed: string,
  limit = FILTER_ROWS,
): { files: TreeFile[]; more: number } {
  const words = typed.trim().toLowerCase();
  const files: TreeFile[] = [];
  let found = 0;
  const walk = (folder: TreeFolder) => {
    for (const node of folder.children) {
      if (node.kind === 'folder') {
        walk(node);
        continue;
      }
      if (
        words &&
        !node.path.toLowerCase().includes(words) &&
        !node.previousPath?.toLowerCase().includes(words)
      )
        continue;
      found += 1;
      if (files.length < limit) files.push(node);
    }
  };
  for (const root of roots) walk(root);
  return { files, more: found - files.length };
}
