import { FORWARD_CHUNK_MAX, forwardChunkSchema, forwardStateInputSchema } from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import type { ProfileParams, SessionParams } from '../http/params.js';
import type { ProfileReader } from '../profiles/port.js';
import type { Sessions } from '../sessions/service.js';
import type { Forwards } from './service.js';

type ForwardRouteServices = {
  /** Absent where forwards are not offered: the routes then answer that nothing is open. */
  forwards?: Forwards;
  profiles: ProfileReader;
  sessions: Pick<Sessions, 'session'>;
  /** How long a quiet stream waits before a heartbeat, in ms; tests shorten it. */
  heartbeatMs?: number;
};

type WorkerParams = { machineId: string; forwardId: string };
type ConnectionParams = WorkerParams & { connectionId: string };

/** Under the 30 s a connection may sit idle, so a proxy in between keeps the stream open. */
const HEARTBEAT_MS = 25_000;
const base = '/v1/remote/worker/:machineId/forwards/:forwardId';

/**
 * The tunnel's routes. A worker proves itself with its machine token on each one, as on a poll;
 * they are not rate limited because a busy tunnel makes far more requests than a person, and
 * only a machine that holds a token and a forward assigned to it gets past the first line.
 */
export function registerForwardRoutes(app: FastifyInstance, deps: ForwardRouteServices): void {
  const { forwards } = deps;
  const noLimit = { config: { rateLimit: false as const } };
  const auth = (headers: { authorization?: string }) => headers.authorization ?? '';

  app.get<{ Params: SessionParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId/forwards',
    async (request) => {
      const { profileId, sessionId } = request.params;
      await deps.profiles.profile(profileId);
      await deps.sessions.session(profileId, sessionId);
      return forwards?.list(profileId, sessionId) ?? [];
    },
  );

  app.delete<{ Params: ProfileParams & { forwardId: string } }>(
    '/v1/profiles/:profileId/forwards/:forwardId',
    async (request, reply) => {
      const { profileId, forwardId } = request.params;
      await deps.profiles.profile(profileId);
      if (!forwards) return reply.code(404).send({ error: 'Forward not found' });
      await forwards.close(profileId, forwardId);
      return reply.code(204).send();
    },
  );

  if (!forwards) return;

  app.post<{ Params: WorkerParams }>(`${base}/state`, noLimit, async (request) => {
    const { machineId, forwardId } = request.params;
    await forwards.report(
      machineId,
      auth(request.headers),
      forwardId,
      forwardStateInputSchema.parse(request.body),
    );
    return { ok: true as const };
  });

  app.post<{ Params: WorkerParams }>(`${base}/connections`, noLimit, async (request, reply) => {
    const { machineId, forwardId } = request.params;
    const id = await forwards.open(machineId, auth(request.headers), forwardId);
    return reply.code(201).send({ id });
  });

  app.get<{ Params: ConnectionParams }>(
    `${base}/connections/:connectionId/stream`,
    noLimit,
    async (request, reply) => {
      const { machineId, forwardId, connectionId } = request.params;
      // Before the reply is taken over, so a refusal is a plain 404 or 401.
      const socket = await forwards.socket(
        machineId,
        auth(request.headers),
        forwardId,
        connectionId,
      );
      const raw = reply.raw;
      const send = (event: string, data: unknown) =>
        raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      reply.hijack();
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        // no-transform keeps a compressing proxy, the web server's included, from holding bytes
        // back to fill a gzip block.
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      raw.write(': connected\n\n');

      const beat = setInterval(() => {
        if (!raw.writableEnded) raw.write(': heartbeat\n\n');
      }, deps.heartbeatMs ?? HEARTBEAT_MS);
      const onData = (chunk: Buffer) => {
        send('data', { data: chunk.toString('base64') });
        // A reader slower than the server pauses it instead of buffering without end.
        if (raw.writableNeedDrain) {
          socket.pause();
          raw.once('drain', () => socket.resume());
        }
      };
      const finish = () => {
        clearInterval(beat);
        socket.off('data', onData);
        if (!raw.writableEnded) {
          send('end', {});
          raw.end();
        }
      };
      socket.on('data', onData);
      socket.once('close', finish);
      // The stream dropping is the connection closing, whoever dropped it.
      raw.once('close', () => {
        clearInterval(beat);
        socket.destroy();
      });
      if (socket.destroyed) finish();
      else socket.resume();
    },
  );

  app.post<{ Params: ConnectionParams }>(
    `${base}/connections/:connectionId/data`,
    // Base64 of the largest chunk, and the JSON around it.
    { ...noLimit, bodyLimit: Math.ceil(FORWARD_CHUNK_MAX / 3) * 4 + 1024 },
    async (request, reply) => {
      const { machineId, forwardId, connectionId } = request.params;
      const { data } = forwardChunkSchema.parse(request.body);
      await forwards.write(
        machineId,
        auth(request.headers),
        forwardId,
        connectionId,
        Buffer.from(data, 'base64'),
      );
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: ConnectionParams }>(
    `${base}/connections/:connectionId`,
    noLimit,
    async (request, reply) => {
      const { machineId, forwardId, connectionId } = request.params;
      await forwards.closeConnection(machineId, auth(request.headers), forwardId, connectionId);
      return reply.code(204).send();
    },
  );
}
