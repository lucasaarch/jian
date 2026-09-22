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

      child.on('error', (error) => transport.onerror?.(error));
      child.on('close', () => transport.onclose?.());

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
      child?.kill();
      child = undefined;
      buffer = '';
    },
  };

  return transport;
}
