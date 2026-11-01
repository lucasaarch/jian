import { type GatewayEvent, STREAM_OPENED_EVENT } from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GatewayError } from '../core/errors.js';
import { EVENTS_PAGE, latestEventId, readEvents, readProgress } from '../core/event-feed.js';
import type { ProfileReader } from '../profiles/port.js';
import type { Store } from '../storage/database.js';

type ProfileParams = { profileId: string };

interface EventOptions {
  profiles: ProfileReader;
  store: Store;
  token: string;
  maxStreams?: number;
}

/**
 * What a stream says of an event: that it happened and which conversation it concerns, which is
 * what a client needs to read that conversation again. A step's data holds tool inputs and diffs
 * of any size, and a stream shares its HTTP/2 connection with all the client's other requests.
 * The whole event stays in the paged feed. The inspector's focus is the one a client acts on by
 * itself, and its data is a few short fields.
 */
function toldOf(event: GatewayEvent): GatewayEvent {
  if (event.type === 'conversation.inspector.focus') return event;
  const { sessionId, parentSessionId } = (event.data ?? {}) as {
    sessionId?: unknown;
    parentSessionId?: unknown;
  };

  return {
    ...event,
    data: {
      ...(sessionId ? { sessionId } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
    },
  };
}

/** Each connection owns its cursor; durable events survive disconnects and worker restarts. */
export function registerEventRoutes(app: FastifyInstance, options: EventOptions) {
  let streams = 0;
  const cursorSchema = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

  app.get<{ Params: ProfileParams; Querystring: { after?: string } }>(
    '/v1/profiles/:profileId/events',
    async (request) => {
      await options.profiles.profile(request.params.profileId);

      return readEvents(
        options.store.db,
        request.params.profileId,
        cursorSchema.parse(request.query.after ?? 0),
      );
    },
  );

  app.get<{ Params: ProfileParams; Querystring: { after?: string } }>(
    '/v1/profiles/:profileId/events/stream',
    async (request, reply) => {
      const profileId = request.params.profileId;

      await options.profiles.profile(profileId);

      // No cursor means from now. The feed is never trimmed, so starting at the beginning would
      // send all of it on every open, over the one HTTP/2 connection all of a client's other
      // requests to this gateway share.
      const asked = request.headers['last-event-id'] ?? request.query.after;
      const fromNow = asked === undefined;
      let cursor = fromNow
        ? await latestEventId(options.store.db, profileId)
        : cursorSchema.parse(asked);

      if (streams >= (options.maxStreams ?? 100)) {
        throw new GatewayError(429, 'Too many event streams');
      }

      streams += 1;
      reply.hijack();

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        // no-transform keeps a compressing proxy, the web server's included, from holding
        // events back to fill a gzip block.
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      reply.raw.write(': connected\n\n');
      // The cursor a client that came with none resumes from, and its cue to read what it holds:
      // whatever happened before this point will not be told.
      if (fromNow) {
        reply.raw.write(`id: ${cursor}\nevent: ${STREAM_OPENED_EVENT}\ndata: {}\n\n`);
      }

      let closed = false;
      const wake = new AbortController();
      // When each working run last changed its progress, as this stream last told it.
      const told = new Map<string, string>();

      reply.raw.on('close', () => {
        closed = true;
        streams -= 1;
        wake.abort();
      });

      const pump = async () => {
        if (closed) {
          return;
        }

        let behind = false;

        try {
          // Close slow consumers instead of buffering an unbounded event history.
          if (reply.raw.writableLength > 256 * 1024) {
            reply.raw.end();

            return;
          }

          if (reply.raw.writableNeedDrain) {
            await new Promise((resolve) => setTimeout(resolve, 1000));

            return pump();
          }

          const events = await readEvents(options.store.db, profileId, cursor);

          for (const event of events) {
            if (closed) {
              return;
            }

            const ready = reply.raw.write(
              `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(toldOf(event))}\n\n`,
            );

            cursor = event.id;

            if (!ready) {
              break;
            }
          }

          // Progress changes many times a second and is not worth a row each time; a stream
          // hears of it here, without an id, so it never moves the cursor it resumes from.
          const working = await readProgress(options.store.db, profileId);

          for (const run of working) {
            if (told.get(run.runId) !== run.at) {
              told.set(run.runId, run.at);
              reply.raw.write(`event: run.progress\ndata: ${JSON.stringify(run)}\n\n`);
            }
          }

          for (const runId of told.keys()) {
            if (!working.some((run) => run.runId === runId)) told.delete(runId);
          }

          if (events.length === 0) {
            reply.raw.write(': heartbeat\n\n');
          }

          // A full page means more is waiting: a client catching up reads on at once, or it would
          // hear of new events only after a wake or a wait for every hundred old ones.
          behind = events.length === EVENTS_PAGE;
        } catch {
          reply.raw.end();

          return;
        }

        if (behind) {
          return pump();
        }

        await Promise.race([
          options.store.waitForEvent(profileId, wake.signal),
          new Promise((resolve) => setTimeout(resolve, 25_000)),
        ]);
        return pump();
      };

      void pump();
    },
  );
}
