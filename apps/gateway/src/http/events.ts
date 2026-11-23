import { STREAM_OPENED_EVENT } from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GatewayError } from '../core/errors.js';
import {
  EVENTS_PAGE,
  latestEventId,
  readEventHeads,
  readEvents,
  readProgressStamps,
  readRunsProgress,
} from '../core/event-feed.js';
import type { Devices } from '../devices/service.js';
import type { ProfileReader } from '../profiles/port.js';
import type { Store } from '../storage/database.js';

type ProfileParams = { profileId: string };

interface EventOptions {
  profiles: ProfileReader;
  store: Store;
  token: string;
  devices: Pick<Devices, 'authenticate'>;
  maxStreams?: number;
  /** How long a quiet stream waits before a heartbeat, in ms; tests shorten it. */
  heartbeatMs?: number;
  /** How long one stream lasts before it is ended for the client to open the next, in ms. */
  streamLifetimeMs?: number;
  /** How long a client may leave what it was sent unread before it is cut off, in ms. */
  drainMs?: number;
  /** How long an ended stream may take to finish sending before its socket drops, in ms. */
  lingerMs?: number;
}

const HEARTBEAT_MS = 25_000;
/**
 * How long one stream lasts, in ms. A client that went away without its close reaching here,
 * behind a proxy or across a network change, leaves a stream that heartbeats into nothing and
 * holds one of the streams allowed; ending each now and then lets go of those. A client opens
 * the next from the cursor it holds and misses nothing.
 */
const LIFETIME_MS = 30 * 60_000;
/** How long an ended stream may take to finish sending before its socket is dropped, in ms. */
const LINGER_MS = 10_000;
/**
 * How long a client may take to read what it was sent before the stream is ended, in ms. Nothing
 * more is written meanwhile, so a stalled client holds one write's worth of memory at most, and
 * it resumes from the last event it read.
 */
const DRAIN_MS = 30_000;
/**
 * The least time between two reads of the feed by one stream, in ms. Every run's progress wakes
 * every stream of the profile several times a second; what those wakes announced is read
 * together. Progress is written every 250 ms, so a screen loses no frame it would have drawn.
 */
const READ_GAP_MS = 100;

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

  app.get<{ Params: ProfileParams; Querystring: { after?: string; progress?: '1' } }>(
    '/v1/profiles/:profileId/events/stream',
    async (request, reply) => {
      const profileId = request.params.profileId;
      const withText = request.query.progress === '1';

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

      const raw = reply.raw;
      let closed = false;
      // Writing to a response that ended throws from the socket's next tick, and the pump may be
      // between two awaits when the stream's lifetime ends it.
      const over = () => closed || raw.writableEnded;
      let wroteAt = Date.now();
      const send = (text: string) => {
        if (over()) return false;
        wroteAt = Date.now();
        return raw.write(text);
      };
      const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
      // A phone was let in once, when the stream opened; a stream outlives any request, so its
      // token is checked again at least once a heartbeat, and a revoked phone hears no more.
      let checkedAt = Date.now();
      let beat = false;
      const wake = new AbortController();
      // When each working run last changed its progress, as this stream last told it.
      const told = new Map<string, string>();

      let linger: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        wake.abort();
        if (closed) return;
        if (!raw.writableEnded) raw.end();
        // A peer that is gone never takes the end, and the stream would stay counted.
        linger ??= setTimeout(() => raw.destroy(), options.lingerMs ?? LINGER_MS);
      };
      const lifetime = setTimeout(finish, options.streamLifetimeMs ?? LIFETIME_MS);

      raw.on('close', () => {
        closed = true;
        streams -= 1;
        clearTimeout(lifetime);
        clearTimeout(linger);
        wake.abort();
      });

      /** Whether the client took what it was sent in time, or the stream ended first. */
      const drained = () =>
        new Promise<boolean>((resolve) => {
          const done = (taken: boolean) => {
            clearTimeout(timer);
            raw.off('drain', onDrain);
            wake.signal.removeEventListener('abort', onEnd);
            resolve(taken);
          };
          const onDrain = () => done(true);
          const onEnd = () => done(false);
          const timer = setTimeout(onEnd, options.drainMs ?? DRAIN_MS);
          raw.once('drain', onDrain);
          wake.signal.addEventListener('abort', onEnd, { once: true });
        });

      /** Waits `ms`, or less when the stream ends. */
      const pause = (ms: number) =>
        new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            wake.signal.removeEventListener('abort', done);
            resolve();
          };
          const timer = setTimeout(done, ms);
          wake.signal.addEventListener('abort', done, { once: true });
        });

      const tellProgress = async () => {
        // Progress is a latest state, so what a slow client misses is simply told newer.
        const working = await readProgressStamps(options.store.db, profileId);
        const moved = working.filter((run) => told.get(run.runId) !== run.at);
        const frames: Array<(typeof working)[number] & { progress?: unknown }> =
          withText && moved.length
            ? await readRunsProgress(
                options.store.db,
                profileId,
                moved.map((run) => run.runId),
              )
            : moved;

        for (const { progress, ...run } of frames) {
          if (raw.writableNeedDrain) break;
          told.set(run.runId, run.at);
          const frame = progress && withText ? { ...run, progress } : run;
          send(`event: run.progress\ndata: ${JSON.stringify(frame)}\n\n`);
        }

        const still = new Set(working.map((run) => run.runId));
        for (const runId of told.keys()) {
          if (!still.has(runId)) told.delete(runId);
        }
      };

      const pump = async () => {
        let readAt = Number.NEGATIVE_INFINITY;

        while (!over()) {
          const waiting = new AbortController();
          const stopWaiting = () => waiting.abort();
          const stop = () => {
            waiting.abort();
            wake.signal.removeEventListener('abort', stopWaiting);
          };
          let notified: Promise<void> = Promise.resolve();
          let behind = false;

          try {
            // Nothing more is written to a client that has not read the last of it: an unread
            // history must wait in the database, behind the cursor, and not in this process.
            if (raw.writableNeedDrain && !(await drained())) {
              finish();
              return;
            }

            const timed = beat;
            beat = false;

            if (request.device && (timed || Date.now() - checkedAt >= heartbeatMs)) {
              checkedAt = Date.now();
              const still = await options.devices.authenticate(request.headers.authorization ?? '');
              if (still !== request.device) {
                finish();
                return;
              }
            }

            if (over()) return;

            // Subscribe before reading. A commit between the read and the wait is otherwise lost
            // until the heartbeat timeout, which looks like a remote client has stopped syncing.
            wake.signal.addEventListener('abort', stopWaiting, { once: true });
            notified = options.store.waitForEvent(profileId, waiting.signal);
            readAt = Date.now();

            const events = await readEventHeads(options.store.db, profileId, cursor);
            let sent = 0;

            for (const event of events) {
              if (over()) {
                stop();
                return;
              }

              const ready = send(
                `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              );

              // Only what was handed to the socket moves the cursor, one event at a time.
              cursor = event.id;
              sent += 1;

              if (!ready) break;
            }

            await tellProgress();

            // Only when nothing else went out for that long: a wake with nothing to tell is not
            // news, but a proxy must still see the stream is alive however often those come.
            if (events.length === 0 && (timed || Date.now() - wroteAt >= heartbeatMs)) {
              send(': heartbeat\n\n');
            }

            // More is waiting when a page was full or a full buffer stopped this one: a client
            // catching up reads on at once, or it would hear of the rest only after a wait.
            behind = sent < events.length || events.length === EVENTS_PAGE;
          } catch {
            stop();
            finish();
            return;
          }

          if (behind) {
            stop();
            continue;
          }

          let heartbeat: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              notified,
              new Promise<void>((resolve) => {
                heartbeat = setTimeout(() => {
                  beat = true;
                  resolve();
                }, heartbeatMs);
              }),
            ]);
          } finally {
            if (heartbeat) clearTimeout(heartbeat);
            stop();
          }

          const early = READ_GAP_MS - (Date.now() - readAt);
          if (early > 0 && !over()) await pause(early);
        }
      };

      void pump().catch(finish);
    },
  );
}
