import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { BrowserTabsFile, type SavedConversation } from './browser-tabs';

const places: string[] = [];
afterEach(() => {
  for (const place of places.splice(0)) rmSync(place, { recursive: true, force: true });
});
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'jian-tabs-'));
  places.push(dir);
  const file = join(dir, 'nested', 'tabs.json');
  return { file, store: new BrowserTabsFile(() => file) };
};
const conversation = (id: string): SavedConversation => ({
  key: `local:atlas:${id}`,
  scope: 'local:atlas',
  sessionId: id,
  activeId: 'a',
  pages: [{ id: 'a', url: 'https://atlas.test/', title: 'Atlas' }],
});

it('brings the tabs back after a restart, in a file only its owner reads', () => {
  const { file, store } = fresh();
  store.save(() => [conversation('one')]);
  store.flush();

  expect(new BrowserTabsFile(() => file).read()).toEqual([conversation('one')]);
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
});

it('keeps the most recent conversations when there are too many', () => {
  const { file, store } = fresh();
  store.save(() => Array.from({ length: 120 }, (_, index) => conversation(String(index))));
  store.flush();

  const read = new BrowserTabsFile(() => file).read();
  expect(read).toHaveLength(100);
  expect(read.at(-1)?.sessionId).toBe('119');
});

it('starts empty from a file that is missing, broken or of another shape', () => {
  const { file, store } = fresh();
  expect(store.read()).toEqual([]);

  store.save(() => []);
  store.flush();
  for (const content of ['not json', '{"a":1}', '[{"key":"x"}]']) {
    writeFileSync(file, content);
    expect(new BrowserTabsFile(() => file).read()).toEqual([]);
  }
});
