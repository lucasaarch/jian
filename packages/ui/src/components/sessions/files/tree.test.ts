import { describe, expect, it } from 'vitest';
import type { SessionFileRoot } from '../../../lib/api';
import {
  buildTree,
  countFiles,
  filterFiles,
  markOf,
  type TreeNode,
  type TreeRow,
  visibleRows,
} from './tree';

const root = (over: Partial<SessionFileRoot> = {}): SessionFileRoot => ({
  id: 'project-1',
  name: 'storefront',
  files: [],
  changes: [],
  truncated: false,
  ...over,
});

const names = (nodes: TreeNode[]) => nodes.map((node) => node.name);
const shown = (rows: TreeRow[]) =>
  rows.map((row) => (row.kind === 'note' ? `note: ${row.text}` : `${row.depth} ${row.node.name}`));
const folderIn = (nodes: TreeNode[], name: string) => {
  const found = nodes.find((node) => node.kind === 'folder' && node.name === name);
  if (found?.kind !== 'folder') throw new Error(`no folder ${name}`);
  return found;
};

describe('the tree of a root', () => {
  it('puts folders before files, each in the order a person reads names', () => {
    const [tree] = buildTree([
      root({ files: ['zeta.ts', 'README.md', 'src/b.ts', 'src/a10.ts', 'src/a2.ts', 'docs/x.md'] }),
    ]);

    expect(names(tree?.children ?? [])).toEqual(['docs', 'src', 'README.md', 'zeta.ts']);
    expect(names(folderIn(tree?.children ?? [], 'src').children)).toEqual([
      'a2.ts',
      'a10.ts',
      'b.ts',
    ]);
  });

  it('counts the changes a folder holds, however deep', () => {
    const [tree] = buildTree([
      root({
        files: ['src/app/page.tsx', 'src/app/layout.tsx', 'src/lib/money.ts', 'package.json'],
        changes: [
          { path: 'src/app/page.tsx', status: 'modified' },
          { path: 'src/lib/money.ts', status: 'untracked' },
        ],
      }),
    ]);
    const src = folderIn(tree?.children ?? [], 'src');

    expect(tree?.changed).toBe(2);
    expect(src.changed).toBe(2);
    expect(folderIn(src.children, 'app').changed).toBe(1);
    expect(folderIn(src.children, 'lib').changed).toBe(1);
  });

  it('keeps a row for a deleted file the listing no longer has', () => {
    const [tree] = buildTree([
      root({ files: ['src/kept.ts'], changes: [{ path: 'src/gone.ts', status: 'deleted' }] }),
    ]);
    const gone = folderIn(tree?.children ?? [], 'src').children.find(
      (node) => node.name === 'gone.ts',
    );

    expect(gone).toMatchObject({ kind: 'file', path: 'src/gone.ts', status: 'deleted' });
    expect(countFiles(buildTree([root({ files: ['a.ts', 'a.ts'] })])).files).toBe(1);
  });

  it('counts every file and every change across roots', () => {
    const trees = buildTree([
      root({ files: ['a.ts', 'b/c.ts'], changes: [{ path: 'a.ts', status: 'modified' }] }),
      root({ id: 'project-2', name: 'api', files: ['main.go'] }),
    ]);

    expect(countFiles(trees)).toEqual({ files: 3, changed: 1 });
  });
});

describe('the rows on screen', () => {
  const one = buildTree([root({ files: ['src/app/page.tsx', 'README.md'] })]);
  const idOf = (rows: TreeRow[], name: string) => {
    const row = rows.find((item) => item.kind === 'node' && item.node.name === name);
    if (row?.kind !== 'node') throw new Error(`no row ${name}`);
    return row.node.id;
  };

  it('shows one root’s content directly, its folders folded', () => {
    expect(shown(visibleRows(one, new Set()))).toEqual(['0 src', '0 README.md']);
  });

  it('opens only the folders that were turned', () => {
    const src = idOf(visibleRows(one, new Set()), 'src');
    const opened = visibleRows(one, new Set([src]));
    expect(shown(opened)).toEqual(['0 src', '1 app', '0 README.md']);

    const app = idOf(opened, 'app');
    expect(shown(visibleRows(one, new Set([src, app])))).toEqual([
      '0 src',
      '1 app',
      '2 page.tsx',
      '0 README.md',
    ]);
    // A folder left open inside a folded one is not drawn until its parent opens again.
    expect(shown(visibleRows(one, new Set([app])))).toEqual(['0 src', '0 README.md']);
  });

  it('heads several roots with their project, open until folded', () => {
    const two = buildTree([
      root({ files: ['a.ts'] }),
      root({ id: 'project-2', name: 'api', files: ['main.go'] }),
    ]);
    expect(shown(visibleRows(two, new Set()))).toEqual([
      '0 storefront',
      '1 a.ts',
      '0 api',
      '1 main.go',
    ]);

    const api = idOf(visibleRows(two, new Set()), 'api');
    expect(shown(visibleRows(two, new Set([api])))).toEqual(['0 storefront', '1 a.ts', '0 api']);
  });

  it('keeps two roots’ folders of the same path apart', () => {
    const two = buildTree([
      root({ files: ['src/a.ts'] }),
      root({ id: 'project-2', name: 'api', files: ['src/b.ts'] }),
    ]);
    const first = visibleRows(two, new Set()).find(
      (row) => row.kind === 'node' && row.node.name === 'src',
    );
    if (first?.kind !== 'node') throw new Error('no src');

    expect(shown(visibleRows(two, new Set([first.node.id])))).toEqual([
      '0 storefront',
      '1 src',
      '2 a.ts',
      '0 api',
      '1 src',
    ]);
  });

  it('says why a root has nothing, and that a list is cut short', () => {
    const rows = visibleRows(
      buildTree([
        root({ unavailable: 'Not checked out yet.' }),
        root({ id: 'project-2', name: 'api', files: ['main.go'], truncated: true }),
        root({ id: 'project-3', name: 'empty' }),
      ]),
      new Set(),
    );

    expect(shown(rows)).toEqual([
      '0 storefront',
      'note: Not checked out yet.',
      '0 api',
      'note: This list is cut short: the checkout has more files than are shown.',
      '1 main.go',
      '0 empty',
      'note: No files here.',
    ]);
  });
});

describe('filtering', () => {
  const trees = buildTree([
    root({
      files: ['src/Pricing.ts', 'src/cart.ts', 'docs/pricing.md', 'src/money.ts'],
      changes: [
        { path: 'src/cart.ts', status: 'modified' },
        { path: 'src/money.ts', previousPath: 'src/pricing-helpers.ts', status: 'renamed' },
        { path: 'src/old.ts', status: 'deleted' },
      ],
    }),
  ]);
  const paths = (words: string, changed = false) =>
    filterFiles(trees, { words, changed }).files.map((file) => file.path);

  it('matches any part of the path, whatever its case', () => {
    expect(paths('  PRICING ')).toEqual(['docs/pricing.md', 'src/money.ts', 'src/Pricing.ts']);
    expect(paths('docs/')).toEqual(['docs/pricing.md']);
    expect(paths('nothing-like-this')).toEqual([]);
  });

  it('finds a renamed file by the name it had', () => {
    expect(paths('helpers')).toEqual(['src/money.ts']);
  });

  it('leaves only changed files when asked, with or without words', () => {
    expect(paths('', true)).toEqual(['src/cart.ts', 'src/money.ts', 'src/old.ts']);
    expect(paths('pricing', true)).toEqual(['src/money.ts']);
  });

  it('draws up to the limit and counts the rest', () => {
    const many = buildTree([
      root({ files: Array.from({ length: 25 }, (_, index) => `file-${index}.ts`) }),
    ]);
    const found = filterFiles(many, { words: 'file', changed: false }, 10);

    expect(found.files).toHaveLength(10);
    expect(found.more).toBe(15);
    expect(found.files[0]?.path).toBe('file-0.ts');
  });
});

describe('change marks', () => {
  it('tells the kinds of change apart by letter and tone', () => {
    expect(markOf('modified')).toMatchObject({ letter: 'M', tone: 'warn' });
    expect(markOf('added')).toMatchObject({ letter: 'A', tone: 'good' });
    expect(markOf('untracked')).toMatchObject({ letter: 'U', tone: 'good' });
    expect(markOf('deleted')).toMatchObject({ letter: 'D', tone: 'bad' });
    expect(markOf('renamed')).toMatchObject({ letter: 'R', tone: 'merged' });
    expect(markOf('conflicted')).toMatchObject({ letter: '!', tone: 'bad' });
  });

  it('gives every status its own letter and a name to read aloud', () => {
    const statuses = [
      'modified',
      'typechanged',
      'added',
      'untracked',
      'copied',
      'renamed',
      'deleted',
      'conflicted',
    ] as const;
    const marks = statuses.map(markOf);

    expect(new Set(marks.map((mark) => mark.letter)).size).toBe(statuses.length);
    expect(marks.every((mark) => mark.label.length > 0)).toBe(true);
  });
});
