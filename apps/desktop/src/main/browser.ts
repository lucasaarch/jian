import { createHash } from 'node:crypto';
import type { InspectionCapture } from '@jian/browser-core';
import {
  type BrowserActionResult,
  browserActionInputSchema,
  type PageInspectionInput,
  pageInspectionInputSchema,
} from '@jian/contracts';
import { type BrowserWindow, ipcMain, session, shell, WebContentsView } from 'electron';
import type { BrowserState, Showing } from '../shared/bridge';
import { runBrowserAction } from './browser-control';
import { type CookieSourceId, cookieSources, importCookies } from './browser-cookies';
import { allowed, inspectContents } from './browser-inspect';
import { BrowserPointer } from './browser-pointer';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rejectOnAbort = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(new Error('The browser action was cancelled or timed out')),
      { once: true },
    );
  });

/** A page laid out while no one watches is still a page of the panel's size. */
const FALLBACK_SIZE = { width: 1280, height: 800 };
/** Far outside any window, so a page an agent works in draws nothing the owner can see. */
const OFF_SCREEN = -30000;

/**
 * What a conversation keeps of its browser. The page itself is a whole renderer process, so only
 * a conversation on screen is sure to have one; the others keep the address it comes back to.
 */
type PageTab = {
  key: string;
  /** Logins belong to the profile; every conversation of it shares them, never a page. */
  scope: string;
  sessionId?: string;
  view?: WebContentsView;
  restoring?: Promise<unknown>;
  opened: boolean;
  focus: number;
  url: string;
  title: string;
  error?: string;
  /** Where the agent's pointer last stood in this page. */
  tip?: { x: number; y: number };
  queue: Promise<unknown>;
  /** Agent actions running now: their page is not to be taken away. */
  busy: number;
  usedAt: number;
  /** An agent may come back for its page between steps, so it is kept longer than a visit. */
  keepUntil: number;
  evicting?: NodeJS.Timeout;
};

export type BrowserLimits = {
  /** How long a page outlives the owner moving to another conversation, for a quick way back. */
  keepMs: number;
  /** How long after an agent's last action its page waits for the next one. */
  agentKeepMs: number;
  /** Pages alive off screen at most, however many conversations an owner has been through. */
  liveBackground: number;
  /** How long the agent's pointer stands without an action before it dims. */
  pointerIdleMs: number;
};
const LIMITS: BrowserLimits = {
  keepMs: 30_000,
  agentKeepMs: 120_000,
  liveBackground: 2,
  pointerIdleMs: 30_000,
};

/**
 * The browser beside a conversation: each has its own page and tab state, and none reaches
 * another's. Separate from the app's origin, preload and secrets.
 */
export class JianBrowser {
  private tabs = new Map<string, PageTab>();
  private current?: PageTab;
  private place: Showing | null = null;
  private focusCount = 0;
  private bounds = { x: 0, y: 0, width: 0, height: 0 };
  private lastSize = FALLBACK_SIZE;
  private inspecting = new Set<number>();
  private partitions = new Set<string>();
  private readonly pointer: BrowserPointer;
  constructor(
    private readonly window: () => BrowserWindow | undefined,
    private readonly limits: BrowserLimits = LIMITS,
  ) {
    this.pointer = new BrowserPointer(window, () => this.view?.webContents, limits.pointerIdleMs);
  }

  /**
   * A native view stays above the page of the app, which cannot draw over it: reloading the app
   * must take it away first, and the panel that comes back places it again.
   */
  attach(window: BrowserWindow) {
    window.webContents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument)
        this.layout({ x: 0, y: 0, width: 0, height: 0 });
    });
  }

  private get view() {
    return this.current?.view;
  }
  state(): BrowserState {
    const tab = this.current;
    const candidate = tab?.view?.webContents;
    const contents = candidate?.isDestroyed() ? undefined : candidate;
    return {
      sessionId: this.place?.chat?.sessionId,
      focus: tab?.focus ?? 0,
      open: tab?.opened ?? false,
      url: contents?.getURL() || tab?.url || '',
      title: contents?.getTitle() || tab?.title || '',
      loading: contents?.isLoading() ?? false,
      canBack: contents?.navigationHistory.canGoBack() ?? false,
      canForward: contents?.navigationHistory.canGoForward() ?? false,
      error: tab?.error,
    };
  }
  private changed() {
    const window = this.window();
    if (window && !window.isDestroyed()) window.webContents.send('browser:changed', this.state());
  }
  private changedIn(tab: PageTab) {
    if (tab === this.current) this.changed();
  }

  private tabFor(gatewayId: string, profileId: string | undefined, sessionId: string | undefined) {
    const scope = `${gatewayId}:${profileId ?? 'owner'}`;
    const key = `${scope}:${sessionId ?? 'new'}`;
    let tab = this.tabs.get(key);
    if (!tab) {
      tab = {
        key,
        scope,
        sessionId,
        opened: false,
        focus: 0,
        url: '',
        title: '',
        queue: Promise.resolve(),
        busy: 0,
        usedAt: Date.now(),
        keepUntil: 0,
      };
      this.tabs.set(key, tab);
    }
    return tab;
  }
  private shownTab() {
    return this.tabFor(
      this.place?.gatewayId ?? 'local',
      this.place?.chat?.profileId,
      this.place?.chat?.sessionId,
    );
  }

  showing(place: Showing | null) {
    this.place = place;
    const next = place ? this.shownTab() : undefined;
    if (next === this.current) return;
    const previous = this.current;
    if (previous) previous.tip = this.pointer.position;
    this.current = next;
    this.pointer.hide();
    if (previous) this.leave(previous);
    if (next?.opened) {
      this.present(next);
      if (next.tip) this.pointer.restore(next.tip, this.visible());
    }
    this.changed();
  }

  /** The partition's rules are set once: a page is made many times, and listeners would pile up. */
  private partition(scope: string) {
    const partition = `persist:jian-browser-${createHash('sha256').update(scope).digest('hex').slice(0, 24)}`;
    if (this.partitions.has(partition)) return partition;
    this.partitions.add(partition);
    const isolated = session.fromPartition(partition);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.on('will-download', (event) => event.preventDefault());
    isolated.webRequest.onBeforeRequest((details, callback) => {
      const inspecting =
        details.webContentsId !== undefined && this.inspecting.has(details.webContentsId);
      callback({
        cancel:
          !allowed(details.url) ||
          (inspecting &&
            (!['GET', 'HEAD'].includes(details.method) || details.resourceType === 'webSocket')),
      });
    });
    return partition;
  }

  /** The tab's page, made again from its address when it was let go. */
  private live(tab: PageTab) {
    clearTimeout(tab.evicting);
    tab.usedAt = Date.now();
    if (tab.view && !tab.view.webContents.isDestroyed()) return tab.view;
    const view = new WebContentsView({
      webPreferences: {
        partition: this.partition(tab.scope),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        safeDialogs: true,
        navigateOnDragDrop: false,
      },
    });
    const contents = view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      if (allowed(url)) void contents.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    const navigation = (event: Electron.Event, url: string) => {
      if (!allowed(url)) event.preventDefault();
    };
    const remember = () => {
      if (contents.isDestroyed()) return;
      tab.url = contents.getURL();
      tab.title = contents.getTitle();
      this.changedIn(tab);
    };
    contents.on('will-navigate', navigation);
    contents.on('will-redirect', navigation);
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('did-navigate', remember);
    contents.on('did-navigate-in-page', remember);
    contents.on('page-title-updated', remember);
    contents.on('did-start-loading', () => this.changedIn(tab));
    contents.on('did-stop-loading', () => this.changedIn(tab));
    contents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) {
        tab.error = description;
        this.changedIn(tab);
      }
    });
    tab.view = view;
    tab.restoring = tab.url ? contents.loadURL(tab.url).catch(() => {}) : undefined;
    return view;
  }

  private present(tab: PageTab) {
    const window = this.window();
    if (!window) throw new Error('The Jian window is not open');
    window.contentView.addChildView(this.live(tab));
    this.pointer.raise();
    this.layout(this.bounds);
  }

  /** Rendering with no one watching, so an agent's clicks land where the page has them. */
  private offScreen(tab: PageTab) {
    const window = this.window();
    if (!window) throw new Error('The Jian window is not open');
    const view = this.live(tab);
    window.contentView.addChildView(view);
    view.setBounds({ x: OFF_SCREEN, y: 0, ...this.lastSize });
    view.setVisible(true);
  }

  private leave(tab: PageTab) {
    if (tab.busy > 0) {
      if (tab.view) this.offScreen(tab);
      return;
    }
    if (tab.view) {
      this.window()?.contentView.removeChildView(tab.view);
      tab.view.setVisible(false);
    }
    // A conversation whose browser was never opened has nothing to come back to.
    if (!tab.opened) {
      this.tabs.delete(tab.key);
      return;
    }
    // A browser opened outside any conversation belongs to that moment, not to the next chat.
    if (!tab.sessionId) {
      this.drop(tab);
      return;
    }
    this.scheduleRelease(tab);
  }

  private scheduleRelease(tab: PageTab) {
    clearTimeout(tab.evicting);
    if (!tab.view) return;
    const wait = Math.max(this.limits.keepMs, tab.keepUntil - Date.now());
    tab.evicting = setTimeout(() => this.release(tab), wait);
    const away = [...this.tabs.values()]
      .filter((other) => other.view && other !== this.current && other.busy === 0)
      .sort((a, b) => b.usedAt - a.usedAt);
    for (const old of away.slice(this.limits.liveBackground)) this.release(old);
  }

  /** Frees the page, the renderer process with it; its address is what brings it back. */
  private release(tab: PageTab) {
    clearTimeout(tab.evicting);
    if (tab === this.current || tab.busy > 0 || !tab.view) return;
    const view = tab.view;
    tab.view = undefined;
    tab.restoring = undefined;
    this.window()?.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
  }

  /** The owner closed it: nothing of it stays. */
  private drop(tab: PageTab) {
    clearTimeout(tab.evicting);
    const view = tab.view;
    tab.view = undefined;
    tab.url = '';
    tab.title = '';
    tab.opened = false;
    this.tabs.delete(tab.key);
    if (view) {
      this.window()?.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    }
  }

  open() {
    const tab = this.current ?? this.shownTab();
    this.current = tab;
    tab.focus = ++this.focusCount;
    tab.opened = true;
    this.present(tab);
    this.changed();
  }
  close() {
    const tab = this.current;
    this.pointer.hide();
    if (tab) {
      this.drop(tab);
      this.current = this.place ? this.shownTab() : undefined;
    }
    this.changed();
  }
  layout(bounds: { x: number; y: number; width: number; height: number }) {
    const window = this.window();
    if (!window || Object.values(bounds).some((value) => !Number.isFinite(value))) return;
    const size = window.getContentBounds();
    const x = Math.max(0, Math.min(Math.round(bounds.x), size.width));
    const y = Math.max(0, Math.min(Math.round(bounds.y), size.height));
    this.bounds = {
      x,
      y,
      width: Math.max(0, Math.min(Math.round(bounds.width), size.width - x)),
      height: Math.max(0, Math.min(Math.round(bounds.height), size.height - y)),
    };
    if (this.bounds.width > 0 && this.bounds.height > 0)
      this.lastSize = { width: this.bounds.width, height: this.bounds.height };
    const visible = this.visible();
    this.view?.setBounds(this.bounds);
    this.view?.setVisible(visible);
    this.pointer.follow(this.bounds, visible);
  }
  private visible() {
    return Boolean(this.current?.opened && this.bounds.width > 0 && this.bounds.height > 0);
  }
  /** What the page looks like now, for the panel to hold while something is drawn over it. */
  private async snapshot() {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed() || !this.visible()) return null;
    const image = await contents.capturePage().catch(() => null);
    return image && !image.isEmpty()
      ? `data:image/jpeg;base64,${image.toJPEG(82).toString('base64')}`
      : null;
  }
  async navigate(raw: string) {
    const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    if (!allowed(url)) throw new Error('Enter an HTTP or HTTPS address without credentials');
    if (!this.current?.opened) this.open();
    const tab = this.current;
    if (!tab) return;
    tab.error = undefined;
    try {
      await this.live(tab).webContents.loadURL(url);
    } catch (error) {
      tab.error = error instanceof Error ? error.message : 'The page could not be opened';
    }
    this.changed();
  }
  command(command: string) {
    const contents = this.view?.webContents;
    if (!contents) return;
    if (command === 'back' && contents.navigationHistory.canGoBack())
      contents.navigationHistory.goBack();
    if (command === 'forward' && contents.navigationHistory.canGoForward())
      contents.navigationHistory.goForward();
    if (command === 'reload') {
      if (this.current) this.current.error = undefined;
      contents.reload();
    }
    if (command === 'stop') contents.stop();
  }
  register() {
    const trusted = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => {
      const contents = this.window()?.webContents;
      if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame)
        throw new Error('Browser controls are only available to the Jian app');
    };
    ipcMain.handle('browser:state', (event) => {
      trusted(event);
      return this.state();
    });
    ipcMain.handle('browser:navigate', async (event, url: unknown) => {
      trusted(event);
      if (typeof url !== 'string' || url.length > 2000) throw new Error('Invalid address');
      await this.navigate(url);
      return this.state();
    });
    ipcMain.on('browser:open', (event) => {
      trusted(event);
      this.open();
    });
    ipcMain.on('browser:close', (event) => {
      trusted(event);
      this.close();
    });
    ipcMain.on('browser:layout', (event, bounds) => {
      trusted(event);
      if (bounds && typeof bounds === 'object') this.layout(bounds);
    });
    ipcMain.on('browser:command', (event, command) => {
      trusted(event);
      if (typeof command === 'string') this.command(command);
    });
    ipcMain.handle('browser:snapshot', (event) => {
      trusted(event);
      return this.snapshot();
    });
    ipcMain.on('browser:external', (event) => {
      trusted(event);
      const url = this.view?.webContents.getURL();
      if (url && allowed(url)) void shell.openExternal(url);
    });
    ipcMain.handle('browser:cookie-sources', (event) => {
      trusted(event);
      return cookieSources();
    });
    ipcMain.handle('browser:import-cookies', async (event, source: unknown, scope: unknown) => {
      trusted(event);
      const contents = this.view?.webContents;
      if (!contents || typeof source !== 'string') throw new Error('Open the browser first');
      const url = contents.getURL();
      if (scope === 'site' && !allowed(url)) throw new Error('Open the site first');
      const result = await importCookies(
        contents.session,
        source as CookieSourceId,
        scope === 'site' ? new URL(url).hostname : undefined,
      );
      if (allowed(url)) contents.reload();
      return result;
    });
  }

  /**
   * One agent's work in its conversation's page, one thing at a time there. Conversations do not
   * wait for each other. A renderer stuck in a page's own loop may never answer: the race lets
   * that page fail its own work and frees the queue for what comes next.
   */
  private work<T>(
    scope: { profileId: string; sessionId: string },
    signal: AbortSignal | undefined,
    run: (tab: PageTab, shown: boolean, deadline: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const tab = this.tabFor('local', scope.profileId, scope.sessionId);
    const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(45000)]);
    const task = tab.queue
      .catch(() => {})
      .then(async () => {
        deadline.throwIfAborted();
        tab.busy += 1;
        tab.opened = true;
        tab.focus = ++this.focusCount;
        tab.keepUntil = Date.now() + this.limits.agentKeepMs;
        try {
          const shown = tab === this.current;
          if (shown) {
            this.present(tab);
            this.changed();
          } else this.offScreen(tab);
          await tab.restoring;
          return await Promise.race([run(tab, shown, deadline), rejectOnAbort(deadline)]);
        } finally {
          tab.busy -= 1;
          if (tab !== this.current && tab.busy === 0) {
            if (tab.view) {
              this.window()?.contentView.removeChildView(tab.view);
              tab.view.setVisible(false);
            }
            this.scheduleRelease(tab);
          }
        }
      });
    tab.queue = task;
    return task;
  }

  act(
    scope: { profileId: string; sessionId: string },
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<BrowserActionResult<Buffer>> {
    return this.work(scope, signal, async (tab, shown, deadline) => {
      const input = browserActionInputSchema.parse(raw);
      if (input.action === 'open' && !allowed(input.url ?? ''))
        throw new Error('Enter an HTTP or HTTPS address without credentials');
      const contents = this.live(tab).webContents;
      // The panel opens because of the change `work` sent; a click needs the page where it lands.
      if (shown)
        for (let waited = 0; waited < 1500 && !this.visible() && !deadline.aborted; waited += 50)
          await delay(50);
      deadline.throwIfAborted();
      const onScreen = () => tab === this.current;
      return runBrowserAction(contents, input, {
        pointer: shown ? this.pointer : undefined,
        signal: deadline,
        bounds: () => (onScreen() ? this.bounds : this.lastSize),
        visible: () => (onScreen() ? this.visible() : true),
        offScreen: () => !onScreen(),
        open: async (url) => {
          tab.error = undefined;
          await contents.loadURL(url);
        },
        // Only the conversation on screen may take the keyboard from the owner.
        focus: () => {
          if (onScreen()) contents.focus();
        },
        keepFocus: () => {
          const app = this.window()?.webContents;
          const had = app?.isFocused() ?? false;
          return () => {
            if (had && app && !app.isDestroyed()) app.focus();
          };
        },
      });
    });
  }

  inspect(
    scope: { profileId: string; sessionId: string },
    raw: PageInspectionInput,
    signal?: AbortSignal,
  ): Promise<InspectionCapture> {
    return this.work(scope, signal, async (tab, _shown, deadline) => {
      const input = pageInspectionInputSchema.parse(raw);
      if (!allowed(input.url)) throw new Error('Only HTTP and HTTPS pages can be inspected');
      return inspectContents(this.live(tab).webContents, input, deadline, {
        inspecting: this.inspecting,
        cancelled: () => {
          tab.error = 'The browser inspection was cancelled or timed out';
          if (!input.reusePage) {
            const view = tab.view;
            tab.view = undefined;
            if (view) {
              this.window()?.contentView.removeChildView(view);
              if (!view.webContents.isDestroyed())
                view.webContents.close({ waitForBeforeUnload: false });
            }
          }
          this.changedIn(tab);
        },
        finished: () => this.changedIn(tab),
      });
    });
  }
}
