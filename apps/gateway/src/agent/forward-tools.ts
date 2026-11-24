import type { Run } from '@jian/contracts';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import { GatewayError } from '../core/errors.js';
import type { Forwards } from '../forwards/service.js';

/**
 * Making a server of this gateway's machine reachable from the owner's computer, offered only
 * where `Services.forwards` exists (a server gateway whose process also runs the agents). A
 * conversation aimed at one machine forwards to that machine alone.
 */
export function forwardTools(
  run: Pick<Run, 'profileId' | 'sessionId'>,
  forwards: Pick<Forwards, 'create' | 'closePort'>,
  targetMachineId?: string,
): ToolSet {
  return {
    forward_port: tool({
      description:
        "Make a port of the machine this gateway runs on reachable on `localhost` of the owner's computer, through the Jian desktop app (or Jian Remote) running there: for a dev server, a preview or a database you started here that the owner wants to open. Give the port your server listens on; only this machine's own loopback is reached. The computer picks a free local port and opens it on its own, only on 127.0.0.1. Answers where it is open, e.g. http://localhost:41234, which is what to tell the owner. It ends when the owner stops it, when you call close_forward, or when the gateway restarts. Without `machine`, the one online computer running the Jian app is used; otherwise give a machine's name or id from list_remote_machines.",
      inputSchema: z.object({
        port: z.number().int().min(1).max(65_535),
        machine: z.string().min(1).max(200).optional(),
      }),
      execute: async ({ port, machine }) => {
        if (targetMachineId && machine && machine !== targetMachineId) {
          throw new GatewayError(
            403,
            'This conversation is restricted to its selected remote machine',
          );
        }
        const forward = await forwards.create(run, { port, machine: machine ?? targetMachineId });
        const base = { id: forward.id, remotePort: port, machine: forward.machineName };
        if (forward.status === 'open') {
          const url = `http://localhost:${forward.localPort}`;
          return {
            ...base,
            status: 'open',
            localPort: forward.localPort,
            url,
            message: `Open on ${forward.machineName} at ${url}`,
          };
        }
        if (forward.status === 'failed') {
          return {
            ...base,
            status: 'failed',
            error: forward.error,
            message: `${forward.machineName} could not open it: ${forward.error}`,
          };
        }
        return {
          ...base,
          status: 'waiting',
          message: `waiting for ${forward.machineName}: it has not opened the port yet. The forward stays, and the owner sees it above the composer.`,
        };
      },
    }),
    close_forward: tool({
      description:
        'Stop forwarding a port of this server that forward_port opened in this conversation: its connections close and the computer frees the local port.',
      inputSchema: z.object({ port: z.number().int().min(1).max(65_535) }),
      execute: async ({ port }) => {
        const closed = await forwards.closePort(run, port);
        return closed
          ? { ok: true, closed }
          : { ok: false, error: `No forward of port ${port} is open in this conversation.` };
      },
    }),
  };
}
