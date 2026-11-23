import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { ActionError, type Failure } from './outcome.ts';

/** What a native helper answers to every request: one JSON object per line. */
export type HelperReply = { ok?: boolean; error?: string } & Record<string, unknown>;

type Pending = { resolve(reply: HelperReply): void; reject(error: Error): void };

const CODES: ReadonlySet<string> = new Set([
  'perm_denied',
  'invalid_args',
  'timeout',
  'policy_denied',
  'screen_changed',
  'failed',
]);
const PERMISSIONS: ReadonlySet<string> = new Set([
  'accessibility',
  'screen_recording',
  'elevation',
]);

/**
 * What the helper said of its own failure. Anything it left out, or worded in a way this worker
 * does not know, reads as the cautious case: failed, and maybe delivered.
 */
function failureOfReply(reply: HelperReply): Failure {
  const { code, delivery, permission } = reply;
  return {
    code: typeof code === 'string' && CODES.has(code) ? (code as Failure['code']) : 'failed',
    delivery: delivery === 'not_delivered' ? 'not_delivered' : 'uncertain',
    ...(typeof permission === 'string' && PERMISSIONS.has(permission)
      ? { permission: permission as Failure['permission'] }
      : {}),
  };
}

/**
 * The conversation with a native helper process. The helpers answer strictly in order, one line
 * per request, so a queue of waiting requests is the whole protocol.
 */
export class HelperChannel {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending: Pending[] = [];
  private buffer = '';
  private closed = false;
  /** Why the helper was stopped, when this worker stopped it: told to whoever was waiting. */
  private stopped: ActionError | null = null;

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
      this.failAll(this.stopped ?? new Error(message));
      onClose();
    };
    child.on('exit', () => ended('Computer-use helper exited unexpectedly.'));
    // A helper that dies with a request on its way fails the write with EPIPE, which, unheard,
    // would end the whole worker. One that stopped reading is of no more use, so it goes too.
    child.stdin.on('error', () => {
      ended('Computer-use helper stopped reading its requests.');
      child.kill('SIGKILL');
    });
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
      const entry: Pending = { resolve, reject };
      this.pending.push(entry);
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        const index = this.pending.indexOf(entry);
        if (index >= 0) this.pending.splice(index, 1);
        entry.reject(error);
      });
    });
  }

  /** A request whose `ok: false` reply is an error, worded by the helper or by `failure`. */
  async call(payload: Record<string, unknown>, failure: string): Promise<HelperReply> {
    const reply = await this.request(payload);
    if (!reply.ok) throw new ActionError(reply.error || failure, failureOfReply(reply));
    return reply;
  }

  kill(): void {
    this.child.kill('SIGTERM');
  }

  /**
   * Stops a helper that is not answering, at once: SIGKILL, since one stuck in a system call
   * may never act on SIGTERM. The replies come in order, so nothing behind the stuck request
   * could be answered either: whoever waits is told `message` as a timeout, and that what the
   * helper was doing may have reached the screen.
   */
  stop(message: string): void {
    if (this.closed) return;
    this.stopped = new ActionError(message, { code: 'timeout', delivery: 'uncertain' });
    this.child.kill('SIGKILL');
    // The exit event is what closes the channel; whoever waits need not wait for it too.
    this.failAll(this.stopped);
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

  private failAll(error: Error): void {
    for (const entry of this.pending.splice(0)) entry.reject(error);
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
