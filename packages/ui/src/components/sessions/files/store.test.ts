import { beforeEach, describe, expect, it } from 'vitest';
import { useFiles } from './store';

const SAVED = 'jian-files';
const files = () => useFiles.getState();

beforeEach(() => {
  localStorage.clear();
  useFiles.setState({ open: {}, toggled: {} });
});

describe('the file a conversation shows', () => {
  it('is its own: another conversation still shows its chat', () => {
    files().view('session-a', { root: 'project-1', path: 'src/a.ts' });

    expect(files().open['session-a']).toEqual({ root: 'project-1', path: 'src/a.ts' });
    expect(files().open['session-b']).toBeUndefined();
  });

  it('is replaced by the next one opened there', () => {
    files().view('session-a', { root: 'project-1', path: 'src/a.ts' });
    files().view('session-a', { root: 'project-2', path: 'README.md' });

    expect(files().open['session-a']).toEqual({ root: 'project-2', path: 'README.md' });
  });

  it('goes back to the conversation without closing another’s file', () => {
    files().view('session-a', { root: 'project-1', path: 'src/a.ts' });
    files().view('session-b', { root: 'project-1', path: 'src/b.ts' });
    files().back('session-a');

    expect(files().open['session-a']).toBeUndefined();
    expect(files().open['session-b']).toEqual({ root: 'project-1', path: 'src/b.ts' });
  });

  it('is not saved: a panel opened again starts on the conversation', () => {
    files().view('session-a', { root: 'project-1', path: 'src/a.ts' });

    expect(localStorage.getItem(SAVED)).toBeNull();
  });
});

describe('the folders a conversation turned', () => {
  it('are remembered per conversation and saved', () => {
    files().toggle('session-a', 'folder-1');
    files().toggle('session-a', 'folder-2');
    files().toggle('session-b', 'folder-1');

    expect(files().toggled['session-a']).toEqual(['folder-1', 'folder-2']);
    expect(files().toggled['session-b']).toEqual(['folder-1']);
    expect(JSON.parse(localStorage.getItem(SAVED) ?? '{}')).toEqual({
      'session-a': ['folder-1', 'folder-2'],
      'session-b': ['folder-1'],
    });
  });

  it('go back to how they start when turned again', () => {
    files().toggle('session-a', 'folder-1');
    files().toggle('session-a', 'folder-1');

    expect(files().toggled['session-a']).toBeUndefined();
    expect(JSON.parse(localStorage.getItem(SAVED) ?? '{}')).toEqual({});
  });

  it('forget the conversations touched longest ago', () => {
    for (let index = 0; index < 60; index += 1) files().toggle(`session-${index}`, 'folder');
    // Touched again, the oldest still kept becomes the newest.
    files().toggle('session-10', 'other');
    files().toggle('session-60', 'folder');

    const kept = Object.keys(files().toggled);
    expect(kept).toHaveLength(50);
    expect(kept).not.toContain('session-0');
    expect(kept).not.toContain('session-11');
    expect(kept).toContain('session-10');
    expect(kept).toContain('session-60');
  });
});
