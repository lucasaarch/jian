import { terminalInputSchema, terminalSizeSchema, terminalWriteSchema } from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import type { Devices } from '../devices/service.js';
import type { ProfileParams } from '../http/params.js';
import type { ProfileReader } from '../profiles/port.js';
import type { Terminals } from './service.js';
import { type TerminalPlaces, terminalStart } from './start.js';

type TerminalParams = ProfileParams & { terminalId: string };

type TerminalRouteServices = TerminalPlaces & {
  profiles: ProfileReader;
  devices: Pick<Devices, 'authenticate'>;
  terminals: Terminals;
  /** How long a quiet stream waits before a heartbeat, in ms; tests shorten it. */
  heartbeatMs?: number;
};

const HEARTBEAT_MS = 25_000;
/**
 * What a stream may hold unsent beyond the scrollback it opened with, in bytes. A reader slower
 * than the shell is cut off instead of buffered without end: it opens the stream again and gets
 * the scrollback, which is all a screen needs of what it missed.
 */
const STREAM_BUFFER = 1024 * 1024;

export function registerTerminalRoutes(app: FastifyInstance, deps: TerminalRouteServices): void {
  const base = '/v1/profiles/:profileId/terminals';

  app.get<{ Params: ProfileParams }>(base, async (request) => {
    await deps.profiles.profile(request.params.profileId);

    return deps.terminals.list(request.params.profileId);
  });

  app.post<{ Params: ProfileParams }>(base, async (request, reply) => {
    const { profileId } = request.params;

    await deps.profiles.profile(profileId);

    const { sessionId, ...size } = terminalInputSchema.parse(request.body);
    const start = await terminalStart(deps, profileId, sessionId);

    return reply.code(201).send(await deps.terminals.open(profileId, start, size, sessionId));
  });

  app.get<{ Params: TerminalParams }>(`${base}/:terminalId/stream`, async (request, reply) => {
    const { profileId, terminalId } = request.params;

    await deps.profiles.profile(profileId);

    const raw = reply.raw;
    const send = (event: string, data: unknown) =>
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    let allowed = STREAM_BUFFER;
    let beat: ReturnType<typeof setInterval> | undefined;

    // Before the reply is taken over, so a terminal that is not this profile's is a plain 404.
    const watching = deps.terminals.watch(profileId, terminalId, (event) => {
      if (event.type === 'output') {
        if (raw.writableLength > allowed) finish();
        else send('output', { data: event.data });
        return;
      }

      if (event.type === 'exit') send('exit', { exitCode: event.exitCode });
      finish();
    });

    // Stops listening before the response ends: a write after the end is an error of its own.
    function finish() {
      watching.stop();
      clearInterval(beat);
      if (!raw.writableEnded) raw.end();
    }

    reply.hijack();
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      // no-transform keeps a compressing proxy, the web server's included, from holding
      // output back to fill a gzip block.
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    raw.on('close', finish);
    raw.write(': connected\n\n');

    // In the same turn as the watch began: nothing printed since is missed or sent twice.
    if (watching.scrollback) send('output', { data: watching.scrollback });
    if (watching.exitCode !== undefined) {
      send('exit', { exitCode: watching.exitCode });
      finish();

      return;
    }

    allowed += raw.writableLength;
    beat = setInterval(async () => {
      // A phone was let in when the stream opened; a stream outlives any request, so its token
      // is checked again on every heartbeat, and a revoked phone reads no more.
      if (request.device) {
        const still = await deps.devices
          .authenticate(request.headers.authorization ?? '')
          .catch(() => undefined);

        if (still !== request.device) {
          finish();

          return;
        }
      }

      if (!raw.writableEnded) raw.write(': heartbeat\n\n');
    }, deps.heartbeatMs ?? HEARTBEAT_MS);
  });

  app.post<{ Params: TerminalParams }>(`${base}/:terminalId/input`, async (request, reply) => {
    const { profileId, terminalId } = request.params;

    await deps.profiles.profile(profileId);
    deps.terminals.write(profileId, terminalId, terminalWriteSchema.parse(request.body).data);

    return reply.code(204).send();
  });

  app.post<{ Params: TerminalParams }>(`${base}/:terminalId/resize`, async (request, reply) => {
    const { profileId, terminalId } = request.params;

    await deps.profiles.profile(profileId);
    deps.terminals.resize(profileId, terminalId, terminalSizeSchema.parse(request.body));

    return reply.code(204).send();
  });

  app.delete<{ Params: TerminalParams }>(`${base}/:terminalId`, async (request, reply) => {
    const { profileId, terminalId } = request.params;

    await deps.profiles.profile(profileId);
    deps.terminals.close(profileId, terminalId);

    return reply.code(204).send();
  });
}
