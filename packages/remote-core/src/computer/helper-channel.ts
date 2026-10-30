import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/** What a native helper answers to every request: one JSON object per line. */
export type HelperReply = { ok?: boolean; error?: string } & Record<string, unknown>;

type Pending = { resolve(reply: HelperReply): void; reject(error: Error): void };

/**
 * The conversation with a native helper process. The helpers answer strictly in order, one line
 * per request, so a queue of waiting requests is the whole protocol.
 */
export class HelperChannel {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending: Pending[] = [];
  private buffer = '';
  private closed = false;

  /** `onClose` runs once, whether the helper exits, fails to start, or is closed. */
  constructor(child: ChildProcessWithoutNullStreams, onClose: () => void) {
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.receive(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) console.error(text);
    });
    const ended = (message: string) => {
      if (this.closed) return;
      this.closed = true;
      this.failAll(message);
      onClose();
    };
    child.on('exit', () => ended('Computer-use helper exited unexpectedly.'));
    // Without a listener, a helper that cannot start (no python3, no PowerShell) would take
    // the whole worker down with an unhandled 'error' event.
    child.on('error', (error) => ended(`Computer-use helper failed: ${error.message}`));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get alive(): boolean {
    return !this.closed && !this.child.killed;
  }

  request(payload: Record<string, unknown>): Promise<HelperReply> {
    return new Promise((resolve, reject) => {
      if (!this.alive) {
        reject(new Error('Computer-use helper is not running.'));
        return;
      }
      const entry = { resolve, reject };
      this.pending.push(entry);
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        const index = this.pending.indexOf(entry);
        if (index >= 0) this.pending.splice(index, 1);
        reject(error);
      });
    });
  }

  /** A request whose `ok: false` reply is an error, worded by the helper or by `failure`. */
  async call(payload: Record<string, unknown>, failure: string): Promise<HelperReply> {
    const reply = await this.request(payload);
    if (!reply.ok) throw new Error(reply.error || failure);
    return reply;
  }

  kill(): void {
    this.child.kill('SIGTERM');
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    for (let index = this.buffer.indexOf('\n'); index >= 0; index = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      const next = this.pending.shift();
      const reply = parseReply(line);
      if (reply) next?.resolve(reply);
      else next?.reject(new Error('Computer-use helper returned invalid JSON.'));
    }
  }

  private failAll(message: string): void {
    for (const entry of this.pending.splice(0)) entry.reject(new Error(message));
  }
}

function parseReply(line: string): HelperReply | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null ? (value as HelperReply) : null;
  } catch {
    return null;
  }
}
