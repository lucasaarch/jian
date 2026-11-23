import { createWriteStream, renameSync, statSync, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';

/** Past this size the log moves aside to local-gateway.old.log: two files at most. */
const KEEP_BYTES = 2 * 1024 * 1024;
/** What may wait for a slow disk, in bytes; past it lines are dropped, not held in memory. */
const MAX_UNWRITTEN_BYTES = 1024 * 1024;
/** How many of its last lines say why the gateway ended. */
const LAST_LINES = 12;

export const localLogPath = () => join(app.getPath('logs'), 'local-gateway.log');
const oldLogPath = () => join(app.getPath('logs'), 'local-gateway.old.log');

/**
 * What the local gateway writes, kept in the app's log folder: a packaged app has no console, so
 * without this a gateway that cannot start leaves nothing to read. The last lines are also kept
 * in memory, to say in the window why it ended.
 */
export class LocalLog {
  private stream?: WriteStream;
  private lines: string[] = [];
  private size = 0;

  async open(): Promise<void> {
    await mkdir(app.getPath('logs'), { recursive: true });
    try {
      this.size = statSync(localLogPath()).size;
    } catch {
      // No log yet.
    }
    if (this.size > KEEP_BYTES) this.moveAside();
    else this.startFile();
  }

  /** A log that cannot be written must not take the app down: a full disk is reason enough. */
  private startFile(): void {
    const stream = createWriteStream(localLogPath(), { flags: 'a', mode: 0o600 });
    stream.on('error', () => {
      if (this.stream === stream) this.stream = undefined;
    });
    this.stream = stream;
  }

  /** The stream being replaced goes on to the renamed file with what it still holds. */
  private moveAside(): void {
    const previous = this.stream;
    this.size = 0;
    try {
      renameSync(localLogPath(), oldLogPath());
    } catch {
      // Kept in the same file, and tried again after another KEEP_BYTES.
      if (previous) return;
    }
    this.startFile();
    previous?.end();
  }

  /** A new start: a heading in the file, and the lines of the one before forgotten. */
  started(version: string): void {
    this.lines = [];
    if (!this.stream) this.startFile();
    this.append(`\n--- ${new Date().toISOString()} Jian ${version} starts its gateway ---\n`);
  }

  private append(text: string): void {
    const stream = this.stream;
    if (!stream || stream.writableLength > MAX_UNWRITTEN_BYTES) return;
    stream.write(text);
    this.size += Buffer.byteLength(text);
    if (this.size > KEEP_BYTES) this.moveAside();
  }

  write(text: string): void {
    this.append(text);
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
