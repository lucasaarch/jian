import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { InspectionCapture } from '@jian/browser-core';
import {
  type BrowserActionResult,
  browserActionInputSchema,
  type PageInspectionInput,
  pageInspectionInputSchema,
} from '@jian/contracts';
import {
  app,
  type BrowserWindow,
  ClipboardItem,
  clipboard,
  ipcMain,
  session,
  shell,
  WebContentsView,
} from 'electron';
import type { BrowserPageSummary, BrowserState, Showing } from '../shared/bridge';
import { runBrowserAction } from './browser-control';
import { type CookieSourceId, cookieSources, importCookies } from './browser-cookies';
import { allowed, inspectContents, pageKey } from './browser-inspect';
import { addressFrom, BrowserPlaces } from './browser-places';
import { BrowserPointer } from './browser-pointer';
import { BrowserTabsFile, type SavedConversation } from './browser-tabs';

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

/** One tab of a conversation's browser. Its page is a whole renderer process, so it may be let go. */
type BrowserPage = {
  id: string;
  conversation: Conversation;
  view?: WebContentsView;
  restoring?: Promise<unknown>;
  /** What brings the page back after it was let go. */
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

/** What a conversation keeps of its browser; it reaches no other conversation's. */
type Conversation = {
  key: string;
  /** Logins belong to the profile; every conversation of it shares them, never a page. */
  scope: string;
  sessionId?: string;
  pages: BrowserPage[];
  activeId?: string;
  /** The tab an agent works in, so the owner choosing another does not move its work. */
  agentPageId?: string;
  focus: number;
};

export type BrowserLimits = {
  /** How long a page outlives the owner moving to another conversation, for a quick way back. */
  keepMs: number;
  /** How long after an agent's last action its page waits for the next one. */
  agentKeepMs: number;
  /** Pages alive off screen at most, however many tabs and conversations an owner has been through. */
  liveBackground: number;
  /** How long the agent's pointer stands without an action before it dims. */
  pointerIdleMs: number;
};
const LIMITS: BrowserLimits = {
  keepMs: 30_000,
  agentKeepMs: 120_000,
  liveBackground: 3,
  pointerIdleMs: 30_000,
};
const AWAY = { x: 0, y: 0, width: 0, height: 0 };

const pageSummary = (page: BrowserPage): BrowserPageSummary => {
  const contents = page.view?.webContents;
  const live = contents && !contents.isDestroyed() ? contents : undefined;
  return {
    id: page.id,
    title: live?.getTitle() || page.title,
    url: live?.getURL() || page.url,
  };
};

/**
 * The browser beside a conversation: each has its own tabs, and none reaches another's. Separate
 * from the app's origin, preload and secrets.
 */
export class JianBrowser {
  private conversations = new Map<string, Conversation>();
  private current?: Conversation;
  private place: Showing | null = null;
  private focusCount = 0;
  private bounds = AWAY;
  private lastSize = FALLBACK_SIZE;
  /** The view drawn in the panel now. */
  private attached?: WebContentsView;
  private inspecting = new Set<number>();
  private partitions = new Set<string>();
  /** The app's own keys, in the form the panel's registry writes them. */
  private shortcuts = new Set<string>();
  private readonly pointer: BrowserPointer;
  private readonly places = new BrowserPlaces(() =>
    join(app.getPath('userData'), 'browser-places.json'),
  );
  private readonly saved = new BrowserTabsFile(() =>
    join(app.getPath('userData'), 'browser-tabs.json'),
  );
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
      if (details.isMainFrame && !details.isSameDocument) this.layout(AWAY);
    });
  }

  private shownPage() {
    const conversation = this.current;
    return conversation?.pages.find((page) => page.id === conversation.activeId);
  }
  private get view() {
    return this.shownPage()?.view;
  }
  state(): BrowserState {
    const conversation = this.current;
    const page = this.shownPage();
    const candidate = page?.view?.webContents;
    const contents = candidate?.isDestroyed() ? undefined : candidate;
    return {
      sessionId: this.place?.chat?.sessionId,
      focus: conversation?.focus ?? 0,
      open: Boolean(conversation?.pages.length),
      pages: conversation?.pages.map(pageSummary) ?? [],
      activePageId: page?.id,
      favorite: Boolean(
        page && conversation && this.places.isFavorite(conversation.scope, page.url),
      ),
      url: contents?.getURL() || page?.url || '',
      title: contents?.getTitle() || page?.title || '',
      loading: contents?.isLoading() ?? false,
      canBack: contents?.navigationHistory.canGoBack() ?? false,
      canForward: contents?.navigationHistory.canGoForward() ?? false,
      error: page?.error,
    };
  }
  /** What is saved is what could come back: a conversation, with something open in it. */
  private savedTabs(): SavedConversation[] {
    return [...this.conversations.values()].flatMap((conversation) =>
      conversation.sessionId && conversation.pages.length
        ? [
            {
              key: conversation.key,
              scope: conversation.scope,
              sessionId: conversation.sessionId,
              activeId: conversation.activeId,
              agentPageId: conversation.agentPageId,
              pages: conversation.pages.map(({ id, url, title }) => ({ id, url, title })),
            },
          ]
        : [],
    );
  }
  private restoreTabs() {
    for (const saved of this.saved.read()) {
      const conversation: Conversation = {
        key: saved.key,
        scope: saved.scope,
        sessionId: saved.sessionId,
        pages: [],
        focus: 0,
        ...(saved.activeId ? { activeId: saved.activeId } : {}),
        ...(saved.agentPageId ? { agentPageId: saved.agentPageId } : {}),
      };
      for (const { id, url, title } of saved.pages)
        conversation.pages.push({ ...this.blankPage(conversation), id, url, title });
      this.conversations.set(saved.key, conversation);
    }
  }
  /** A new chat became this conversation: its tabs are this conversation's now. */
  private adopt(sessionId: string) {
    const conversation = this.current;
    if (!conversation || conversation.sessionId) return;
    this.conversations.delete(conversation.key);
    conversation.sessionId = sessionId;
    conversation.key = `${conversation.scope}:${sessionId}`;
    this.conversations.set(conversation.key, conversation);
  }
  private changed() {
    this.saved.save(() => this.savedTabs());
    const window = this.window();
    if (window && !window.isDestroyed()) window.webContents.send('browser:changed', this.state());
  }
  private changedIn(page: BrowserPage) {
    if (page.conversation === this.current) this.changed();
    else this.saved.save(() => this.savedTabs());
  }

  private conversationFor(
    gatewayId: string,
    profileId: string | undefined,
    sessionId: string | undefined,
  ) {
    const scope = `${gatewayId}:${profileId ?? 'owner'}`;
    const key = `${scope}:${sessionId ?? 'new'}`;
    let conversation = this.conversations.get(key);
    if (!conversation) {
      conversation = { key, scope, sessionId, pages: [], focus: 0 };
      this.conversations.set(key, conversation);
    }
    return conversation;
  }
  private shownConversation() {
    return this.conversationFor(
      this.place?.gatewayId ?? 'local',
      // Known on a new chat too: its logins are this agent's, and its tabs may become a chat's.
      this.place?.chat?.profileId ?? this.place?.profileId,
      this.place?.chat?.sessionId,
    );
  }
  private blankPage(conversation: Conversation): BrowserPage {
    return {
      id: randomUUID(),
      conversation,
      url: '',
      title: '',
      queue: Promise.resolve(),
      busy: 0,
      usedAt: Date.now(),
      keepUntil: 0,
    };
  }
  private addPage(conversation: Conversation) {
    const page = this.blankPage(conversation);
    conversation.pages.push(page);
    return page;
  }

  showing(place: Showing | null) {
    const before = this.current;
    const wasIn = this.place?.chat?.sessionId;
    this.place = place;
    const next = place ? this.shownConversation() : undefined;
    if (next === before) {
      // The same tabs, adopted by the chat they became: the panel is waiting to hear it.
      if (place?.chat?.sessionId !== wasIn) this.changed();
      return;
    }
    const shown = this.shownPage();
    if (shown) shown.tip = this.pointer.position;
    this.detach();
    this.pointer.hide();
    this.current = next;
    // The panel of the new conversation says where its page goes, when it has one on screen.
    this.bounds = AWAY;
    if (before) this.leave(before);
    this.restorePointer();
    this.changed();
  }

  private restorePointer() {
    const tip = this.shownPage()?.tip;
    if (tip) this.pointer.restore(tip, this.visible());
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

  /** The page itself, made again from its address when it was let go. */
  private live(page: BrowserPage) {
    clearTimeout(page.evicting);
    page.usedAt = Date.now();
    if (page.view && !page.view.webContents.isDestroyed()) return page.view;
    const view = new WebContentsView({
      webPreferences: {
        partition: this.partition(page.conversation.scope),
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
      page.url = contents.getURL();
      page.title = contents.getTitle();
      // What an agent opens is its work, not the owner's history.
      if (!page.busy && allowed(page.url))
        this.places.titled(page.conversation.scope, page.url, page.title);
      this.changedIn(page);
    };
    const visited = () => {
      remember();
      if (!page.busy && allowed(page.url))
        this.places.visited(page.conversation.scope, page.url, page.title);
    };
    // A page in focus gets the keyboard before the app can. The app's own keys are passed up, and
    // only those: everything else, ⌘C and ⌘V among them, is the page's.
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.isAutoRepeat) return;
      const mac = process.platform === 'darwin';
      if (mac ? !input.meta || input.control : !input.control || input.meta) return;
      const letter = /^(?:Key|Digit)(.)$/.exec(input.code)?.[1]?.toLowerCase();
      const key = letter ?? input.key.toLowerCase();
      if (!this.shortcuts.has(`${input.alt}:${input.shift}:${key}`)) return;
      event.preventDefault();
      this.window()?.webContents.send('browser:shortcut', {
        key: input.key,
        code: input.code,
        shift: input.shift,
        alt: input.alt,
      });
    });
    contents.on('will-navigate', navigation);
    contents.on('will-redirect', navigation);
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('did-navigate', visited);
    contents.on('did-navigate-in-page', remember);
    contents.on('page-title-updated', remember);
    contents.on('did-start-loading', () => this.changedIn(page));
    contents.on('did-stop-loading', () => this.changedIn(page));
    contents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) {
        page.error = description;
        this.changedIn(page);
      }
    });
    page.view = view;
    page.restoring = page.url ? contents.loadURL(page.url).catch(() => {}) : undefined;
    return view;
  }

  /** Into the panel, in place of whatever was there. */
  private present(page: BrowserPage) {
    const window = this.window();
    if (!window) throw new Error('The Jian window is not open');
    const view = this.live(page);
    if (this.attached === view) return view;
    this.detach();
    window.contentView.addChildView(view);
    this.attached = view;
    this.pointer.raise();
    return view;
  }

  /** Out of the panel. A page an agent is working in carries on where no one sees it. */
  private detach() {
    const view = this.attached;
    this.attached = undefined;
    if (!view || view.webContents.isDestroyed()) return;
    const page = [...this.conversations.values()]
      .flatMap((conversation) => conversation.pages)
      .find((candidate) => candidate.view === view);
    if (page?.busy) {
      this.offScreen(page);
      return;
    }
    this.window()?.contentView.removeChildView(view);
    view.setVisible(false);
  }

  /** Rendering with no one watching, so an agent's clicks land where the page has them. */
  private offScreen(page: BrowserPage) {
    const window = this.window();
    if (!window) throw new Error('The Jian window is not open');
    const view = this.live(page);
    if (this.attached === view) this.attached = undefined;
    window.contentView.addChildView(view);
    view.setBounds({ x: OFF_SCREEN, y: 0, ...this.lastSize });
    view.setVisible(true);
  }

  private leave(conversation: Conversation) {
    // A browser opened outside any conversation belongs to that moment, not to the next chat.
    if (!conversation.sessionId)
      for (const page of [...conversation.pages]) if (!page.busy) this.drop(page);
    for (const page of conversation.pages) this.scheduleRelease(page);
    this.enforceLimit();
    if (!conversation.pages.length) this.conversations.delete(conversation.key);
  }

  private scheduleRelease(page: BrowserPage) {
    clearTimeout(page.evicting);
    if (!page.view) return;
    const wait = Math.max(this.limits.keepMs, page.keepUntil - Date.now());
    page.evicting = setTimeout(() => this.release(page), wait);
  }

  /** The tabs left alone longest go first; a tab of the conversation on screen comes back at once. */
  private enforceLimit() {
    const shown = this.shownPage();
    const away = [...this.conversations.values()]
      .flatMap((conversation) => conversation.pages)
      .filter((page) => page.view && page !== shown && page.busy === 0)
      .sort((a, b) => b.usedAt - a.usedAt);
    for (const old of away.slice(this.limits.liveBackground)) this.release(old);
  }

  /** Frees the page, the renderer process with it; its address is what brings it back. */
  private release(page: BrowserPage) {
    clearTimeout(page.evicting);
    if (page === this.shownPage() || page.busy > 0 || !page.view) return;
    const view = page.view;
    page.view = undefined;
    page.restoring = undefined;
    this.window()?.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
  }

  /** The owner closed it: nothing of it stays. */
  private drop(page: BrowserPage) {
    clearTimeout(page.evicting);
    const conversation = page.conversation;
    const at = conversation.pages.indexOf(page);
    conversation.pages.splice(at, 1);
    if (conversation.agentPageId === page.id) conversation.agentPageId = undefined;
    if (conversation.activeId === page.id)
      conversation.activeId = (conversation.pages[at] ?? conversation.pages[at - 1])?.id;
    const view = page.view;
    page.view = undefined;
    if (this.attached === view) this.attached = undefined;
    if (view) {
      this.window()?.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    }
  }

  /** A new tab of the conversation on screen. */
  open() {
    const conversation = this.current ?? this.shownConversation();
    this.current = conversation;
    const shown = this.shownPage();
    if (shown) shown.tip = this.pointer.position;
    this.pointer.hide();
    const page = this.addPage(conversation);
    conversation.activeId = page.id;
    conversation.focus = ++this.focusCount;
    this.layout(this.bounds);
    this.enforceLimit();
    this.changed();
    return page;
  }
  select(pageId: string) {
    const conversation = this.current;
    if (!conversation || conversation.activeId === pageId) return;
    if (!conversation.pages.some((page) => page.id === pageId)) return;
    const shown = this.shownPage();
    if (shown) shown.tip = this.pointer.position;
    this.pointer.hide();
    conversation.activeId = pageId;
    this.layout(this.bounds);
    this.restorePointer();
    this.enforceLimit();
    this.changed();
  }
  closePage(pageId: string) {
    const conversation = this.current;
    const page = conversation?.pages.find((candidate) => candidate.id === pageId);
    if (!conversation || !page) return;
    if (page === this.shownPage()) this.pointer.hide();
    this.drop(page);
    this.layout(this.bounds);
    this.restorePointer();
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
    const page = this.shownPage();
    const visible = this.visible();
    // A page is made when there is somewhere to show it, not when its conversation is opened.
    if (page && visible) this.present(page);
    else if (this.attached && this.attached !== page?.view) this.detach();
    this.view?.setBounds(this.bounds);
    this.view?.setVisible(visible);
    this.pointer.follow(this.bounds, visible);
  }
  private visible() {
    return Boolean(this.shownPage() && this.bounds.width > 0 && this.bounds.height > 0);
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
    const url = addressFrom(raw);
    if (!allowed(url)) throw new Error('Enter an HTTP or HTTPS address without credentials');
    const page = this.shownPage() ?? this.open();
    page.error = undefined;
    try {
      await this.live(page).webContents.loadURL(url);
    } catch (error) {
      // Another load took over, as this one does a tab still coming back: nothing went wrong.
      if ((error as { code?: string }).code !== 'ERR_ABORTED')
        page.error = error instanceof Error ? error.message : 'The page could not be opened';
    }
    this.layout(this.bounds);
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
      const page = this.shownPage();
      if (page) page.error = undefined;
      contents.reload();
    }
    if (command === 'hard-reload') {
      const page = this.shownPage();
      if (page) page.error = undefined;
      contents.reloadIgnoringCache();
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
    this.restoreTabs();
    app.on('before-quit', () => this.saved.flush());
    ipcMain.on('browser:adopt', (event, sessionId: unknown) => {
      trusted(event);
      if (typeof sessionId === 'string') this.adopt(sessionId);
    });
    ipcMain.on('browser:select', (event, pageId: unknown) => {
      trusted(event);
      if (typeof pageId === 'string') this.select(pageId);
    });
    ipcMain.on('browser:close', (event, pageId: unknown) => {
      trusted(event);
      if (typeof pageId === 'string') this.closePage(pageId);
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
    ipcMain.on('browser:shortcuts', (event, bindings: unknown) => {
      trusted(event);
      if (Array.isArray(bindings))
        this.shortcuts = new Set(bindings.filter((id) => typeof id === 'string'));
    });
    ipcMain.handle('browser:screenshot', async (event) => {
      trusted(event);
      const image = await this.view?.webContents.capturePage().catch(() => null);
      if (!image || image.isEmpty()) return false;
      await clipboard.write([
        new ClipboardItem({
          'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }),
        }),
      ]);
      return true;
    });
    ipcMain.handle('browser:clear', async (event, what: unknown) => {
      trusted(event);
      const conversation = this.current ?? this.shownConversation();
      const profile = session.fromPartition(this.partition(conversation.scope));
      if (what === 'history') {
        this.places.clearRecents(conversation.scope);
        for (const other of this.conversations.values()) {
          if (other.scope !== conversation.scope) continue;
          for (const page of other.pages) page.view?.webContents.navigationHistory.clear();
        }
      }
      if (what === 'cookies') await profile.clearStorageData({ storages: ['cookies'] });
      if (what === 'cache') await profile.clearCache();
      this.changed();
    });
    ipcMain.handle('browser:places', (event) => {
      trusted(event);
      return this.places.view((this.current ?? this.shownConversation()).scope);
    });
    ipcMain.handle('browser:favorite', (event, on: unknown, url: unknown, title: unknown) => {
      trusted(event);
      if (typeof url !== 'string' || !allowed(url)) return;
      this.places.setFavorite(
        (this.current ?? this.shownConversation()).scope,
        { url, title: typeof title === 'string' ? title : '' },
        on === true,
      );
      this.changed();
    });
    ipcMain.handle('browser:forget', (event, url: unknown) => {
      trusted(event);
      if (typeof url === 'string')
        this.places.forget((this.current ?? this.shownConversation()).scope, url);
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
   * One agent's work in a tab of its conversation, one thing at a time there. Conversations do not
   * wait for each other. A renderer stuck in a page's own loop may never answer: the race lets
   * that page fail its own work and frees the queue for what comes next.
   */
  private work<T>(
    scope: { profileId: string; sessionId: string },
    signal: AbortSignal | undefined,
    choose: (conversation: Conversation) => BrowserPage | undefined,
    run: (page: BrowserPage, shown: boolean, deadline: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const conversation = this.conversationFor('local', scope.profileId, scope.sessionId);
    const page =
      choose(conversation) ??
      conversation.pages.find((candidate) => candidate.id === conversation.agentPageId) ??
      conversation.pages.find((candidate) => candidate.id === conversation.activeId) ??
      this.addPage(conversation);
    conversation.agentPageId = page.id;
    const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(45000)]);
    const task = page.queue
      .catch(() => {})
      .then(async () => {
        deadline.throwIfAborted();
        page.busy += 1;
        page.keepUntil = Date.now() + this.limits.agentKeepMs;
        conversation.focus = ++this.focusCount;
        try {
          const shown = conversation === this.current;
          if (shown) {
            const before = this.shownPage();
            if (before !== page) {
              if (before) before.tip = this.pointer.position;
              this.pointer.hide();
            }
            conversation.activeId = page.id;
            this.layout(this.bounds);
            if (before !== page) this.restorePointer();
            this.changed();
          } else {
            conversation.activeId ??= page.id;
            this.offScreen(page);
          }
          this.live(page);
          await page.restoring;
          return await Promise.race([run(page, shown, deadline), rejectOnAbort(deadline)]);
        } finally {
          page.busy -= 1;
          if (page !== this.shownPage() && page.busy === 0) {
            if (page.view) {
              this.window()?.contentView.removeChildView(page.view);
              page.view.setVisible(false);
            }
            if (conversation !== this.current) this.scheduleRelease(page);
            this.enforceLimit();
          }
        }
      });
    page.queue = task;
    return task;
  }

  act(
    scope: { profileId: string; sessionId: string },
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<BrowserActionResult<Buffer>> {
    const input = browserActionInputSchema.parse(raw);
    if (input.action === 'open' && !allowed(input.url ?? ''))
      return Promise.reject(new Error('Enter an HTTP or HTTPS address without credentials'));
    return this.work(
      scope,
      signal,
      (conversation) =>
        input.action === 'open' && input.newTab ? this.addPage(conversation) : undefined,
      async (page, shown, deadline) => {
        const contents = this.live(page).webContents;
        // The panel opens because of the change `work` sent; a click needs the page where it lands.
        if (shown)
          for (let waited = 0; waited < 1500 && !this.visible() && !deadline.aborted; waited += 50)
            await delay(50);
        deadline.throwIfAborted();
        const onScreen = () => page === this.shownPage();
        return runBrowserAction(contents, input, {
          pointer: shown ? this.pointer : undefined,
          signal: deadline,
          bounds: () => (onScreen() ? this.bounds : this.lastSize),
          visible: () => (onScreen() ? this.visible() : true),
          offScreen: () => !onScreen(),
          open: async (url) => {
            page.error = undefined;
            await contents.loadURL(url);
          },
          // Only the page on screen may take the keyboard from the owner.
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
      },
    );
  }

  inspect(
    scope: { profileId: string; sessionId: string },
    raw: PageInspectionInput,
    signal?: AbortSignal,
  ): Promise<InspectionCapture> {
    const input = pageInspectionInputSchema.parse(raw);
    if (!allowed(input.url))
      return Promise.reject(new Error('Only HTTP and HTTPS pages can be inspected'));
    return this.work(
      scope,
      signal,
      // Reusing means the tab the owner has that page in, whichever is in front.
      (conversation) =>
        input.reusePage
          ? conversation.pages.find((page) => page.url && pageKey(page.url) === pageKey(input.url))
          : undefined,
      async (page, _shown, deadline) =>
        inspectContents(this.live(page).webContents, input, deadline, {
          inspecting: this.inspecting,
          cancelled: () => {
            page.error = 'The browser inspection was cancelled or timed out';
            if (!input.reusePage) {
              const view = page.view;
              page.view = undefined;
              if (this.attached === view) this.attached = undefined;
              if (view) {
                this.window()?.contentView.removeChildView(view);
                if (!view.webContents.isDestroyed())
                  view.webContents.close({ waitForBeforeUnload: false });
              }
            }
            this.changedIn(page);
          },
          finished: () => this.changedIn(page),
        }),
    );
  }
}
