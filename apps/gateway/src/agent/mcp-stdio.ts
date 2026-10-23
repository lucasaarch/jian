import { spawn } from 'node:child_process';
import type { MCPTransport } from '@ai-sdk/mcp';

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
}): MCPTransport {
  let child: ReturnType<typeof spawn> | undefined;
  let buffer = '';
  let closed = Promise.resolve();

  // Observe `close`, not kill()'s boolean: a signal being sent proves neither process exit
  // nor closed pipes. A child can ignore SIGTERM or leave inherited pipes open.
  const waitForClose = async (confirmation: Promise<void>): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        confirmation.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 1_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const transport: MCPTransport = {
    async start() {
      if (child) {
        return;
      }

      child = spawn(options.command, [...options.args], {
        // The command's own environment plus what the owner configured; a server usually reads
        // its credential from a variable rather than from an argument anyone could see.
        env: { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: options.signal,
      });

      closed = new Promise<void>((resolve) => {
        child?.once('close', () => {
          resolve();
          transport.onclose?.();
        });
      });
      child.on('error', (error) => transport.onerror?.(error));

      // Diagnostics belong on stderr by the protocol's own rule; they are not messages.
      child.stderr?.on('data', () => undefined);

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        buffer += chunk;

        // One JSON-RPC message per line, and a partial line waits for the rest of itself.
        for (;;) {
          const end = buffer.indexOf('\n');

          if (end < 0) {
            return;
          }

          const line = buffer.slice(0, end).trim();

          buffer = buffer.slice(end + 1);

          if (!line) {
            continue;
          }

          try {
            transport.onmessage?.(JSON.parse(line));
          } catch (error) {
            transport.onerror?.(error as Error);
          }
        }
      });
    },

    async send(message) {
      if (!child?.stdin?.writable) {
        throw new Error('The MCP command is not running');
      }

      child.stdin.write(`${JSON.stringify(message)}\n`);
    },

    async close() {
      const closing = child;
      if (!closing) return;

      const confirmation = closed;
      closing.kill('SIGTERM');
      if (!(await waitForClose(confirmation))) {
        closing.kill('SIGKILL');
        if (!(await waitForClose(confirmation))) {
          // Retain the handle so a retry can still confirm termination. The runtime must
          // keep its execution marker when cleanup cannot be established.
          throw new Error('MCP command termination could not be confirmed');
        }
      }

      if (child === closing) {
        child = undefined;
        buffer = '';
      }
    },
  };

  return transport;
}
