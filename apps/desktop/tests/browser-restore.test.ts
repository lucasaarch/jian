import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

const { folder, FakeView } = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');
  const folder = mkdtempSync(join(tmpdir(), 'jian-browser-restore-'));
  /** A page whose load never finishes, as with a server that accepts and never answers. */
  class FakeView {
    webContents = {
      id: 1,
      debugger: {
        attach() {
          throw new Error('no debugger here');
        },
        isAttached: () => false,
      },
      mainFrame: { framesInSubtree: [] },
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      isDestroyed: () => false,
      isLoading: () => false,
      getURL: () => 'https://stuck.example/',
      getTitle: () => 'Stuck',
      setWindowOpenHandler() {},
      on() {},
      close() {},
      loadURL: () => new Promise(() => {}),
    };
    setBounds() {}
    setVisible() {}
  }
  return { folder, FakeView };
});

vi.mock('electron', () => ({
  app: { getPath: () => folder, on() {} },
  ClipboardItem: class {},
  clipboard: {},
  ipcMain: { handle() {}, on() {} },
  nativeImage: {},
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
      on() {},
      webRequest: { onBeforeRequest() {} },
    }),
  },
  shell: {},
  WebContentsView: FakeView,
}));

const { JianBrowser } = await import('../src/main/browser');

const profileId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const scope = `local:${profileId}`;
const stuckTab = [
  {
    key: `${scope}:${sessionId}`,
    scope,
    sessionId,
    activeId: 'tab',
    pages: [{ id: 'tab', url: 'https://stuck.example/', title: 'Stuck' }],
  },
];
const contentView = { addChildView() {}, removeChildView() {} };
const window = { contentView, isDestroyed: () => false, webContents: { send() {} } };

function browserWithStuckTab(restoreWaitMs: number) {
  writeFileSync(join(folder, 'browser-tabs.json'), JSON.stringify(stuckTab));
  const browser = new JianBrowser(() => window as never, {
    keepMs: 5,
    agentKeepMs: 5,
    liveBackground: 3,
    pointerIdleMs: 1000,
    restoreWaitMs,
  });
  browser.register();
  return browser;
}

afterAll(() => rmSync(folder, { recursive: true, force: true }));

it('acts on a tab whose restored page never finishes loading', async () => {
  const browser = browserWithStuckTab(20);
  for (const _ of [1, 2]) {
    const acted = await browser.act({ profileId, sessionId }, { action: 'read' });
    expect(acted.url).toBe('https://stuck.example/');
  }
});

it('gives up on a stuck restore at the deadline, and the next action still runs', async () => {
  const browser = browserWithStuckTab(60_000);
  const cancelled = new AbortController();
  const first = browser.act({ profileId, sessionId }, { action: 'read' }, cancelled.signal);
  setTimeout(() => cancelled.abort(), 20);
  await expect(first).rejects.toThrow(/aborted|cancelled/);

  const again = new AbortController();
  const second = browser.act({ profileId, sessionId }, { action: 'read' }, again.signal);
  setTimeout(() => again.abort(), 20);
  await expect(second).rejects.toThrow(/aborted|cancelled/);
});
