import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type SavedConversation = {
  key: string;
  scope: string;
  sessionId: string;
  activeId?: string;
  agentPageId?: string;
  pages: Array<{ id: string; url: string; title: string }>;
};

const KEPT_CONVERSATIONS = 100;
const WRITE_AFTER_MS = 500;

/**
 * The tabs each conversation had open, for when the app opens again. Addresses only: a page is
 * made when its conversation is on screen, so a long list costs nothing at launch.
 */
export class BrowserTabsFile {
  private timer?: NodeJS.Timeout;
  private latest?: () => SavedConversation[];
  constructor(private readonly file: () => string) {}

  read(): SavedConversation[] {
    try {
      const saved: unknown = JSON.parse(readFileSync(this.file(), 'utf8'));
      if (!Array.isArray(saved)) return [];
      return saved.filter(
        (entry: SavedConversation) =>
          typeof entry?.key === 'string' &&
          typeof entry.scope === 'string' &&
          typeof entry.sessionId === 'string' &&
          Array.isArray(entry.pages) &&
          entry.pages.every((page) => typeof page?.id === 'string' && typeof page.url === 'string'),
      );
    } catch {
      // Nothing saved, or nothing readable: the conversations open with no tabs.
      return [];
    }
  }

  /** Pages change a lot while loading, and only where they ended up matters. */
  save(current: () => SavedConversation[]) {
    this.latest = current;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), WRITE_AFTER_MS);
  }

  flush() {
    clearTimeout(this.timer);
    if (!this.latest) return;
    const file = this.file();
    try {
      mkdirSync(dirname(file), { recursive: true });
      // Replaced whole, so a crash leaves the last good file; readable by this user alone.
      writeFileSync(`${file}.tmp`, JSON.stringify(this.latest().slice(-KEPT_CONVERSATIONS)), {
        mode: 0o600,
      });
      renameSync(`${file}.tmp`, file);
    } catch {
      // Tabs are a convenience: this session goes on without having saved them.
    }
    this.latest = undefined;
  }
}
