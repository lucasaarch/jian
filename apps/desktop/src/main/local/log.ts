import { createWriteStream, statSync, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';

/** Past this size the log starts over when the app does: what matters is the latest start. */
const KEEP_BYTES = 2 * 1024 * 1024;
/** How many of its last lines say why the gateway ended. */
const LAST_LINES = 12;

export const localLogPath = () => join(app.getPath('logs'), 'local-gateway.log');

/**
 * What the local gateway writes, kept in the app's log folder: a packaged app has no console, so
 * without this a gateway that cannot start leaves nothing to read. The last lines are also kept
 * in memory, to say in the window why it ended.
 */
export class LocalLog {
  private stream?: WriteStream;
  private lines: string[] = [];

  async open(): Promise<void> {
    const path = localLogPath();
    await mkdir(app.getPath('logs'), { recursive: true });
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      // No log yet.
    }
    this.stream = createWriteStream(path, { flags: size > KEEP_BYTES ? 'w' : 'a', mode: 0o600 });
  }

  /** A new start: a heading in the file, and the lines of the one before forgotten. */
  started(version: string): void {
    this.lines = [];
    this.stream?.write(
      `\n--- ${new Date().toISOString()} Jian ${version} starts its gateway ---\n`,
    );
  }

  write(text: string): void {
    this.stream?.write(text);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      this.lines.push(line);
      if (this.lines.length > LAST_LINES) this.lines.shift();
    }
  }

  /** Why it ended, in its own last words, or only how, when it said nothing. */
  reason(code: number): string {
    const said = this.lines.join('\n').trim();
    return said || `It ended with exit code ${code} without saying why.`;
  }
}
