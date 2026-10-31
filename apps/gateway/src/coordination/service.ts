import { randomUUID } from 'node:crypto';
import {
  artifactQuerySchema,
  type artifactSchema,
  leaseInputSchema,
  type leaseSchema,
  mailInputSchema,
  type mailSchema,
  type Profile,
  pageQuerySchema,
  type Run,
  type Session,
} from '@jian/contracts';
import { z } from 'zod';
import { type Clock, nowIso } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import { pageMessages } from '../sessions/repository.js';
import type { Queryable, Store } from '../storage/database.js';
import {
  acquireLease,
  expireLease,
  findArtifact,
  findHistoryCursor,
  findLease,
  insertArtifact,
  insertMail,
  listInbox,
} from './repository.js';

export type ArtifactRecord = z.infer<typeof artifactSchema>;

export type LeaseRecord = z.infer<typeof leaseSchema>;

export type MailRecord = z.infer<typeof mailSchema>;

const releaseSchema = leaseInputSchema
  .omit({ ttlSeconds: true })
  .extend({ fence: z.number().int().positive() });

/** Every read here happens inside the profile transaction coordination opened, never beside it. */
type CoordinationServices = {
  profiles: { profile(id: string, reader?: Queryable): Promise<Profile> };
  sessions: { session(profileId: string, sessionId: string, reader?: Queryable): Promise<Session> };
  runs: { run(profileId: string, runId: string, reader?: Queryable): Promise<Run> };
  store: Store;
};

export class Coordination {
  constructor(
    private readonly services: CoordinationServices,
    private readonly clock: Clock = Date.now,
  ) {}

  async history(profileId: string, sessionId: string | undefined, input: unknown) {
    const query = pageQuerySchema.parse(input);

    if (sessionId) {
      await this.services.sessions.session(profileId, sessionId);
    } else {
      await this.services.profiles.profile(profileId);
    }

    // A cursor is a record reference, so validate ownership before using it for pagination.
    if (query.before) {
      assertFound(
        await findHistoryCursor(this.services.store.db, profileId, sessionId, query.before),
        'History cursor',
      );
    }

    return pageMessages(this.services.store.db, {
      profileId,
      sessionId,
      before: query.before,
      query: query.q,
      limit: query.limit,
    });
  }

  async storeArtifact(run: Run, toolName: string, output: unknown) {
    const content = JSON.stringify(output) ?? 'null';
    const bytes = Buffer.byteLength(content);

    if (bytes > 64 * 1024 * 1024) {
      throw new GatewayError(
        413,
        'Tool result exceeds the 64 MiB artifact limit; paginate the source request',
      );
    }

    const record: ArtifactRecord = {
      id: randomUUID(),
      profileId: run.profileId,
      runId: run.id,
      toolName,
      content,
      bytes,
      createdAt: nowIso(this.clock),
    };

    await this.services.store.transaction(run.profileId, async (tx) => {
      await this.services.runs.run(run.profileId, run.id, tx);
      await insertArtifact(tx, record);
    });

    return { artifactId: record.id, bytes };
  }

  async artifact(profileId: string, id: string, input: unknown) {
    const { offset, limit } = artifactQuerySchema.parse(input);
    const record = assertFound(
      await findArtifact(this.services.store.db, profileId, id),
      'Artifact',
    );
    const end = Math.min(offset + limit, record.content.length);

    return {
      ...record,
      content: record.content.slice(offset, end),
      nextOffset: end < record.content.length ? end : null,
    };
  }

  async acquire(profileId: string, input: unknown) {
    const { ttlSeconds, ...data } = leaseInputSchema.parse(input);

    return this.services.store.transaction(profileId, async (tx) => {
      await this.services.sessions.session(profileId, data.sessionId, tx);

      const record = await acquireLease(
        tx,
        { ...data, profileId, expiresAt: this.clock() + ttlSeconds * 1000 },
        this.clock(),
      );

      // No row means the resource is live and held elsewhere: nothing was written.
      if (!record) {
        throw new GatewayError(409, 'Resource is held by another session');
      }

      await recordEvent(tx, this.clock, profileId, 'resource.acquired', record);

      return record;
    });
  }

  async release(profileId: string, input: unknown) {
    const data = releaseSchema.parse(input);

    return this.services.store.transaction(profileId, async (tx) => {
      const record = assertFound(await findLease(tx, profileId, data.resource), 'Resource lease');

      if (
        record.sessionId !== data.sessionId ||
        record.fence !== data.fence ||
        record.expiresAt <= this.clock()
      ) {
        throw new GatewayError(409, 'Resource lease is no longer valid');
      }

      const releasedAt = this.clock();

      await expireLease(tx, profileId, data.resource, releasedAt);

      return { ...record, expiresAt: releasedAt };
    });
  }

  async send(profileId: string, input: unknown) {
    const data = mailInputSchema.parse(input);

    return this.services.store.transaction(profileId, async (tx) => {
      await this.services.sessions.session(profileId, data.fromSessionId, tx);
      await this.services.sessions.session(profileId, data.toSessionId, tx);

      const stored = await insertMail(tx, {
        ...data,
        id: randomUUID(),
        profileId,
        createdAt: nowIso(this.clock),
      });

      if (!stored) {
        throw new GatewayError(409, 'Request key already used');
      }

      // A resend returns the message already stored, and announces nothing a second time.
      if (!stored.created) {
        return stored.record;
      }

      await recordEvent(tx, this.clock, profileId, 'session.mail', {
        id: stored.record.id,
        toSessionId: data.toSessionId,
        fromSessionId: data.fromSessionId,
      });

      return stored.record;
    });
  }

  async inbox(profileId: string, sessionId: string) {
    await this.services.sessions.session(profileId, sessionId);

    return listInbox(this.services.store.db, profileId, sessionId, 30);
  }
}
