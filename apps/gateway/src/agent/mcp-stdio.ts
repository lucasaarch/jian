import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { MCPTransport } from '@ai-sdk/mcp';

const MB = 1024 * 1024;
/** The longest message a command may print, in bytes, as an HTTP server's (`mcp-fetch.ts`). */
const MAX_LINE_BYTES = 64 * MB;
/** What may wait for a command to read it, in bytes. Past it, the command has stopped reading. */
const MAX_UNSENT_BYTES = 16 * MB;
/**
 * Messages that may wait likewise. A queued message costs far more than its bytes: a flood of
 * 40-byte pings reached half a gigabyte of heap before the byte limit alone noticed.
 */
const MAX_UNSENT_MESSAGES = 4_096;

/**
 * Whole lines out of a stream of bytes, each at most `maxBytes`. A newline byte never occurs inside
 * a UTF-8 character, so lines are cut before decoding. The parts of a long line are kept apart and
 * joined once: growing one string and searching it for each chunk was quadratic.
 */
function lineReader(maxBytes: number, line: (text: string) => void, overflow: () => void) {
  let parts: Buffer[] = [];
  let held = 0;

  return (chunk: Buffer) => {
    let start = 0;

    for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10, start)) {
      const last = chunk.subarray(start, end);

      if (held + last.length > maxBytes) {
        parts = [];
        held = 0;
        overflow();
        return;
      }

      const whole = parts.length ? Buffer.concat([...parts, last]) : last;

      parts = [];
      held = 0;
      start = end + 1;
      line(whole.toString('utf8'));
    }

    if (start < chunk.length) {
      held += chunk.length - start;
      if (held > maxBytes) {
        parts = [];
        held = 0;
        overflow();
        return;
      }
      parts.push(chunk.subarray(start));
    }
  };
}

/**
 * A server that runs as a command on this machine and speaks JSON-RPC over its own pipes.
 *
 * The SDK ships no stdio transport, and this is the shape most MCP servers are distributed in.
 * It runs with the privileges of whoever started the gateway, like every other command the
 * gateway runs, so the owner configuring one is the whole authorization.
 */
export function stdioTransport(options: {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  signal: AbortSignal;
  /** What the command says on stderr, as it says it. */
  said?: (text: string) => void;
}): MCPTransport {
  let child: ReturnType<typeof spawn> | undefined;
  let draining: Promise<void> | undefined;
  let unsent = 0;
  // Requests sent and not answered: a command given up on still owes each of them a reason.
  const waiting = new Set<string | number>();

  /** Until `stdin` takes more, or closes. One wait, however many messages are behind it. */
  const drained = (stdin: Writable) => {
    draining ??= new Promise<void>((done) => {
      const finish = () => {
        stdin.off('drain', finish);
        stdin.off('close', finish);
        draining = undefined;
        done();
      };
      stdin.once('drain', finish);
      stdin.once('close', finish);
    });
    return draining;
  };

  /** Gives up on the command: what it was asked is answered with why, and it is stopped. */
  const fail = (reason: string) => {
    const unanswered = [...waiting];

    waiting.clear();
    for (const id of unanswered) {
      try {
        transport.onmessage?.({ jsonrpc: '2.0', id, error: { code: -32000, message: reason } });
      } catch {
        // A request that stopped waiting has no handler left, which the client reports by throwing.
      }
    }
    transport.onerror?.(new Error(reason));
    void transport.close();
  };

  const transport: MCPTransport = {
    async start() {
      if (child) {
        return;
      }

      const spawned = spawn(options.command, [...options.args], {
        // The command's own environment plus what the owner configured; a server usually reads
        // its credential from a variable rather than from an argument anyone could see.
        env: { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: options.signal,
      });

      child = spawned;
      spawned.on('error', (error) => transport.onerror?.(error));
      // A command replaced by a newer start has nothing to say about the one running now.
      spawned.on('close', () => {
        if (!child || child === spawned) transport.onclose?.();
      });
      // A write to a command that just died fails here; with no listener it ends the gateway.
      spawned.stdin?.on('error', (error) => transport.onerror?.(error));

      // Diagnostics belong on stderr by the protocol's own rule; they are not messages.
      spawned.stderr?.setEncoding('utf8');
      spawned.stderr?.on('data', (chunk: string) => options.said?.(chunk));

      // One JSON-RPC message per line, and a partial line waits for the rest of itself.
      const read = lineReader(
        MAX_LINE_BYTES,
        (text) => {
          const line = text.trim();

          if (!line) {
            return;
          }

          try {
            const message = JSON.parse(line);

            if (message && !('method' in message)) waiting.delete(message.id);
            transport.onmessage?.(message);
          } catch (error) {
            transport.onerror?.(error as Error);
          }
        },
        () =>
          fail(`MCP response too large: the command printed a line over ${MAX_LINE_BYTES / MB} MB`),
      );

      spawned.stdout?.on('data', (chunk: Buffer) => {
        if (child === spawned) read(chunk);
      });
    },

    async send(message) {
      const stdin = child?.stdin;

      if (!stdin?.writable) {
        throw new Error('The MCP command is not running');
      }

      if (stdin.writableLength > MAX_UNSENT_BYTES || unsent >= MAX_UNSENT_MESSAGES) {
        fail('The MCP command stopped reading what it is sent');
        // This message never left, so the call is safe to send again to a new command.
        throw new Error('The MCP command is not running');
      }

      if ('method' in message && 'id' in message) waiting.add(message.id);
      unsent += 1;
      const flowing = stdin.write(`${JSON.stringify(message)}\n`, () => {
        unsent -= 1;
      });
      if (!flowing) await drained(stdin);
    },

    async close() {
      const closing = child;

      child = undefined;
      waiting.clear();
      closing?.kill();
      // The pipes too: a wrapper like `npx` can die and leave its server holding them, still
      // printing into a stream nobody reads.
      closing?.stdin?.destroy();
      closing?.stdout?.destroy();
      closing?.stderr?.destroy();
    },
  };

  return transport;
}
